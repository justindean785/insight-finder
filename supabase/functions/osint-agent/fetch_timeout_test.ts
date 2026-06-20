/**
 * fetch_timeout_test.ts — proves the per-call timeout in the fetch helpers
 * actually fires. fetch_retry_test.ts already covers retry/backoff and a
 * pre-aborted caller signal; the gap was the *internal* timeout aborting a
 * response that never arrives. Both helpers wrap every attempt in an
 * AbortController armed with a timeout, so a request to a server that hangs
 * far longer than the configured timeout must reject quickly — not block for
 * the full server delay.
 */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchRetry } from "./fetch_retry.ts";
import { fetchT } from "./env.ts";

const SERVER_DELAY_MS = 3_000; // far longer than any timeout under test
const CLIENT_TIMEOUT_MS = 60;
const UPPER_BOUND_MS = 1_500; // generous slack for slow CI; still << SERVER_DELAY_MS

/** Server that holds each request open for `delayMs` (or until the client aborts). */
function startSlowServer(delayMs: number): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delayMs);
      // Resolve early when the client disconnects so shutdown() is not blocked.
      req.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
    return new Response("slow-body", { status: 200 });
  });
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://${addr.hostname}:${addr.port}`, shutdown: () => server.shutdown() };
}

Deno.test("fetchT: aborts a hung request at its timeout instead of waiting for the response", async () => {
  const s = startSlowServer(SERVER_DELAY_MS);
  try {
    const start = performance.now();
    let threw = false;
    try {
      await fetchT(`${s.url}/slow`, {}, CLIENT_TIMEOUT_MS);
    } catch {
      threw = true;
    }
    const elapsed = performance.now() - start;
    assert(threw, "fetchT should reject when the response exceeds its timeout");
    assert(
      elapsed < UPPER_BOUND_MS,
      `fetchT should abort near its ${CLIENT_TIMEOUT_MS}ms timeout, but took ${Math.round(elapsed)}ms`,
    );
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: per-attempt timeout aborts a hung request (no hang for full response)", async () => {
  const s = startSlowServer(SERVER_DELAY_MS);
  try {
    const start = performance.now();
    let threw = false;
    try {
      // retries: 0 → single attempt; baseDelayMs tiny so any backoff is negligible.
      await fetchRetry(`${s.url}/slow`, {}, { timeoutMs: CLIENT_TIMEOUT_MS, retries: 0, baseDelayMs: 1 });
    } catch {
      threw = true;
    }
    const elapsed = performance.now() - start;
    assert(threw, "fetchRetry should reject when the response exceeds its per-attempt timeout");
    assert(
      elapsed < UPPER_BOUND_MS,
      `fetchRetry should abort near its ${CLIENT_TIMEOUT_MS}ms timeout, but took ${Math.round(elapsed)}ms`,
    );
  } finally {
    await s.shutdown();
  }
});
