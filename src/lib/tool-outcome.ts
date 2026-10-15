/**
 * tool-outcome.ts — THE canonical tool-call outcome taxonomy (frontend).
 *
 * Historically the app had FOUR divergent notions of "what did this tool do":
 *   • the edge classifier (osint-agent/tool-outcome.ts): ok | skipped | empty | failed
 *   • deriveToolStatus (tool-run.ts): succeeded | failed | skipped | gated | degraded
 *   • classifyActivityRow (useThreadToolActivity): succeeded | gated | degraded | skipped | failed
 *   • the Tool-Health panel: painted EVERY stored `failed` row red as "needs attention"
 *
 * `classifyActivityRow` and the Health panel now BOTH run `classifyDetailedOutcome`
 * and BOTH bucket the result with `outcomeGroup` below, so the Activity tiles and
 * the Health tiles are the same five numbers for the same rows. (Until 2026-10
 * Activity kept its own regexes, counted `empty` as succeeded and never fetched
 * `status_code`: one 125-call case read Succeeded 100 / Failed 6 in Activity and
 * Succeeded 84 / No record 16 / Faulted 7 in Health.) `deriveToolStatus`
 * (tool-run.ts) still classifies AI-SDK message parts on its own — it sees a
 * part's output object, not a log row.
 *
 * The result was the "tool health is lying" bug: a tool that TIMED OUT, was
 * RATE-LIMITED, hit a 403/451, or was skipped by governance (`already ran for
 * this entity`, `guard not met`) all showed up in the same alarming red
 * "Failing tools" list — even though most of those are expected orchestration
 * outcomes, not provider breakage.
 *
 * This module is the single source of truth. It refines the coarse stored
 * outcome (`tool_usage_log.outcome`) plus its `error_msg`/`status_code` into ONE
 * canonical set of categories, and normalizes raw HTTP codes into meaningful
 * analyst-facing messages. It is intentionally self-contained (no imports) so
 * the edge function COULD mirror it — but today it does NOT. There is no
 * `classifyDetailedOutcome` in osint-agent/tool-outcome.ts and no parity test
 * between the two files. Treat this module as the only implementation.
 *
 * ───────────────────────── CANONICAL OUTCOMES ─────────────────────────
 *  success            genuine success
 *  empty              EXPECTED PROVIDER RESPONSE — ran fine, target has no record
 *  skipped            governance / dedup / gating / suppression — intentionally not run
 *  cancelled          aborted by the investigation's overall time budget (not the tool's fault)
 *  timeout            the tool's own per-call time budget was exceeded
 *  rate_limited       provider returned 429 / asked us to back off
 *  http_denied        provider returned 403 — access blocked (bot protection / IP reputation). Exception:
 *                     LeakCheck documents its 403 as an inactive plan or a reached quota — see explainLeakCheckRefusal
 *  blocked            provider returned 451 — legally unavailable
 *  config_error       401/402, or an invalid / missing API key — operator-actionable
 *  failed             genuine provider error: 5xx, or a 400/422 bad request
 *  unknown            errored, but with no message and no status code — opaque
 *
 * "Needs attention" (a real problem an operator/analyst should act on) is ONLY
 * {config_error, failed, unknown}. Everything else is expected or transient and
 * must never be shown as a red hard failure.
 */

export type CanonicalOutcome =
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

export type OutcomeTone = "ok" | "empty" | "skipped" | "degraded" | "failed";

export interface OutcomeMeta {
  /** Short human label for chips/counts. */
  label: string;
  /** Longer label for the summary tiles. */
  longLabel: string;
  /** Visual tone bucket. */
  tone: OutcomeTone;
  /** True only for genuine problems worth an operator's/analyst's attention. */
  needsAttention: boolean;
}

