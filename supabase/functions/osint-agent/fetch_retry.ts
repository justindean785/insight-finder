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
 *   - Per-attempt timeout (default 15s) so a stalled upstream connection can
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
  const timeoutMs = opts.timeoutMs ?? 15_000;
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

/**
 * Build a fetch-compatible function that aborts a request if it goes
 * `idleMs` without producing new data — no response headers yet, or a
 * streamed body that stops emitting chunks (a stalled SSE connection).
 * The idle timer RESETS on every chunk, so a genuinely long streaming
 * completion is never punished — only a connection that goes quiet is.
 *
 * Every other outbound call in this codebase (fetchRetry, fetchT,
 * minimaxChat) is timeout-bounded; the LLM orchestrator provider fetches
 * (createOpenAICompatible's default global `fetch`) were the one
 * exception, and a provider that opens its stream and then stalls mid-
 * generation hung streamText() forever — stopWhen's wall-clock deadline is
 * only checked BETWEEN completed steps, so a step that never resolves is
 * never interrupted, leaving the thread "active" and the UI frozen on the
 * last tool label with no recovery. Pass the result as the `fetch` option
 * to createOpenAICompatible so every provider gets the same guard.
 */
export function createIdleTimeoutFetch(idleMs: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const external = init?.signal ?? undefined;
    const ctrl = new AbortController();
    const onExternalAbort = () => ctrl.abort();
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => ctrl.abort(), idleMs);
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), idleMs);
    };

    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(idleTimer);
      external?.removeEventListener("abort", onExternalAbort);
      throw e;
    }

    const body = response.body;
    if (!body) {
      clearTimeout(idleTimer);
      external?.removeEventListener("abort", onExternalAbort);
      return response;
    }

    // Re-wrap the body so each chunk read re-arms the idle timer. A stall
    // mid-stream now aborts the SAME way a stall before the first byte does.
    const reader = body.getReader();
    const guarded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(idleTimer);
            external?.removeEventListener("abort", onExternalAbort);
            controller.close();
            return;
          }
          armIdle();
          controller.enqueue(value);
        } catch (e) {
          clearTimeout(idleTimer);
          external?.removeEventListener("abort", onExternalAbort);
          controller.error(e);
        }
      },
      cancel(reason) {
        clearTimeout(idleTimer);
        external?.removeEventListener("abort", onExternalAbort);
        return reader.cancel(reason);
      },
    });
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
