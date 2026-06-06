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
 *   - Per-attempt timeout (default 30s) so a stalled upstream connection can
 *     never hang the orchestrator stream forever — combines with any
 *     caller-supplied AbortSignal
 *   - Honors a pre-set AbortSignal — does not issue more requests after abort
 *   - Backoff: 400ms * 2^attempt
 */

export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastErr: unknown;
  const external = (init as { signal?: AbortSignal }).signal;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // If an externally-supplied AbortSignal already fired (e.g. a per-call
    // timeout tripped between retries), stop spinning instead of issuing a
    // pointless next request.
    if (external?.aborted) throw new DOMException("Aborted", "AbortError");
    // Fresh per-attempt timeout; aborts this attempt's fetch if it stalls.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    external?.addEventListener("abort", onAbort, { once: true });
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if ((r.status === 429 || (r.status >= 500 && r.status < 600)) && attempt < retries) {
        // Discard this attempt's body so the connection stream isn't leaked
        // before we issue the retry.
        await r.body?.cancel().catch(() => {});
        await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      // Retry a per-attempt timeout / network error, but not a genuine
      // caller-initiated cancel.
      if (attempt < retries && !external?.aborted) {
        await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(tid);
      external?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr ?? new Error("fetchRetry exhausted");
}

/**
 * Plain fetch with a hard per-call timeout (no retry). For one-shot calls to
 * flaky/slow upstreams (crt.sh, archive.org, blockchair, shodan, …) that must
 * not hang the orchestrator stream. Combines with any caller-supplied signal.
 */
export async function fetchT(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<Response> {
  const external = (init as { signal?: AbortSignal }).signal;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
    external?.removeEventListener("abort", onAbort);
  }
}
