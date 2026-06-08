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

export function summarizeRunCosts(rows: ToolCallRow[]): RunCostSummary {
  let ok = 0, failed = 0, cached = 0, successful = 0, avoided = 0;
  for (const r of rows) {
    const isCached = r.cached === true;
    const isOk = r.ok !== false; // default true (matches deriveOk)
    const listPrice = r.cost_micro_usd ?? 0;
    const charged = r.charged_micro_usd ?? (isOk && !isCached ? listPrice : 0);
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