export const CANONICAL_OUTCOME_META: Record<CanonicalOutcome, OutcomeMeta> = {
  success:      { label: "OK",           longLabel: "Succeeded",         tone: "ok",       needsAttention: false },
  empty:        { label: "No record",    longLabel: "No record found",   tone: "empty",    needsAttention: false },
  skipped:      { label: "Skipped",      longLabel: "Skipped",           tone: "skipped",  needsAttention: false },
  cancelled:    { label: "Cancelled",    longLabel: "Cancelled",         tone: "skipped",  needsAttention: false },
  timeout:      { label: "Timed out",    longLabel: "Timed out",         tone: "degraded", needsAttention: false },
  rate_limited: { label: "Rate-limited", longLabel: "Rate-limited",      tone: "degraded", needsAttention: false },
  http_denied:  { label: "Denied",       longLabel: "Access denied",     tone: "degraded", needsAttention: false },
  blocked:      { label: "Blocked",      longLabel: "Legally blocked",   tone: "degraded", needsAttention: false },
  config_error: { label: "Config",       longLabel: "Config / key error", tone: "failed",  needsAttention: true },
  failed:       { label: "Failed",       longLabel: "Failed",            tone: "failed",   needsAttention: true },
  unknown:      { label: "Unknown",      longLabel: "Unknown error",     tone: "failed",   needsAttention: true },
};

// Governance / gating / dedup / suppression phrases the runtime emits ON PURPOSE.
// A row matching any of these was intentionally not run (or its result discarded
// by policy) and must NEVER read as a provider failure — even if the edge
// classifier historically stored it as `failed` (the two known bugs:
// "already ran for this entity" and "guard not met" — see the 2026-07 prod audit).
const SKIP_RE =
  /execution plan required|duplicate call|burst limit|same-tool (?:cycle limit|budget)|paid-call (?:cycle limit|budget)|active-call concurrency|internal concurrency cap|internal (?:paid-call|throttle)|paid-call cap reached|already has a call in-flight|already ran for this entity|high-cost tool already used|guard not met|weak lead blocked|expected value\s+\d+\s+below|disabled after \d+ consecutive|degraded this run|suppressed for investigation|selector blacklisted|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b|not configured|provider disabled|rate-limited\s*[—-]\s*provider|provider\b[^]*?\bsuppressed|5xx\s*[—-]\s*provider|finalize window open|run tool-call cap reached/i;

