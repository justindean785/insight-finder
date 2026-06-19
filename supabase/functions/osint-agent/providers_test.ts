import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// shouldFallbackOnStatus / shouldFallbackOnError — pure helpers, no env deps.
// Static import is safe here.
// ---------------------------------------------------------------------------
import { shouldFallbackOnStatus, shouldFallbackOnError } from "./providers.ts";

Deno.test("shouldFallbackOnStatus: 200 → no fallback", () => {
  assertEquals(shouldFallbackOnStatus(200), false);
});

Deno.test("shouldFallbackOnStatus: 400 → no fallback (client validation error)", () => {
  assertEquals(shouldFallbackOnStatus(400), false);
});

Deno.test("shouldFallbackOnStatus: 404 → no fallback", () => {
  assertEquals(shouldFallbackOnStatus(404), false);
});

Deno.test("shouldFallbackOnStatus: 401 → fallback (auth failure)", () => {
  assertEquals(shouldFallbackOnStatus(401), true);
});

Deno.test("shouldFallbackOnStatus: 403 → fallback (auth failure)", () => {
  assertEquals(shouldFallbackOnStatus(403), true);
});

Deno.test("shouldFallbackOnStatus: 429 → fallback (rate limit)", () => {
  assertEquals(shouldFallbackOnStatus(429), true);
});

Deno.test("shouldFallbackOnStatus: 500 → fallback", () => {
  assertEquals(shouldFallbackOnStatus(500), true);
});

Deno.test("shouldFallbackOnStatus: 502 → fallback", () => {
  assertEquals(shouldFallbackOnStatus(502), true);
});

Deno.test("shouldFallbackOnStatus: 503 → fallback", () => {
  assertEquals(shouldFallbackOnStatus(503), true);
});

Deno.test("shouldFallbackOnError: AbortError → fallback", () => {
  const e = new DOMException("signal is aborted", "AbortError");
  assertEquals(shouldFallbackOnError(e), true);
});

Deno.test("shouldFallbackOnError: TypeError (fetch failure) → fallback", () => {
  assertEquals(shouldFallbackOnError(new TypeError("fetch failed")), true);
});

Deno.test("shouldFallbackOnError: DNS error → fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("dns resolution failed")), true);
});

Deno.test("shouldFallbackOnError: ECONNREFUSED → fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("connect ECONNREFUSED")), true);
});

Deno.test("shouldFallbackOnError: ECONNRESET → fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("read ECONNRESET")), true);
});

Deno.test("shouldFallbackOnError: ENOTFOUND → fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("getaddrinfo ENOTFOUND api.minimax.io")), true);
});

Deno.test("shouldFallbackOnError: abort in message → fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("The operation was aborted")), true);
});

Deno.test("shouldFallbackOnError: generic Error → no fallback", () => {
  assertEquals(shouldFallbackOnError(new Error("unexpected token")), false);
});

Deno.test("shouldFallbackOnError: SyntaxError → no fallback", () => {
  assertEquals(shouldFallbackOnError(new SyntaxError("Unexpected end of JSON")), false);
});

Deno.test("shouldFallbackOnError: RangeError → no fallback", () => {
  assertEquals(shouldFallbackOnError(new RangeError("invalid array length")), false);
});

// ---------------------------------------------------------------------------
// minimaxChatWithFallback — integration tests.
//
// The function calls selectFallbackProvider which reads XAI_API_KEY and
// LOVABLE_API_KEY from env.ts (captured at module-load time). Since env.ts
// was already loaded by the static import above, we cannot change its
// exported values. Instead, the tests that exercise the "no fallback
// available" path work as-is (env keys are empty in test), and the tests
// that need fallback to trigger use a local HTTP server so we control
// both the primary and fallback responses — but we need the env module
// to believe a key is configured.
//
// Strategy: the XAI_API_KEY was already read as "" from env.ts. We
// cannot change that. But selectFallbackProvider reads it from the live
// env.ts export. The export is `const` so we can't mutate it directly.
//
// The practical approach: test the full integration via the shouldFallback*
// helpers (proven above) and test the fallback routing logic through
// selectFallbackProvider (covered in vitest). For minimaxChatWithFallback
// specifically, we test the two paths we CAN exercise:
//   1. MiniMax success → usedFallback: false  (works, env doesn't matter)
//   2. MiniMax failure + no fallback → usedFallback: false, status: 0
// ---------------------------------------------------------------------------

