import {
  classifyDetailedOutcome,
  normalizeProviderError,
  CANONICAL_OUTCOME_META,
  type CanonicalOutcome,
} from "@/lib/tool-outcome";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

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

/** One classified call — the unit both entry points below aggregate. */
interface HealthEntry {
  toolName: string;
  category: CanonicalOutcome;
  errorMsg: string | null;
  statusCode: number | null;
  at: string;
}

function aggregate(entries: HealthEntry[]): Omit<ThreadToolHealth, "loading" | "error"> {
  const byTool = new Map<string, ToolHealthRow>();
  const totals = { ...emptyCounts(), total: 0 };

  // created_at ascending so the last needs-attention row we see is the most recent.
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));

  for (const e of sorted) {
    const name = e.toolName.trim() || "unknown";
    const category = e.category;

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
        message: normalizeProviderError(name, e.errorMsg, e.statusCode, category),
        statusCode: e.statusCode,
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

/** Aggregate raw `tool_usage_log` rows (classifies each one canonically). */
export function aggregateToolHealth(raw: RawRow[]): Omit<ThreadToolHealth, "loading" | "error"> {
  return aggregate(raw.map((r) => ({
    toolName: r.tool_name ?? "",
    // Legacy rows (null outcome) fall back to the ok boolean before refining.
    category: classifyDetailedOutcome(r.outcome ?? (r.ok === false ? "failed" : "ok"), r.error_msg, r.status_code),
    errorMsg: r.error_msg,
    statusCode: r.status_code ?? null,
    at: r.created_at ?? "",
  })));
}

/**
 * Health from the case's SHARED tool store — the same events the Activity view,
 * the case bar and the Tools badge read, each already carrying its canonical
 * category.
 *
 * Health used to run its own SELECT plus a realtime subscription on
 * `tool_usage_log`, a table that is not in the realtime publication: it loaded
 * once and then froze while a live run kept adding calls — the same drift that
 * put 46 in the header beside 48 in the Tools panel. It now has no read of its own.
 */
export function toolHealthFromEvents(events: ToolEvent[]): Omit<ThreadToolHealth, "loading" | "error"> {
  return aggregate(events.map((e) => ({
    toolName: e.toolName,
    category: e.category,
    errorMsg: e.errorMsg,
    statusCode: e.statusCode,
    at: e.at,
  })));
}
