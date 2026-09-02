/**
 * runCost.ts — pure run-cost summary for the investigation tool-trace export.
 *
 * Separates what was actually charged from the cost we AVOIDED by not billing
 * failed/timed-out calls. Current `tool_usage_log` rows store the actual bill
 * in `charged_micro_usd` and the attributed/list price in `cost_micro_usd`.
 * Older rows may not have `charged_micro_usd`, so summaries fall back to
 * reconstructing the charged value from ok/cached/list-price.
 */

export interface ToolCallRow {
  ok?: boolean | null;
  cached?: boolean | null;
  cost_micro_usd?: number | null;
  charged_micro_usd?: number | null;
}

export interface RunCostSummary {
  calls: number;
  ok: number;
  failed: number;
  cached: number;
  /** credits actually charged this run */
  successful_cost_micro_usd: number;
  /** list price of failed, non-cached calls we did NOT bill */
  avoided_failed_cost_micro_usd: number;
  /** canonical charged total — alias of successful_cost_micro_usd */
  cost_micro_usd: number;
}

/**
 * What a single call actually cost, in micro-USD.
 *
 * ⚠️ THE FALLBACK IS THE POINT. A null `charged_micro_usd` means "this row
 * predates charge accounting", NOT "this call was free" — reading it as zero
 * under-reports spend on any older case and, worse, files a paid call under the
 * free/cached column. Rows written before the column existed are reconstructed
 * from ok/cached/list-price, which is the rule this project has used since the
 * column was added.
 *
 * Extracted so there is exactly ONE implementation: the Tools tab's per-provider
 * spend breakdown had grown its own `?? 0`, which is the same bug re-introduced
 * on a new surface. (Codex review, PR #462.)
 */
export function chargedMicroUsd(r: ToolCallRow): number {
  const isCached = r.cached === true;
  const isOk = r.ok !== false; // default true (matches deriveOk)
  if (isCached) return 0;      // cache hits are free
  return r.charged_micro_usd ?? (isOk ? (r.cost_micro_usd ?? 0) : 0);
}

export function summarizeRunCosts(rows: ToolCallRow[]): RunCostSummary {
  let ok = 0, failed = 0, cached = 0, successful = 0, avoided = 0;
  for (const r of rows) {
    const isCached = r.cached === true;
    const isOk = r.ok !== false; // default true (matches deriveOk)
    const listPrice = r.cost_micro_usd ?? 0;
    const charged = chargedMicroUsd(r);
    if (isCached) cached++;
    if (isOk) ok++; else failed++;
    if (isCached) continue;       // cache hits are free
    successful += charged;
    if (!isOk) avoided += listPrice;
  }
  return {
    calls: rows.length,
    ok,
    failed,
    cached,
    successful_cost_micro_usd: successful,
    avoided_failed_cost_micro_usd: avoided,
    cost_micro_usd: successful,
  };
}
