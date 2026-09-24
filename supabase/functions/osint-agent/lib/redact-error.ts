/**
 * redact-error — strip credentials from a provider/runtime error message before it
 * leaves the function (an HTTP response body, a stream error part).
 *
 * The stream `onError` path always redacted these; the request-level catch-all
 * 500 returned `detail: e.message` verbatim (audit 2026-09-24, F-7b), so a provider
 * error that echoes its key ("Incorrect API key provided: sk-…") reached the
 * client. One function, both paths.
 *
 * Zero imports on purpose: pure, and testable without the request graph.
 */
export function redactErrorMessage(message: string): string {
  return String(message ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/xai-[A-Za-z0-9._-]+/g, "xai-[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]");
}
