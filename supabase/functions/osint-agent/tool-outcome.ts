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
//
// 2026-07 prod audit added: `already ran for this entity` (premium dedup),
// `guard not met` (execution-guard skip), and `internal paid-call cap` /
// `internal throttle` — all were mis-stored as `failed`, so a dedup skip lit up
// the Tool-Health panel red ("premium 'oathnet_lookup' already ran for this
// entity this investigation" was the reported case).
const SKIP_RE =
  /execution plan required|duplicate call|burst limit|same-tool (?:cycle limit|budget)|paid-call (?:cycle limit|budget)|active-call concurrency|internal (?:concurrency|paid-call) cap|internal throttle|already has a call in-flight|already ran for this entity|high-cost tool already used|guard not met|weak lead blocked|expected value\s+\d+\s+below|disabled after \d+ consecutive|degraded this run|suppressed for investigation|selector blacklisted|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b|not configured|provider disabled in config|rate-limited\s*[—-]\s*provider|provider\b[^]*?\bsuppressed|5xx\s*[—-]\s*provider|finalize window open|run tool-call cap reached/i;

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

// ───────────────────────── CANONICAL DETAILED TAXONOMY ─────────────────────────
// The coarse `ToolOutcome` above stays 4-valued for the circuit breaker + billing
// (a timeout/abort/451/bad-key is still coarse `failed` so suppression keeps
// working). But that collapses distinctions the ANALYST needs — a timed-out heavy
// call is not a provider outage. `classifyDetailedOutcome` is the shared canonical
// taxonomy (mirrored byte-for-byte in the frontend `src/lib/tool-outcome.ts`,
// pinned by a parity test) used for honest health/report/telemetry surfaces.
//
// Categories: success | empty (EXPECTED PROVIDER RESPONSE) | skipped | cancelled |
// timeout | rate_limited | http_denied | blocked | config_error | failed | unknown.

export type DetailedOutcome =
  | "success"
  | "empty"
  | "skipped"
  | "cancelled"
  | "timeout"
  | "rate_limited"
  | "http_denied"
  | "blocked"
  | "config_error"
  | "failed"
  | "unknown";

const CANCEL_RE = /\babort(?:ed|error)?\b|signal (?:has been|was) aborted|\bcancell?ed\b/i;
const TIMEOUT_RE = /\btimed?\s?out\b|exceeded\s+\d+\s?ms|_timeout\b|\btimeout\b/i;
const RATELIMIT_RE = /\brate[\s-]?limit/i;
const CONFIG_RE = /invalid (?:or unauthorized )?(?:api )?key|unauthorized key|api[\s-]?key|missing[\s_-]?key|not configured|no api key|payment required|insufficient (?:credit|balance)|quota exceeded/i;
const DENIED_RE = /\bforbidden\b|access denied/i;

/**
 * Refine (errorMsg, statusCode) into ONE canonical category. Governance always
 * wins (rescuing mis-stored rows); then empty; then cancelled-vs-timeout; then
 * rate-limit / blocked / config / denied / failed / unknown. See the frontend
 * mirror for the full precedence rationale.
 */
export function classifyDetailedOutcome(
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
): DetailedOutcome {
  const coarse = classifyToolOutcome(errorMsg, statusCode);
  if (coarse === "ok") return "success";
  if (coarse === "empty") return "empty";
  if (coarse === "skipped") return "skipped";

  // coarse === "failed": refine.
  const msg = String(errorMsg ?? "").trim();
  const code = typeof statusCode === "number" ? statusCode : null;
  if (msg && CANCEL_RE.test(msg) && !TIMEOUT_RE.test(msg)) return "cancelled";
  if (msg && TIMEOUT_RE.test(msg)) return "timeout";
  if (code === 429 || (msg && RATELIMIT_RE.test(msg))) return "rate_limited";
  if (code === 451) return "blocked";
  if (code === 401 || code === 402 || (msg && CONFIG_RE.test(msg))) return "config_error";
  if (code === 403 || (msg && DENIED_RE.test(msg))) return "http_denied";
  if (code != null && (code >= 500 || code === 400 || code === 422)) return "failed";
  if (msg && /\bHTTP\s*5\d\d\b|upstream returned/i.test(msg)) return "failed";
  if (!msg && code == null) return "unknown";
  return "failed";
}

/** True only for genuine problems worth an operator's/analyst's attention. */
export function detailedNeedsAttention(cat: DetailedOutcome): boolean {
  return cat === "config_error" || cat === "failed" || cat === "unknown";
}

/**
 * Turn a raw provider error into a meaningful analyst-facing message (Issue #2).
 * Never dump a bare HTTP code. Mirror of the frontend `normalizeProviderError`.
 */
export function normalizeProviderError(
  toolName: string,
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
  category?: DetailedOutcome,
): string {
  const cat = category ?? classifyDetailedOutcome(errorMsg, statusCode);
  const code = typeof statusCode === "number" ? statusCode : null;
  const raw = String(errorMsg ?? "").trim();
  const short = raw.length > 140 ? `${raw.slice(0, 139)}…` : raw;
  switch (cat) {
    case "timeout":
      return `Timed out before responding — ${toolName} is a heavy call that exceeded its time budget. The run continued; this is not a provider fault.`;
    case "cancelled":
      return `Cancelled — the investigation's overall time budget ended before ${toolName} returned. Not a provider fault.`;
    case "rate_limited":
      return `Rate-limited by the provider${code ? ` (HTTP ${code})` : ""} — the platform backed off automatically. Retry later.`;
    case "http_denied":
      return `Access denied (HTTP ${code ?? 403}) — the provider blocked this request, usually bot protection or IP reputation, not a bad key.`;
    case "blocked":
      return `Legally unavailable (HTTP ${code ?? 451}) — the provider blocked this content for legal reasons.`;
    case "config_error":
      if (/key/i.test(raw)) return `Provider credentials rejected — the API key is invalid or unauthorized. Check the key in Supabase function secrets.`;
      if (code === 402 || /payment|quota|credit|balance/i.test(raw)) return `Provider quota/billing limit reached${code ? ` (HTTP ${code})` : ""} — top up or wait for the quota to reset.`;
      return `Provider authentication failed (HTTP ${code ?? 401}) — the API key is missing or unauthorized.`;
    case "failed":
      if (code != null && code >= 500) return `Provider server error (HTTP ${code}) — an upstream outage on the provider's side. Retry later.`;
      if (code === 400 || code === 422) return `Provider rejected the request (HTTP ${code}) — likely an unsupported selector type or malformed input for this tool, not an outage.`;
      return short || `${toolName} failed with a provider error.`;
    case "unknown":
      return `${toolName} failed without reporting an error message or status code — check the edge function logs for this call.`;
    case "empty":
      return `No record found — ${toolName} ran successfully but the target has no data.`;
    case "skipped":
      return short || `Skipped by orchestration policy — not run this cycle.`;
    default:
      return short || `${toolName} completed.`;
  }
}