const EMPTY_RE = /no usable result|no record found|not found\b|no results?\b/i;
const CANCEL_RE = /\babort(?:ed|error)?\b|signal (?:has been|was) aborted|\bcancell?ed\b/i;
const TIMEOUT_RE = /\btimed?\s?out\b|exceeded\s+\d+\s?ms|_timeout\b|\btimeout\b/i;
const RATELIMIT_RE = /\brate[\s-]?limit/i;
const CONFIG_RE = /invalid (?:or unauthorized )?(?:api )?key|unauthorized key|api[\s-]?key|missing[\s_-]?key|not configured|no api key|payment required|insufficient (?:credit|balance)|quota exceeded/i;
const DENIED_RE = /\bforbidden\b|access denied/i;
/** The two messages LeakCheck documents for HTTP 403 (docs.leakcheck.io/errors, checked 2026-10-13). Matched as the WHOLE text. */
const LEAKCHECK_PLAN_RE = /^["']?active plan required["']?\.?$/i;
const LEAKCHECK_LIMIT_RE = /^["']?limit reached["']?\.?$/i;
/** What the edge stores when the refused call's result has no top-level error string (cache.ts extractToolError), or nothing.
 *  It says nothing about what LeakCheck itself returned — only that the stored row carries no message. */
const STATUS_ONLY_RE = /^(?:upstream returned HTTP 403)?$/i;

// A 5xx does NOT always mean "the provider is down". Providers routinely answer
// a deterministic, non-retryable input problem with a 500 — markdown.new returns
// `markdown.new 500: File too large (17MB). Maximum size is 10MB` for an
// oversized PDF. Painting every 5xx as "an upstream outage — retry later" tells
// the analyst to re-run a call that can never succeed, and discards the one line
// that says why. Kept deliberately narrow: only phrases that describe the
// REQUEST being out of bounds, never a generic "conversion failed"/"error"
// (those really can be transient).
const NON_RETRYABLE_5XX_RE =
  /too large|too big|maximum size|max(?:imum)? (?:file )?(?:size|length)|size limit|exceeds? the (?:maximum|limit|size)|payload too|unsupported (?:file|format|content|media|type)|malformed|invalid (?:url|input|file|document|format)/i;

/** A bare 403 / 429 / 451 in an error message, e.g. "nominatim 403" or "request failed (403)". */
const TEXT_REFUSAL_CODE_RE = /\b(403|429|451)\b/;
function inferRefusalCode(msg: string): number | null {
  const m = msg ? TEXT_REFUSAL_CODE_RE.exec(msg) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Refine a coarse stored outcome (`ok`/`skipped`/`empty`/`failed`, or null for
 * legacy rows) + its error/status into ONE canonical category.
 *
 * Precedence is deliberate and documented so every classification is
 * reproducible (Issue #1: "every count must use the same canonical outcome"):
 *   1. explicit ok / empty coarse outcomes short-circuit
 *   2. governance / dedup / suppression phrases → skipped (rescues mis-stored rows)
 *   3. empty phrases / 404 → empty
 *   4. cancelled (outer-budget abort) — checked before timeout since a raw
 *      AbortError is the GLOBAL abort, whereas a per-tool timeout resolves with
 *      an explicit "exceeded Nms tool timeout" string
 *   5. timeout → 6. rate-limited → 7. blocked (451) → 8. config (401/402/bad key)
 *      → 9. denied (403) → 10. failed (5xx / 400 / 422) → 11. unknown
 */
export function classifyDetailedOutcome(
  coarse: string | null | undefined,
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
): CanonicalOutcome {
  const oc = String(coarse ?? "").toLowerCase();
  const msg = String(errorMsg ?? "").trim();
  const code = typeof statusCode === "number" ? statusCode : null;
  // Many tools put the provider's status in the message and leave `status_code`
  // null ("nominatim 403", "reddit request failed (403)"). Read ONLY the three
  // refusal codes back out of the text, and only when the column is empty — a
  // stored code always wins. Without this an upstream refusal with no stored
  // code fell through to `failed` and read as provider breakage.
  const textCode = code == null ? inferRefusalCode(msg) : null;

  if (oc === "ok") return "success";
  if (oc === "empty") return "empty";

  // Governance always wins — even over a present status code (e.g.
  // "429 rate-limited — provider X suppressed" is a skip, not a 429 failure).
  if (msg && SKIP_RE.test(msg)) return "skipped";

  if (oc === "skipped") return "skipped";

  // Successful negative.
  if (code === 404) return "empty";
  if (msg && EMPTY_RE.test(msg)) return "empty";

  // Cancellation vs. timeout: a bare AbortError = the outer investigation budget
  // aborting an in-flight call (not the provider's fault). A per-tool timeout has
  // an explicit "exceeded Nms" / "timed out" phrase.
  if (msg && CANCEL_RE.test(msg) && !TIMEOUT_RE.test(msg)) return "cancelled";
  if (msg && TIMEOUT_RE.test(msg)) return "timeout";

  if (code === 429 || textCode === 429 || (msg && RATELIMIT_RE.test(msg))) return "rate_limited";
  if (code === 451 || textCode === 451) return "blocked";
  // Config/auth: 401/402, or an explicit bad-key message even at HTTP 200
  // (e.g. ipqualityscore returns 200 with "Invalid or unauthorized key").
  if (code === 401 || code === 402 || (msg && CONFIG_RE.test(msg))) return "config_error";
  if (code === 403 || textCode === 403 || (msg && DENIED_RE.test(msg))) return "http_denied";
  if (code != null && (code >= 500 || code === 400 || code === 422)) return "failed";
  if (msg && /\bHTTP\s*5\d\d\b|upstream returned/i.test(msg)) return "failed";

  // Errored, but with no usable signal — opaque. (The 137 prod rows with a null
  // error_msg AND null status_code land here honestly instead of as scary "failed".)
  if (!msg && code == null) return oc === "failed" ? "unknown" : "success";
  return "failed";
}

/**
 * LeakCheck's documented reading of an HTTP 403, or null when this is not a LeakCheck 403 the documentation covers.
 *
 * LeakCheck DOCUMENTS 403 as exactly two things — "Active plan required" and "Limit reached"
 * (docs.leakcheck.io/errors) — so for THAT tool, on THAT status, the generic "bot protection" sentence points at
 * the wrong fix. The status alone cannot say WHICH of the two, so one is named only when the STORED text is
 * LeakCheck's documented message; otherwise the sentence says "either" and that the stored record does not say
 * which. It deliberately does not claim LeakCheck omitted anything: the tool keeps the provider's body in its result,
 * the log row simply does not preserve it. The headline asserts nothing but the refusal. Keyed on the tool name and
 * the 403 status, never on keywords: a 403 from a website, a CDN or a scraping tool saying "subscription" or "quota"
 * is the TARGET's refusal, not a problem with the analyst's provider plan. A documented message is accepted only as
 * the WHOLE stored text and is then quoted CANONICALLY, so a stored value that already carries quotes cannot double
 * them, and a WAF page, "Forbidden: Limit reached" or a longer sentence containing the phrase is not read as
 * LeakCheck's message. Exported so the Health hook and the wording helper cannot drift apart.
 */
export function explainLeakCheckRefusal(
  toolName: string,
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
): string | null {
  if (toolName !== "leakcheck_lookup" || statusCode !== 403) return null;
  const raw = String(errorMsg ?? "").trim();
  if (LEAKCHECK_PLAN_RE.test(raw)) {
    return 'Refused (HTTP 403) — "Active plan required". LeakCheck reports this when the account has no active plan. Check the plan on the LeakCheck account.';
  }
  if (LEAKCHECK_LIMIT_RE.test(raw)) {
    return 'Refused (HTTP 403) — "Limit reached". LeakCheck reports this when the plan\'s usage quota is used up. Check the quota on the LeakCheck account.';
  }
  if (STATUS_ONLY_RE.test(raw)) {
    return "Refused (HTTP 403). LeakCheck documents 403 as either an inactive plan or a reached usage quota, and the stored record does not say which. Check the plan and remaining quota on the LeakCheck account.";
  }
  return null;
}

/**
 * Turn a raw provider error into a meaningful analyst-facing message (Issue #2).
 * Never dump a bare HTTP code. The category drives the wording; the tool name
 * and code add specificity.
 */
export function normalizeProviderError(
  toolName: string,
  errorMsg: string | null | undefined,
  statusCode: number | null | undefined,
  category?: CanonicalOutcome,
): string {
  const cat = category ?? classifyDetailedOutcome("failed", errorMsg, statusCode);
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
      // A 403 is not always bot protection — see explainLeakCheckRefusal for the one tool whose 403 is documented.
      {
        const leakcheck = explainLeakCheckRefusal(toolName, errorMsg, statusCode);
        if (leakcheck) return leakcheck;
      }
      return `Access denied (HTTP ${code ?? 403}) — the provider blocked this request, usually bot protection or IP reputation, not a bad key.`;
    case "blocked":
      return `Legally unavailable (HTTP ${code ?? 451}) — the provider blocked this content for legal reasons.`;
    case "config_error":
      if (/key/i.test(raw)) return `Provider credentials rejected — the API key is invalid or unauthorized. Check the key in Supabase function secrets.`;
      if (code === 402 || /payment|quota|credit|balance/i.test(raw)) return `Provider quota/billing limit reached${code ? ` (HTTP ${code})` : ""} — top up or wait for the quota to reset.`;
      return `Provider authentication failed (HTTP ${code ?? 401}) — the API key is missing or unauthorized.`;
    case "failed":
      // Never throw away the provider's own words. `raw` is the only place the
      // actual cause survives; the generic sentence is a fallback for when the
      // provider gave us nothing, not a replacement for what it did give us.
      if (code != null && code >= 500) {
        if (short && NON_RETRYABLE_5XX_RE.test(raw)) {
          return `Provider rejected the input (HTTP ${code}) — ${short}. A limit of the request itself, not an outage: retrying the same input will fail the same way.`;
        }
        return short
          ? `Provider server error (HTTP ${code}) — ${short}. Likely an upstream fault; retry later.`
          : `Provider server error (HTTP ${code}) — an upstream outage on the provider's side. Retry later.`;
      }
      if (code === 400 || code === 422) {
        return short
          ? `Provider rejected the request (HTTP ${code}) — ${short}. Not an outage; the input or selector is wrong for this tool.`
          : `Provider rejected the request (HTTP ${code}) — likely an unsupported selector type or malformed input for this tool, not an outage.`;
      }
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

/** Convenience: the categories that represent a genuine problem to surface. */
export function needsAttention(cat: CanonicalOutcome): boolean {
  return CANONICAL_OUTCOME_META[cat].needsAttention;
}

/**
 * The coarse outcome to feed `classifyDetailedOutcome` for one `tool_usage_log`
 * row. Legacy rows predate the `outcome` column: they fall back to the `ok`
 * boolean, and only an explicit `ok === false` reads as failed. Shared so the
 * Activity feed and the Health panel cannot disagree about a legacy row.
 */
export function coarseOutcome(outcome: string | null | undefined, ok: boolean | null | undefined): string {
  return outcome ?? (ok === false ? "failed" : "ok");
}

/**
 * The FIVE groups every tool-outcome tile on the Tools tab reports — Activity
 * and Health alike. They partition the canonical outcomes, so the five counts
 * always sum to the number of calls.
 *
 *  succeeded  success
 *  no_record  empty — the tool ran and the target has no data (expected)
 *  skipped    skipped, cancelled — intentionally not run, or aborted by the run's own budget
 *  degraded   timeout, rate_limited, http_denied, blocked — transient / upstream refusal
 *  faulted    config_error, failed, unknown — the only group that needs attention
 */
export type OutcomeGroup = "succeeded" | "no_record" | "skipped" | "degraded" | "faulted";

export const OUTCOME_GROUP_MEMBERS: Record<OutcomeGroup, readonly CanonicalOutcome[]> = {
  succeeded: ["success"],
  no_record: ["empty"],
  skipped: ["skipped", "cancelled"],
  degraded: ["timeout", "rate_limited", "http_denied", "blocked"],
  faulted: ["config_error", "failed", "unknown"],
};

const GROUP_OF: Record<CanonicalOutcome, OutcomeGroup> = (() => {
  const out = {} as Record<CanonicalOutcome, OutcomeGroup>;
  for (const [group, members] of Object.entries(OUTCOME_GROUP_MEMBERS) as [OutcomeGroup, readonly CanonicalOutcome[]][]) {
    for (const c of members) out[c] = group;
  }
  return out;
})();

export function outcomeGroup(cat: CanonicalOutcome): OutcomeGroup {
  return GROUP_OF[cat];
}

export type OutcomeGroupCounts = Record<OutcomeGroup, number>;

export function emptyGroupCounts(): OutcomeGroupCounts {
  return { succeeded: 0, no_record: 0, skipped: 0, degraded: 0, faulted: 0 };
}

/** Roll per-category counts up into the five tile groups. */
export function groupOutcomeCounts(counts: Partial<Record<CanonicalOutcome, number>>): OutcomeGroupCounts {
  const out = emptyGroupCounts();
  for (const [cat, n] of Object.entries(counts) as [CanonicalOutcome, number | undefined][]) {
    const group = GROUP_OF[cat];
    if (group && n) out[group] += n;
  }
  return out;
}

/**
 * Within the `skipped` group: a skip because the tool is not AVAILABLE at all
 * (no key, disabled, gated) rather than a per-call policy decision. A sub-count
 * only — it is always counted inside `skipped`, never beside it.
 */
const GATED_SUBRE = /\bgated\b|missing.?key|not configured|disabled|unavailable/i;
export function isGatedSkip(cat: CanonicalOutcome, errorMsg: string | null | undefined): boolean {
  return cat === "skipped" && GATED_SUBRE.test(String(errorMsg ?? ""));
}
