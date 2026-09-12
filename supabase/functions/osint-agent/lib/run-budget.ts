/**
 * run-budget.ts — what an INVESTIGATION has actually spent, across invocations.
 *
 * PURE (no I/O). The caller supplies the rows; this module only classifies them.
 *
 * WHY THIS EXISTS. `runtime-policy.ts` documents its counters as per-run backstops:
 *
 *   "These reset ONLY when the thread is cleared (clearRuntime → a brand-new
 *    investigation). beginCycle must NEVER refresh them ... Counters are
 *    therefore lifetime-of-run."
 *
 * They are not. `index.ts` calls `clearRuntime(threadId)` unconditionally at the
 * top of EVERY request, and `clearRuntime` is `THREADS.delete(threadId)` — so
 * `paidCalls`, `totalCalls` and `toolCounts` are zeroed on every invocation, not
 * on every new investigation. An investigation is 2-12 invocations, so
 * `MAX_PAID_CALLS = 12` is really 24-144 paid calls per case. Production bears
 * this out: 130 calls over 12 invocations, 112 over 9, 102 over 6 — all close to
 * the per-invocation cap, none close to it per case.
 *
 * ⚠️ THIS MODULE DELIBERATELY DOES NOT ENFORCE ANYTHING YET. Turning a per-isolate
 * cap into a per-investigation one is a real product change: it would mean a case's
 * fifth analyst turn can find the budget already spent. Picking the number from an
 * estimate is the same mistake as reading four failures in a 14-day window and
 * calling a healthy provider dead. So this measures first — the cap is set from the
 * resulting distribution, not from a guess.
 */

/** One `tool_usage_log` row, as loosely typed as it arrives from PostgREST. */
export interface PriorCallRow {
  tool_name?: unknown;
  cached?: unknown;
  outcome?: unknown;
  cost_micro_usd?: unknown;
}

export interface PriorSpend {
  /** Non-cached, non-skipped calls — what actually reached a provider. */
  total_calls: number;
  /** Of those, the ones that would consume a MAX_PAID_CALLS slot today. */
  paid_calls: number;
  /** Replays. They never reach `startCall`, so they never consumed a slot. */
  cached_calls: number;
  /** Governance skips (budget, burst, dedup, suppression). No slot consumed. */
  skipped_calls: number;
  /** Attributed list price already recorded on the rows, in micro-USD. */
  cost_micro_usd: number;
  /** Rows the caller handed us, before classification. */
  rows_read: number;
}

export const EMPTY_PRIOR_SPEND: PriorSpend = {
  total_calls: 0,
  paid_calls: 0,
  cached_calls: 0,
  skipped_calls: 0,
  cost_micro_usd: 0,
  rows_read: 0,
};

function asBool(v: unknown): boolean {
  return v === true;
}

function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Classify prior calls for one thread.
 *
 * `isPaidAdmission` must be the SAME predicate the admission gate uses
 * (`paidBudgetTier(costForTool(name), name) !== "free"`), passed in rather than
 * imported so this module stays pure and so the two can never quietly diverge
 * into two different definitions of "paid".
 *
 * Known imprecision, stated rather than hidden: a paid call that reserved a slot
 * and was then refunded by `refundPaidCall` (a pre-provider gate) is counted here
 * only if it was not logged as a governance skip. That biases `paid_calls` very
 * slightly HIGH, which is the safe direction for a measurement that will later
 * inform a cap.
 */
export function summarizePriorSpend(
  rows: readonly PriorCallRow[] | null | undefined,
  isPaidAdmission: (toolName: string) => boolean,
): PriorSpend {
  if (!Array.isArray(rows) || rows.length === 0) return { ...EMPTY_PRIOR_SPEND };
  const out: PriorSpend = { ...EMPTY_PRIOR_SPEND, rows_read: rows.length };
  for (const row of rows) {
    const name = typeof row?.tool_name === "string" ? row.tool_name : "";
    out.cost_micro_usd += asNumber(row?.cost_micro_usd);
    if (asBool(row?.cached)) {
      out.cached_calls += 1;
      continue;
    }
    if (row?.outcome === "skipped") {
      out.skipped_calls += 1;
      continue;
    }
    out.total_calls += 1;
    if (name && isPaidAdmission(name)) out.paid_calls += 1;
  }
  return out;
}

/**
 * The structured log line. A log event rather than a column because the live
 * database is Lovable-owned and `supabase/migrations/` is not the mechanism that
 * changes it — a new column is separate, gated work.
 */
export function priorSpendEvent(
  threadId: string,
  spend: PriorSpend,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event: "run_budget_prior",
    thread_id: threadId,
    ...spend,
    ...extra,
  });
}
