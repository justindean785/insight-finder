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
