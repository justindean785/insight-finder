import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  classifyDetailedOutcome,
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
}

export interface ToolHealthRow {
  toolName: string;
  counts: Record<CanonicalOutcome, number>;
  total: number;
  /** Most severe category present on this tool (for the row tone). */
  worst: CanonicalOutcome;
  /** True only for genuine problems (config/failed/unknown). */
  needsAttention: boolean;
  /** Most recent needs-attention issue, with a normalized human message. */
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

function worstOf(counts: Record<CanonicalOutcome, number>): CanonicalOutcome {
  for (const cat of SEVERITY) if (counts[cat] > 0) return cat;
  return "success";
}

export function aggregateToolHealth(raw: RawRow[]): Omit<ThreadToolHealth, "loading" | "error"> {
  const byTool = new Map<string, ToolHealthRow>();
  const totals = { ...emptyCounts(), total: 0 };

  // created_at ascending so the last needs-attention row we see is the most recent.
  const sorted = [...raw].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

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
  for (const row of rows) row.worst = worstOf(row.counts);

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
