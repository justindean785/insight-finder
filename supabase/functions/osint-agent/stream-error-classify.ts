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
