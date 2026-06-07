/**
 * billing.ts — pure credit-charging policy for tool calls.
 *
 * Rule (approved 2026-06-07): charge credits ONLY for successful tool calls.
 * Cache hits, free stubs (gated/unconfigured/disabled), and any failure
 * (HTTP 4xx/5xx wrapped into { ok:false }, timeouts, duplicate-key errors)
 * must consume 0 credits. Pricing amounts and successful-call metering are
 * unchanged — this only stops charging for failed / no-result calls.
 *
 * Runtime-agnostic (no Deno/npm imports) so it is unit-testable under Vitest
 * and importable by the cache wrapper.
 */

export interface ChargeInput {
  /** did the call return a usable result? (cache wrapper's deriveOk) */
  ok: boolean;
  /** served from cache — never re-billed */
  cached: boolean;
  /** free stub: gated/unconfigured/disabled provider — never consumed quota */
  free: boolean;
  /** the tool's list price in micro-USD (from costs.ts) */
  baseCost: number;
}

/** Credits actually charged for a call. 0 unless it was a successful paid call. */
export function creditsCharged({ ok, cached, free, baseCost }: ChargeInput): number {
  if (cached || free) return 0; // never billed
  if (!ok) return 0;            // failed / timeout / dup-key / no usable result
  return baseCost;             // successful paid call → normal price (unchanged)
}
