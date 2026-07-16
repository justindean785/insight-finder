/**
 * tool-outcome.ts — honest tool-call outcome classification.
 *
 * The `tool_usage_log` "failure rate" was inflated because the wrapper logged
 * orchestrator GOVERNANCE decisions (budget/burst/concurrency caps, dedup,
 * provider suppression, gating, missing-key/disabled stubs) and NEGATIVE results
 * (target simply has no record) all as `ok=false` — i.e. as if the tool broke.
 *
 * `classifyToolOutcome` maps an (error_msg, status_code) pair to one of four
 * buckets so telemetry and the circuit breaker can tell a real provider failure
 * apart from an intentional skip or an empty-but-successful lookup:
 *   • ok      — genuine success
 *   • skipped — governance / gating / suppression: the tool was intentionally
 *               not run (or its result discarded by policy). NOT a failure.
 *   • empty   — the tool ran fine but the target has no record (404 / no result).
 *               NOT a failure.
 *   • failed  — a real error: upstream 5xx, genuine provider 4xx (400/401/403/429),
 *               timeout, or abort.
 *
 * Pure + deterministic (string/number in, enum out) so it is fully unit-tested
 * and safe to share between cache.ts (the logged outcome) and circuit.ts (the
 * suppression counter — which must increment ONLY on `failed`).
 */

export type ToolOutcome = "ok" | "skipped" | "empty" | "failed";

// Governance / gating / suppression phrases the runtime emits on purpose.
// Matching any of these means the tool did not really run (or its result was
// intentionally discarded) — it must never count as a provider failure.
const SKIP_RE =
  /execution plan required|duplicate call|burst limit|same-tool (?:cycle limit|budget)|paid-call (?:cycle limit|budget)|active-call concurrency|internal concurrency cap|already has a call in-flight|high-cost tool already used|weak lead blocked|expected value\s+\d+\s+below|disabled after \d+ consecutive|degraded this run|suppressed for investigation|selector blacklisted|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b|not configured|provider disabled in config|rate-limited\s*[—-]\s*provider|provider\b[^]*?\bsuppressed|5xx\s*[—-]\s*provider/i;

// Tool ran, but the target has no record. A successful negative, not a failure.
const EMPTY_RE = /no usable result|skipped\s*[—-]\s*no usable result|not found\b/i;

export function classifyToolOutcome(
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
): ToolOutcome {
  // Coerce defensively: some tools (e.g. serus_darkweb_scan) pass a non-string
  // error payload (an object) despite the string type, which made `.trim()`
  // throw `(errorMsg ?? "").trim is not a function` and crash classification.
  const msg = String(errorMsg ?? "").trim();
  // No error and no status → the call succeeded.
  if (!msg && (statusCode == null)) return "ok";

  // Governance / gating / suppression always wins — even when a status code is
  // present (e.g. "429 rate-limited — provider X suppressed for investigation").
  if (msg && SKIP_RE.test(msg)) return "skipped";

  // Negative result: explicit "no usable result" text, or a bare 404 (the
  // lookup worked, the record just isn't there — gravatar/hibp/github style).
  if (msg && EMPTY_RE.test(msg)) return "empty";
  if (statusCode === 404) return "empty";

  // Everything else with an error/status is a genuine failure (5xx, real
  // 400/401/403/429, 451 legal block, timeout, abort, parse error, …).
  return "failed";
}
