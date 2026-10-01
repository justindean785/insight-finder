// stream-error-classify.ts — pure classifier for orchestrator stream errors.
//
// Separates CLIENT-side message-builder schema faults (AI SDK InvalidPrompt /
// MissingToolResults — the tool-call/result pairing errors) from genuine
// provider/context errors, so index.ts can (a) log the two apart and (b) end the
// run CLEANLY on a schema fault without masking a real provider/context error.
//
// Pure + runtime-agnostic (no Deno/network imports) → unit-testable from Deno and
// vitest. Touches NO evidence-integrity logic.

/**
 * True when the error is the AI SDK message-schema / tool-result-pairing fault
 * class. Matches, case-insensitively:
 *   - `AI_InvalidPromptError` / `InvalidPromptError`
 *   - "messages do not match the ModelMessage[] schema"
 *   - `AI_MissingToolResultsError`
 *   - the SINGULAR stock message "Tool result is missing", AND
 *   - the PLURAL stock message "Tool results are missing for tool calls"
 * and the `InvalidPrompt` / `MissingToolResults` error *names*.
 *
 * The plural form is the one MiniMax's parallel-tool-call truncation actually
 * produces ("Tool results are missing for tool calls <id>_1, <id>_2"); the
 * singular form was the only one previously matched, so the plural silently
 * looked like a generic provider error.
 */
export function isMessageSchemaError(message: string, errorName = ""): boolean {
  return (
    /AI_InvalidPromptError|InvalidPromptError|do not match the ModelMessage|AI_MissingToolResultsError|Tool result is missing|Tool results are missing for tool calls/i
      .test(message) || /InvalidPrompt|MissingToolResults/i.test(errorName)
  );
}

/**
 * Map a genuine orchestrator/provider stream failure to a clear, non-alarming,
 * ACTIONABLE message. Returns null when the error isn't a recognized provider
 * failure (the caller then falls back to the redacted raw message, so real
 * novel errors are never hidden).
 *
 * Pure + integrity-neutral: this only rewords the FAILURE surfaced to the user
 * when the LLM orchestrator call fails — it changes NO evidence/confidence/tool
 * logic. The specific case this fixes: a Lovable/MiniMax **403** on a
 * credit-gated or over-quota key used to reach users as a bare, scary
 * "Investigation run failed - Forbidden".
 */
export function classifyStreamProviderError(message: string, errorName = ""): string | null {
  const s = `${message} ${errorName}`.toLowerCase();
  const saved = "Your partial results were saved.";
  if (/\b403\b|forbidden|quota|credit|insufficient|payment|billing/.test(s)) {
    return `The AI analysis provider rejected the request — it's likely out of credits or over quota. ${saved} Please retry shortly; if it keeps happening, the provider key needs attention.`;
  }
  if (/\b429\b|rate.?limit|too many requests|overloaded/.test(s)) {
    return `The AI analysis provider is rate-limited right now. ${saved} Please retry in a moment.`;
  }
  if (/\b401\b|unauthorized|invalid api key|invalid.*key|authentication failed/.test(s)) {
    return `The AI analysis provider rejected the credentials. ${saved} This needs an operator to check the provider key.`;
  }
  if (/context (window|length)|maximum.*(token|context)|token.*limit|too long|overflow/.test(s)) {
    return `This investigation exceeded the model's context limit. ${saved} Try a narrower follow-up.`;
  }
  if (/timeout|timed out|econnreset|econnrefused|network error|fetch failed|unreachable|socket hang/.test(s)) {
    return `The AI analysis provider was temporarily unreachable (network/timeout). ${saved} Please retry shortly.`;
  }
  return null;
}


