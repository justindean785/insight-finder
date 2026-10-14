/**
 * leakcheck-guard.ts — keeps one investigation from draining the LeakCheck quota.
 *
 * LeakCheck's Pro API v2 meters a fixed pool of QUERIES on the account (operator
 * measured 200 in total; the provider's own docs only say `quota` is "the number of
 * queries remaining on your account"). It is NOT a per-day allowance, and the tool
 * description used to tell the model it was ("200 calls/day"), which invites spending.
 *
 * `circuit.ts` already runs `leakcheck_lookup` at most once per normalized entity per
 * investigation, but nothing bounds how many DIFFERENT entities a single scan can look
 * up, and nothing reacts to the `quota` every successful response reports. Two guards:
 *
 *  1. a per-investigation ceiling on quota-spending calls, and
 *  2. a low-water reserve: once the last `quota` the provider reported is at or under
 *     the reserve, stop calling until the operator tops up.
 *
 * Both fail OPEN. An unreadable call count or an unknown quota never blocks a lookup:
 * a monitoring fault must not remove a working breach source.
 *
 * Zero imports on purpose: pure, testable without Deno.env or a database.
 */

/** Quota-spending LeakCheck calls one investigation may make. Env: LEAKCHECK_MAX_PER_INVESTIGATION. */
export const LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION = 3;
/** Stop when the provider reports this many queries (or fewer) left. Env: LEAKCHECK_QUOTA_RESERVE. */
export const LEAKCHECK_DEFAULT_QUOTA_RESERVE = 20;

export interface LeakcheckLimits {
  maxPerInvestigation: number;
  quotaReserve: number;
}

const positiveInt = (raw: string | null | undefined, fallback: number, allowZero = false): number => {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
};

/** Resolve the limits from env-style strings. A malformed value falls back to the default. */
export function resolveLeakcheckLimits(
  maxRaw?: string | null,
  reserveRaw?: string | null,
): LeakcheckLimits {
  return {
    maxPerInvestigation: positiveInt(maxRaw, LEAKCHECK_DEFAULT_MAX_PER_INVESTIGATION),
    // A reserve of 0 is a legitimate operator choice ("spend it all").
    quotaReserve: positiveInt(reserveRaw, LEAKCHECK_DEFAULT_QUOTA_RESERVE, true),
  };
}

export type LeakcheckGuardDecision =
  | { allow: true }
  | { allow: false; code: "investigation_cap" | "quota_reserve"; reason: string };

/**
 * @param priorCalls quota-spending LeakCheck calls already made in this investigation,
 *   or null when that count could not be read (fail open).
 * @param lastQuota the most recent `quota` LeakCheck reported, or null when unknown.
 */
export function leakcheckGuard(
  priorCalls: number | null,
  lastQuota: number | null,
  limits: LeakcheckLimits,
): LeakcheckGuardDecision {
  if (lastQuota != null && Number.isFinite(lastQuota) && lastQuota <= limits.quotaReserve) {
    return {
      allow: false,
      code: "quota_reserve",
      reason:
        `LeakCheck quota is down to ${lastQuota} queries (reserve ${limits.quotaReserve}); ` +
        `skipped to protect the remaining pool. The operator must top up or lower LEAKCHECK_QUOTA_RESERVE.`,
    };
  }
  if (priorCalls != null && priorCalls >= limits.maxPerInvestigation) {
    return {
      allow: false,
      code: "investigation_cap",
      reason:
        `LeakCheck already ran ${priorCalls} time(s) in this investigation (limit ${limits.maxPerInvestigation}); ` +
        `the account has a fixed pool of queries, so use breach_check / oathnet_lookup for further breach lookups.`,
    };
  }
  return { allow: true };
}

/** Read `quota` off a LeakCheck response body; null when absent or not a finite non-negative number. */
export function readLeakcheckQuota(body: unknown): number | null {
  const q = (body as { quota?: unknown } | null | undefined)?.quota;
  return typeof q === "number" && Number.isFinite(q) && q >= 0 ? q : null;
}
