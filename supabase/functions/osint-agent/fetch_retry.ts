/**
 * fetch_retry.ts — Pure Deno fetch helper with exponential backoff.
 *
 * Extracted from env.ts so ratelimit.ts (and future test files) can import
 * it without pulling in env.ts's `npm:@ai-sdk/openai-compatible@1` import.
 * Closes audit F-C2 prerequisite: enables Deno test runner for edge function
 * pure-logic modules.
 *
 * Behavior:
 *   - Retries on HTTP 429 and 5xx (max 2 retries by default)
 *   - Retries on thrown network errors
 *   - Honors a pre-set AbortSignal — does not issue more requests after abort
 *   - Backoff: 400ms * 2^attempt
 */

export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  const signal = (init as { signal?: AbortSignal }).signal;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // If an externally-supplied AbortSignal already fired (e.g. a per-call
    // timeout tripped between retries), stop spinning instead of issuing a
    // pointless next request.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
          continue;
        }
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("fetchRetry exhausted");
}
