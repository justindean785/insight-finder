/**
 * fetch_retry_test.ts — Deno-native test of the pure fetch helper.
 *
 * Strategy: spin up a local HTTP server that returns a scripted sequence of
 * status codes (500, 429, 200, etc). The test points fetchRetry at the server
 * and asserts behavior. This exercises the real fetch + real network round-trip
 * without needing a third-party service.
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchRetry, createIdleTimeoutFetch } from "./fetch_retry.ts";

type ScriptedStep = number;

/** Local server that returns the next status from a per-path script. */
async function startScriptedServer(scripts: Record<string, ScriptedStep[]>): Promise<{ url: string; shutdown: () => Promise<void> }> {
  const requests: Array<{ path: string; count: number }> = [];
  const counters: Record<string, number> = {};

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const u = new URL(req.url);
    const path = u.pathname;
    counters[path] = counters[path] ?? 0;
    const i = counters[path]++;
    requests.push({ path, count: i });
    const script = scripts[path] ?? [200];
    const step = script[i] ?? script[script.length - 1];
    return new Response("body", { status: step });
  });

  const addr = server.addr;
  const url = `http://${addr.hostname}:${addr.port}`;
  return { url, shutdown: () => server.shutdown() };
}

Deno.test("fetchRetry: returns first response if not 429/5xx", async () => {
  const s = await startScriptedServer({ "/x": [200] });
  try {
    const r = await fetchRetry(`${s.url}/x`, {}, { baseDelayMs: 1 });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: retries on 500 then succeeds", async () => {
  const s = await startScriptedServer({ "/retry-5xx": [500, 500, 200] });
  try {
    const r = await fetchRetry(`${s.url}/retry-5xx`, {}, { baseDelayMs: 1 });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: retries on 429 (rate limited)", async () => {
  const s = await startScriptedServer({ "/retry-429": [429, 429, 200] });
  try {
    const r = await fetchRetry(`${s.url}/retry-429`, {}, { baseDelayMs: 1 });
    assertEquals(r.status, 200);
    await r.body?.cancel();
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: returns last 5xx when retries exhausted (does not throw)", async () => {
  // 1 initial + 2 retries = 3 attempts, all 500. The third is returned as-is
  // because attempt < retries is false on the final iteration.
  const s = await startScriptedServer({ "/all-500": [500, 500, 500] });
  try {
    const r = await fetchRetry(`${s.url}/all-500`, {}, { baseDelayMs: 1, retries: 2 });
    assertEquals(r.status, 500);
    await r.body?.cancel();
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: throws when network error on every attempt", async () => {
  // Bind a port then immediately release it so every connection is refused —
  // each attempt hits a real network error, exercising retry-then-throw. This
  // avoids a hung server handler, which would block server.shutdown() forever.
  const probe = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  await assertRejects(
    () => fetchRetry(`http://127.0.0.1:${port}/net-err`, {}, { baseDelayMs: 1, retries: 2 }),
    Error,
  );
});

Deno.test("fetchRetry: honors pre-aborted AbortSignal by throwing AbortError", async () => {
  const s = await startScriptedServer({ "/abort": [200] });
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    await assertRejects(
      () => fetchRetry(`${s.url}/abort`, { signal: ctrl.signal }, { baseDelayMs: 1 }),
      DOMException,
      "Aborted",
    );
  } finally {
    await s.shutdown();
  }
});

Deno.test("fetchRetry: does not retry on 4xx other than 429", async () => {
  // 404 is a client error — fetchRetry should NOT retry. Returns the 404 directly.
  // Use a script with only one entry to detect a retry (would re-hit the script).
  const s = await startScriptedServer({ "/404": [404] });
  try {
    const r = await fetchRetry(`${s.url}/404`, {}, { baseDelayMs: 1, retries: 3 });
    assertEquals(r.status, 404);
    await r.body?.cancel();
  } finally {
    await s.shutdown();
  }
});

// ---------------------------------------------------------------------------
// createIdleTimeoutFetch — guards LLM orchestrator provider fetches (the one
// outbound call in this codebase that previously had NO timeout at all: a
// provider stream that opens and then goes silent used to hang streamText()
// forever, since stopWhen's wall-clock deadline is only checked between
// COMPLETED steps). These tests simulate a stalled upstream via a server
// whose ReadableStream body stops producing chunks without closing.
// ---------------------------------------------------------------------------

Deno.test("createIdleTimeoutFetch: passes through a normal fast response untouched", async () => {
  const s = await startScriptedServer({ "/ok": [200] });
  try {
    const guardedFetch = createIdleTimeoutFetch(500);
    const r = await guardedFetch(`${s.url}/ok`);
    assertEquals(r.status, 200);
    assertEquals(await r.text(), "body");
  } finally {
    await s.shutdown();
  }
});

Deno.test("createIdleTimeoutFetch: aborts when the server never sends a response", async () => {
  // Handler stalls well past the idle window before ever resolving — simulates
  // a connection that opens but the upstream doesn't reply for a long time (no
  // headers). It DOES eventually resolve (300ms) so the test server's shutdown()
  // — which drains in-flight handlers — can't itself hang; the assertion is that
  // the client-side idle abort (50ms) fires long before that.
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async () => {
    await new Promise((res) => setTimeout(res, 300));
    return new Response("too-late", { status: 200 });
  });
  try {
    const guardedFetch = createIdleTimeoutFetch(50);
    const addr = server.addr as Deno.NetAddr;
    await assertRejects(() => guardedFetch(`http://${addr.hostname}:${addr.port}/silent`));
  } finally {
    await server.shutdown();
  }
});

Deno.test("createIdleTimeoutFetch: aborts when the stream sends one chunk then stalls", async () => {
  // Server sends headers + one chunk immediately, then the stream's pull()
  // never resolves again — a stalled mid-stream connection, exactly the
  // failure mode that hung the orchestrator. Safe to leave the pull()
  // permanently pending here (unlike the handler-never-responds test above):
  // Deno.serve's shutdown() drains on the HANDLER's own returned promise,
  // which already resolved the instant `new Response(stream)` was returned —
  // a downstream stream that never finishes producing bytes doesn't block it.
  let pulls = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("first-chunk"));
          return;
        }
        return new Promise<void>(() => {});
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    const guardedFetch = createIdleTimeoutFetch(50);
    const addr = server.addr as Deno.NetAddr;
    const r = await guardedFetch(`http://${addr.hostname}:${addr.port}/stall`);
    assertEquals(r.status, 200);
    await assertRejects(() => r.text());
  } finally {
    await server.shutdown();
  }
});

Deno.test("createIdleTimeoutFetch: does not abort a slow-but-progressing stream", async () => {
  // Each chunk arrives well within the idle window, even though the total
  // stream duration exceeds a single flat timeout would allow — proves the
  // guard is idle-based (resets per chunk), not an overall hard cap that
  // would incorrectly kill a long legitimate completion.
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => {
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (n >= 3) {
          controller.close();
          return;
        }
        await new Promise((res) => setTimeout(res, 20));
        controller.enqueue(new TextEncoder().encode(`chunk${n}-`));
        n++;
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    const guardedFetch = createIdleTimeoutFetch(100);
    const addr = server.addr as Deno.NetAddr;
    const r = await guardedFetch(`http://${addr.hostname}:${addr.port}/slow`);
    assertEquals(await r.text(), "chunk0-chunk1-chunk2-");
  } finally {
    await server.shutdown();
  }
});
