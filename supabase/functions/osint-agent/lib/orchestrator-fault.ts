/**
 * orchestrator-fault — the request-level catch-all's log line and 500 response.
 *
 * Redact FIRST, then log and respond with the same bounded text. The previous code
 * logged the raw exception (`console.error("osint-agent error", e)`, message AND
 * stack) and redacted only the response, so a provider error echoing our key was
 * written verbatim to the edge logs (audit 2026-09-24, F-7b).
 *
 * Extracted from index.ts so a test can drive the real code path and capture what
 * it logs, rather than grepping the source.
 */
import { redactErrorMessage } from "./redact-error.ts";

export const ORCHESTRATOR_FAULT_DETAIL_MAX = 300;
const GENERIC_DETAIL = "The investigation engine hit an internal error. Retry the message.";

export function orchestratorFaultResponse(
  e: unknown,
  headers: Record<string, string>,
  log: (line: string) => void = (line) => console.error(line),
): Response {
  const message =
    redactErrorMessage(e instanceof Error ? e.message : String(e)).slice(0, ORCHESTRATOR_FAULT_DETAIL_MAX) ||
    GENERIC_DETAIL;
  log(JSON.stringify({
    event: "orchestrator_fault",
    error_name: e instanceof Error ? e.name : typeof e,
    message,
  }));
  return new Response(JSON.stringify({ error: "Internal Server Error", code: "ORCHESTRATOR_FAULT", detail: message }), {
    status: 500,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
