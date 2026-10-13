import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  classifyDetailedOutcome,
  explainLeakCheckRefusal,
  normalizeProviderError,
  CANONICAL_OUTCOME_META,
  type CanonicalOutcome,
} from "@/lib/tool-outcome";

/**
 * Tool health for a thread, read from the AUTHORITATIVE `tool_usage_log` record
 * and REFINED through the canonical outcome taxonomy (`src/lib/tool-outcome.ts`).
 *
 * The stored `outcome` column is coarse (ok/skipped/empty/failed) and — worse —
 * historically binned TIMEOUTS, RATE-LIMITS, 403/451, and even governance skips
 * (`already ran for this entity`, `guard not met`) all into `failed`. Reading it
 * literally is what made the panel "lie": a timed-out heavy call looked identical
 * to a real provider outage. Here we re-derive the CANONICAL category from the
 * stored `error_msg` + `status_code` so each call is bucketed honestly, and only
 * genuine problems (`config_error`/`failed`/`unknown`) count as "needs attention".
 */
export type { CanonicalOutcome } from "@/lib/tool-outcome";

/** Severity order, worst first — drives the row's headline category + sorting. */
const SEVERITY: CanonicalOutcome[] = [
  "failed", "config_error", "unknown",
  "timeout", "rate_limited", "http_denied", "blocked",
  "cancelled", "skipped", "empty", "success",
];

/** Attempts that carry no answer from the provider: they never reached it (governance / circuit-breaker skips, outer
 *  budget cancellations), got no reply (timeouts) or say nothing (opaque errors). They do not make an earlier
 *  refusal stale. */
const NOT_A_PROVIDER_ANSWER = new Set<CanonicalOutcome>(["skipped", "cancelled", "timeout", "unknown"]);

/** Says the explanation that follows describes the latest refusal, not every attempt counted before it. */
const LAST_REFUSAL_LEAD = "Most recent LeakCheck refusal:";

function emptyCounts(): Record<CanonicalOutcome, number> {
  return {
    success: 0, empty: 0, skipped: 0, cancelled: 0, timeout: 0,
    rate_limited: 0, http_denied: 0, blocked: 0, config_error: 0, failed: 0, unknown: 0,
  };
}

export interface ToolIssue {
  category: CanonicalOutcome;
  message: string;
  statusCode: number | null;
  /** True for an explanation on a row that does NOT need attention (a LeakCheck 403 on the calm http_denied
   *  category): shown as information, not styled as a fault. Absent on every needs-attention issue. */
  informational?: boolean;
}

export interface ToolHealthRow {
  toolName: string;
  counts: Record<CanonicalOutcome, number>;
  total: number;
  /** Most severe category present on this tool (for the row tone). */
  worst: CanonicalOutcome;
  /** True only for genuine problems (config/failed/unknown). */
  needsAttention: boolean;
  /** Most recent needs-attention issue, with a normalized human message — or, for a LeakCheck 403 on a calm row,
   *  an `informational` explanation. Null when there is nothing to say. */
  lastIssue: ToolIssue | null;
}

export interface ThreadToolHealth {
  rows: ToolHealthRow[];
  totals: Record<CanonicalOutcome, number> & { total: number };
  /** Tools with a genuine problem (config/failed/unknown), worst-first. */
  attention: ToolHealthRow[];
  loading: boolean;
  error: string | null;
}

interface RawRow {
  tool_name: string | null;
  outcome: string | null;
  ok: boolean | null;
  error_msg: string | null;
  status_code: number | null;
  created_at: string | null;
}

/** Attempts on one case with zero data back before a tool is flagged regardless of category. */
export const REPEAT_FAILURE_FLOOR = 3;

function worstOf(counts: Record<CanonicalOutcome, number>): CanonicalOutcome {
  for (const cat of SEVERITY) if (counts[cat] > 0) return cat;
  return "success";
}

