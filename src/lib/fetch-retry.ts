/**
 * Transport retry policy for the chat/investigation client.
 *
 * ⛔ RETRIES ARE METHOD-SCOPED. DO NOT WIDEN THIS.
 *
 * This helper used to live inline in `ChatWindow.tsx` and retried EVERY
 * request up to three times, with no regard for the HTTP method. The chat
 * transport's only call is a **POST to `/functions/v1/osint-agent`** — the
 * investigation endpoint. That endpoint carries no idempotency key and does
 * not reject overlapping runs for a thread, so a transport-level replay does
 * not "retry" anything: it STARTS A SECOND INVESTIGATION against the same
 * thread. One 429 or one 502 on a run that the server had in fact accepted
 * could fan a single analyst submit into three concurrent runs — duplicated
 * paid tool calls, duplicated artifacts, duplicated spend against
 * `MAX_PAID_CALLS`, and two writers racing the same finalize path.
 *
 * The rule this file enforces:
 *
 *   - GET and HEAD are replay-safe by definition (RFC 9110 §9.2.1) and keep
 *     the full retry budget: retryable status codes AND network errors.
 *   - POST, PUT, PATCH, DELETE — and any other method — execute EXACTLY ONCE.
 *     Their response, or their transport error, is handed straight back to the
 *     caller untouched. Surfacing a failed submit to the analyst is strictly
 *     safer than silently launching a duplicate run.
 *
 * A safe retry for the investigation POST needs a server-side idempotency key
 * and an overlap guard first. Until those exist, this boundary is the control.
 */

/** HTTP statuses worth a second attempt — transient by nature, not semantic. */
export const RETRYABLE_HTTP_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Methods whose repetition has no additional effect on the server, so a
 * replay cannot create a second unit of work. Kept deliberately minimal:
 * PUT and DELETE are idempotent in the RFC sense but are still *mutations*,
 * and this codebase has no endpoint that needs them retried.
 */
const REPLAY_SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Attempts allowed for a replay-safe request (1 initial + 2 retries). */
export const MAX_ATTEMPTS = 3;

/** Exponential backoff: 250ms, then 500ms. */
function backoffMs(attempt: number): number {
  return 250 * Math.pow(2, attempt - 1);
}

/**
 * Resolve the method a `fetch(url, init)` pair will actually send.
 *
 * `init.method` wins when present, otherwise a `Request` first argument
 * carries its own method, otherwise fetch defaults to GET. Normalized to
 * upper case because `fetch` accepts `"post"` just as happily as `"POST"` —
 * a case-sensitive check here would leak the exact replay this file exists
 * to stop.
 */
export function resolveRequestMethod(url: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = typeof init?.method === "string" && init.method.trim() ? init.method : null;
  const fromRequest =
    !fromInit && typeof Request !== "undefined" && url instanceof Request && url.method ? url.method : null;
  return (fromInit ?? fromRequest ?? "GET").trim().toUpperCase();
}

/** True only for methods that may be sent more than once. */
export function isReplaySafeMethod(method: string): boolean {
  return REPLAY_SAFE_METHODS.has(method.trim().toUpperCase());
}

/**
 * `fetch` with retries for replay-safe methods only.
 *
 * Replay-safe (GET/HEAD): retries on a `RETRYABLE_HTTP_CODES` status and on a
 * thrown transport error, up to `MAX_ATTEMPTS`, with exponential backoff.
 * Everything else: a single attempt, whatever it returns or throws.
 */
export async function fetchWithRetry(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = resolveRequestMethod(url, init);
  // A mutating request gets exactly one attempt — see the file header.
  const maxAttempts = isReplaySafeMethod(method) ? MAX_ATTEMPTS : 1;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE_HTTP_CODES.has(res.status) || attempt === maxAttempts) return res;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
  throw lastErr ?? new Error("fetch retry exhausted");
}