/**
 * What the provider actually said, WITHOUT quoting it back.
 *
 * An `APICallError` from the AI SDK keeps the HTTP body on `responseBody` and the
 * status on `statusCode`; `error.message` alone is the reason-phrase ("Bad
 * Request"). Measured 2026-09-20: 14 of 14 `gemini-direct` fallback invocations
 * died at 0 steps with exactly "Bad Request" recorded and nothing else, so the
 * fallback has never worked in production and nobody can say why from the ledger.
 *
 * ⚠️ The first cut appended 300 characters of the RAW body, and that was wrong.
 * This string is persisted — it reaches `tool_usage_log`, the invocation row and
 * the analyst-visible recovery text — and a 4xx body routinely echoes the request
 * that caused it. The request here is the investigation: selectors, breach values,
 * scraped page text. A cost/diagnostics feature must not become an evidence
 * egress, so the raw body never rides this string.
 *
 * What DOES ride it cannot carry an echo:
 *   • `HTTP <status>` — an integer;
 *   • the provider's ENUM-like code (`error.status` / `error.code` / `error.type`,
 *     e.g. `INVALID_ARGUMENT`, `invalid_request_error`), matched against a strict
 *     identifier pattern and capped, so a free-text value is dropped rather than
 *     truncated;
 *   • `body=<n>B` — the body's SIZE, which says a body existed without saying what
 *     was in it.
 *
 * That is enough to tell `HTTP 400 INVALID_ARGUMENT` from `HTTP 429` from a
 * transport fault, which is the whole of what the ledger could not do before.
 *
 * `includeBody` is the deliberate opt-in for a debugging session, wired to the
 * `STREAM_ERROR_BODY_DETAIL` env var at the ONE call site in index.ts (read at
 * call time, so it binds without a deploy). It defaults OFF and this function
 * stays pure — the env is never read here.
 */
export const STREAM_ERROR_DETAIL_MAX = 300;

/** Enum-like provider codes only: identifier characters, nothing free-text. */
const PROVIDER_CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;

export function describeStreamError(error: unknown, includeBody = false): string {
  const base = error instanceof Error ? error.message : String(error);
  const e = (error ?? {}) as { statusCode?: unknown; responseBody?: unknown; data?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  const body = typeof e.responseBody === "string" ? e.responseBody : "";

  const parts: string[] = [];
  if (status != null) parts.push(`HTTP ${status}`);
  const code = providerErrorCode(body, e.data);
  if (code) parts.push(code);
  if (body) {
    parts.push(
      includeBody
        ? body.replace(/\s+/g, " ").trim().slice(0, STREAM_ERROR_DETAIL_MAX)
        : `body=${body.length}B`,
    );
  }
  return parts.length === 0 ? base : `${base} [${parts.join(" ")}]`;
}

/**
 * Pull an enum-like code out of a JSON error envelope. Providers agree on the
 * shape more than the key: `{error:{status,code,type}}` (Gemini/OpenAI/Anthropic)
 * or the same keys at the top level. Anything that is not a bare identifier — a
 * sentence, a path, an echoed value — is rejected, not truncated.
 */
function providerErrorCode(body: string, data: unknown): string | null {
  for (const source of [parseJson(body), data]) {
    if (!source || typeof source !== "object") continue;
    const o = source as Record<string, unknown>;
    const inner = o.error && typeof o.error === "object" ? o.error as Record<string, unknown> : o;
    for (const key of ["status", "type", "code"]) {
      const v = inner[key];
      if (typeof v === "string" && PROVIDER_CODE_RE.test(v)) return v;
    }
  }
  return null;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * `/health` self-test for `checks.stream_error_detail`: runs the DEPLOYED
 * describeStreamError on a fixed synthetic provider error and checks the two
 * properties that matter — the status survives, and an echoed input does not.
 * Its PRESENCE proves this build is live; ok:false means the redaction regressed.
 */
export function streamErrorDetailSelfTest(): { ok: boolean; detail: string } {
  const probe = Object.assign(new Error("Bad Request"), {
    statusCode: 400,
    responseBody: JSON.stringify({ error: { code: "invalid_request_error", param: "probe-echo@example.invalid" } }),
  });
  const out = describeStreamError(probe);
  const statusKept = out.includes("HTTP 400") && out.includes("invalid_request_error");
  const echoDropped = !out.includes("probe-echo");
  return {
    ok: statusKept && echoDropped,
    detail: statusKept && echoDropped
      ? "stream errors record HTTP status + provider code; response body withheld"
      : `self-test failed (status kept: ${statusKept}, echo dropped: ${echoDropped})`,
  };
}