export function aggregateToolHealth(raw: RawRow[]): Omit<ThreadToolHealth, "loading" | "error"> {
  const byTool = new Map<string, ToolHealthRow>();
  const totals = { ...emptyCounts(), total: 0 };

  // created_at ascending so the last needs-attention row we see is the most recent.
  const sorted = [...raw].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  // LeakCheck's documented 403 reading, per tool, while the tool's last ANSWER FROM THE PROVIDER was such a refusal.
  // http_denied is the calm bucket — it never needs attention on its own — so no message was ever built for it and the
  // Health tab showed only a "Denied" chip. Only a documented LeakCheck 403 gets an explanation; every other tool and
  // status is untouched. After a 401/403 the circuit breaker suppresses the provider for the run, so what follows is
  // SKIPPED rows that never reached it: skips, cancellations, timeouts and opaque errors are not answers and leave
  // the explanation standing; a success, an empty result or any different provider answer makes it stale.
  const lastRefusal = new Map<string, string>();
  const refusalRows = new Map<string, number>();

  for (const r of sorted) {
    const name = r.tool_name?.trim() || "unknown";
    // Legacy rows (null outcome) fall back to the ok boolean before refining.
    const coarse = r.outcome ?? (r.ok === false ? "failed" : "ok");
    const category = classifyDetailedOutcome(coarse, r.error_msg, r.status_code);

    let row = byTool.get(name);
    if (!row) {
      row = { toolName: name, counts: emptyCounts(), total: 0, worst: "success", needsAttention: false, lastIssue: null };
      byTool.set(name, row);
    }
    row.counts[category] += 1;
    row.total += 1;
    totals[category] += 1;
    totals.total += 1;

    const refusal = category === "http_denied" ? explainLeakCheckRefusal(name, r.error_msg, r.status_code) : null;
    if (refusal) {
      lastRefusal.set(name, refusal);
      refusalRows.set(name, (refusalRows.get(name) ?? 0) + 1);
    } else if (!NOT_A_PROVIDER_ANSWER.has(category)) {
      lastRefusal.delete(name);
    }

    if (CANONICAL_OUTCOME_META[category].needsAttention) {
      row.needsAttention = true;
      row.lastIssue = {
        category,
        message: normalizeProviderError(name, r.error_msg, r.status_code, category),
        statusCode: r.status_code ?? null,
      };
    }
  }

  const rows = [...byTool.values()];
  for (const row of rows) {
    row.worst = worstOf(row.counts);
    // A category nobody flags (timeout, cancelled, denied…) becomes attention-
    // worthy by REPETITION: a tool that was tried REPEAT_FAILURE_FLOOR+ times on
    // this case and never once returned data is a dead source for this case,
    // whatever each attempt was labelled. Production 2026-09-20: seven
    // socialfetch_web_read aborts on one YouTube channel read as "Cancelled ×3 ·
    // Needs attention 0" while the model retried it across three runs.
    const refusal = lastRefusal.get(row.toolName) ?? null; // LeakCheck 403 only; null for every other tool
    if (!row.needsAttention && row.total >= REPEAT_FAILURE_FLOOR && row.counts.success === 0 && row.counts.empty === 0) {
      row.needsAttention = true;
      if (!row.lastIssue) {
        // The count sentence is about ALL attempts (skips included); the explanation is about the most recent REFUSAL.
        row.lastIssue = {
          category: row.worst,
          message: `${row.total} attempts on this case, none returned data — stop calling it here.${refusal ? ` ${LAST_REFUSAL_LEAD} ${refusal}` : ""}`,
          statusCode: null,
        };
      }
    } else if (refusal && !row.lastIssue) {
      // One or two attempts: the category stays http_denied and the row stays calm (no attention), but the analyst is
      // told what the refusal means. Never replaces a real needs-attention issue already on the row.
      const onlyRefusals = row.total === (refusalRows.get(row.toolName) ?? 0);
      row.lastIssue = {
        category: "http_denied",
        message: onlyRefusals ? refusal : `${LAST_REFUSAL_LEAD} ${refusal}`,
        statusCode: null,
        informational: true,
      };
    }
  }

  const sevRank = (c: CanonicalOutcome) => SEVERITY.indexOf(c);
  rows.sort(
    (a, b) =>
      Number(b.needsAttention) - Number(a.needsAttention) ||
      sevRank(a.worst) - sevRank(b.worst) ||
      b.total - a.total ||
      a.toolName.localeCompare(b.toolName),
  );
  const attention = rows.filter((r) => r.needsAttention);
  return { rows, totals, attention };
}

export function useThreadToolHealth(threadId: string): ThreadToolHealth {
  const [state, setState] = useState<ThreadToolHealth>({
    rows: [], totals: { ...emptyCounts(), total: 0 },
    attention: [], loading: true, error: null,
  });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const load = async () => {
      const { data, error } = await supabase
        .from("tool_usage_log")
        .select("tool_name,outcome,ok,error_msg,status_code,created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (!alive) return;
      if (error) {
        setState((s) => ({ ...s, loading: false, error: error.message }));
        return;
      }
      // Supabase generated types lag the live schema (the `outcome` column was
      // added by migration but types.ts isn't regenerated yet), so the typed
      // select widens to SelectQueryError. Runtime data is correct — cast via
      // unknown until types.ts is regenerated.
      setState({ ...aggregateToolHealth((data ?? []) as unknown as RawRow[]), loading: false, error: null });
    };
    load();
    const ch = supabase
      .channel(`tool-health-${threadId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "tool_usage_log", filter: `thread_id=eq.${threadId}` },
        load)
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(ch); };
  }, [threadId]);

  return state;
}