Deno.test("minimaxChatWithFallback: MiniMax 200 → no fallback", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.ok, true);
    assertEquals(result.usedFallback, false);
    assertEquals(result.content, "ok");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback: MiniMax 400 → no fallback (validation error)", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("bad request", { status: 400 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.usedFallback, false);
    assertEquals(result.ok, false);
    assertEquals(result.status, 400);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback: MiniMax 429 + no fallback configured → clean failure", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("rate limited", { status: 429 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.usedFallback, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback: MiniMax 500 + no fallback configured → clean failure", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("server error", { status: 500 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.usedFallback, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback: MiniMax 401 + no fallback configured → clean failure", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.usedFallback, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback: MiniMax 403 + no fallback configured → clean failure", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof globalThis.fetch;
    const result = await minimaxChatWithFallback({ user: "test" });
    assertEquals(result.ok, false);
    assertEquals(result.status, 0);
    assertEquals(result.usedFallback, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// minimaxChatWithFallback — END-TO-END CASCADE (the headline behavior).
//
// These prove the actual MiniMax-fails → fallback-provider-succeeds path,
// not just the classification pieces. env.ts captures API keys at module
// load and can't be flipped after import, so we inject availability via the
// optional `deps` parameter (production passes nothing → reads live env).
//
// No real providers are hit: globalThis.fetch is stubbed and routed by URL.
// We record every URL fetched so the test can ASSERT the fallback endpoint
// was actually called, not merely that the return shape looked right.
// ---------------------------------------------------------------------------

const MINIMAX_HOST = "api.minimax.io";
const GROK_HOST = "api.x.ai";

/** Build a fetch stub that routes by URL host and records all hits. */
function routingFetch(routes: {
  minimax: () => Response;
  grok?: () => Response;
}): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes(MINIMAX_HOST)) return routes.minimax();
    if (url.includes(GROK_HOST)) {
      if (!routes.grok) throw new Error(`unexpected grok call to ${url}`);
      return routes.grok();
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

Deno.test("minimaxChatWithFallback falls back to Grok when MiniMax returns 429 and XAI_API_KEY is configured", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () => new Response("rate limited", { status: 429 }),
    grok: () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "grok-answer" } }] }), {
        status: 200,
      }),
  });
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback({ user: "test" }, { grok: true });
    // Cascade succeeded on the fallback provider.
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "grok-answer");
    // The MiniMax 429 did NOT incorrectly surface as the final result.
    assertEquals(result.status, 200);
    // Proof the fallback provider was actually called: both hosts were hit,
    // MiniMax first, then Grok.
    assertEquals(calls.length, 2);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
    assertEquals(calls[1].includes(GROK_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback falls back to Grok when MiniMax throws network TypeError and XAI_API_KEY is configured", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  const fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes(MINIMAX_HOST)) throw new TypeError("error sending request: fetch failed");
    if (url.includes(GROK_HOST)) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "grok-after-network-fail" } }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback({ user: "test" }, { grok: true });
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "grok-after-network-fail");
    // Network error on MiniMax was caught and did not propagate as a throw.
    assertEquals(calls.length, 2);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
    assertEquals(calls[1].includes(GROK_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback does not call fallback when MiniMax succeeds", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "minimax-answer" } }] }), {
        status: 200,
      }),
    // No grok route: if the fallback were called, routingFetch throws.
  });
  try {
    globalThis.fetch = fetch;
    // Even with Grok "available", a MiniMax success must not trigger fallback.
    const result = await minimaxChatWithFallback({ user: "test" }, { grok: true });
    assertEquals(result.usedFallback, false);
    assertEquals(result.ok, true);
    assertEquals(result.content, "minimax-answer");
    // Proof: only MiniMax was hit; the fallback provider was never called.
    assertEquals(calls.length, 1);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
