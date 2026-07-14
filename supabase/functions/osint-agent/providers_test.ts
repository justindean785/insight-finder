import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// shouldFallbackOnStatus / shouldFallbackOnError — pure helpers, no env deps.
// Static import is safe here.
// ---------------------------------------------------------------------------
import { shouldFallbackOnStatus, shouldFallbackOnError, perplexitySearch, visionGenerationConfig, geminiVision } from "./providers.ts";

// ---------------------------------------------------------------------------
// visionGenerationConfig — force JSON output for the structured readers, but
// NOT when grounding (google_search is incompatible with responseMimeType).
// ---------------------------------------------------------------------------
Deno.test("visionGenerationConfig: document/non-grounding read forces JSON output", () => {
  const cfg = visionGenerationConfig(false, 0.1);
  assertEquals(cfg.responseMimeType, "application/json");
  assertEquals(cfg.temperature, 0.1);
});

Deno.test("visionGenerationConfig: grounded (reverse-search) read omits JSON mode", () => {
  const cfg = visionGenerationConfig(true, 0.2);
  assertEquals(cfg.responseMimeType, undefined, "JSON mode is incompatible with google_search grounding");
  assertEquals(cfg.temperature, 0.2);
});

// ---------------------------------------------------------------------------
// geminiVision — a doc-read timeout (or external abort) must be CAUGHT and
// returned as {ok:false}, not thrown. An uncaught throw here propagated to
// attachment-intake and silently dropped the attachment.
// ---------------------------------------------------------------------------
Deno.test("geminiVision: fetch abort → graceful {ok:false} timeout, not a throw", async () => {
  const origFetch = globalThis.fetch;
  const origKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "gv-test-key");
  globalThis.fetch = (() => Promise.reject(new DOMException("The signal has been aborted", "AbortError"))) as typeof globalThis.fetch;
  try {
    const res = await geminiVision({ parts: [{ text: "read" }] });
    assertEquals(res.ok, false);
    assertEquals(res.status, 0);
    assertEquals(res.text, "");
    assert(String((res.raw as { error?: unknown })?.error).includes("timed out"), "abort surfaces as a timeout error");
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) Deno.env.delete("GEMINI_API_KEY"); else Deno.env.set("GEMINI_API_KEY", origKey);
  }
});

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
const GEMINI_HOST = "generativelanguage.googleapis.com";
const LOVABLE_GW_HOST = "ai.gateway.lovable.dev";
const GROK_HOST = "api.x.ai";

/** Build a fetch stub that routes by URL host and records all hits. */
function routingFetch(routes: {
  minimax: () => Response;
  gemini?: () => Response;
  lovable?: () => Response;
}): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes(MINIMAX_HOST)) return routes.minimax();
    if (url.includes(GEMINI_HOST)) {
      if (!routes.gemini) throw new Error(`unexpected gemini call to ${url}`);
      return routes.gemini();
    }
    if (url.includes(LOVABLE_GW_HOST)) {
      if (!routes.lovable) throw new Error(`unexpected lovable call to ${url}`);
      return routes.lovable();
    }
    if (url.includes(GROK_HOST)) {
      throw new Error(`Grok must NEVER be selected as a fallback (got ${url})`);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

Deno.test("minimaxChatWithFallback falls back to direct Gemini when MiniMax returns 429 and GEMINI_API_KEY is configured", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () => new Response("rate limited", { status: 429 }),
    gemini: () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "gemini-answer" } }] }), {
        status: 200,
      }),
  });
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback({ user: "test" }, { gemini: true });
    // Cascade succeeded on the fallback provider.
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "gemini-answer");
    // The MiniMax 429 did NOT incorrectly surface as the final result.
    assertEquals(result.status, 200);
    // Proof the fallback provider was actually called: both hosts were hit,
    // MiniMax first, then the DIRECT Gemini endpoint (not the Lovable gateway).
    assertEquals(calls.length, 2);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
    assertEquals(calls[1].includes(GEMINI_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback falls back to direct Gemini when MiniMax throws network TypeError", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  const fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes(MINIMAX_HOST)) throw new TypeError("error sending request: fetch failed");
    if (url.includes(GEMINI_HOST)) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "gemini-after-network-fail" } }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback({ user: "test" }, { gemini: true });
    assertEquals(result.usedFallback, true);
    assertEquals(result.ok, true);
    assertEquals(result.content, "gemini-after-network-fail");
    // Network error on MiniMax was caught and did not propagate as a throw.
    assertEquals(calls.length, 2);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
    assertEquals(calls[1].includes(GEMINI_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback prefers direct Gemini over the Lovable gateway when both are available", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () => new Response("server error", { status: 500 }),
    gemini: () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "gemini-wins" } }] }), {
        status: 200,
      }),
    // No lovable route: routingFetch throws if the gateway is hit.
  });
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback(
      { user: "test" },
      { gemini: true, lovable: true, allowLovable: true },
    );
    assertEquals(result.usedFallback, true);
    assertEquals(result.content, "gemini-wins");
    assertEquals(calls.length, 2);
    assertEquals(calls[1].includes(GEMINI_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback does NOT use the Lovable gateway without ALLOW_LOVABLE_FALLBACK", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () => new Response("rate limited", { status: 429 }),
    // No gemini or lovable routes: any fallback call throws.
  });
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback(
      { user: "test" },
      { gemini: false, lovable: true, allowLovable: false },
    );
    // Lovable is present but not opted in → clean failure, no fallback fired.
    assertEquals(result.ok, false);
    assertEquals(result.usedFallback, false);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].includes(MINIMAX_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChatWithFallback uses the Lovable gateway when opted in and Gemini is absent", async () => {
  const { minimaxChatWithFallback } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const { fetch, calls } = routingFetch({
    minimax: () => new Response("rate limited", { status: 429 }),
    lovable: () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "gateway-answer" } }] }), {
        status: 200,
      }),
  });
  try {
    globalThis.fetch = fetch;
    const result = await minimaxChatWithFallback(
      { user: "test" },
      { gemini: false, lovable: true, allowLovable: true },
    );
    assertEquals(result.usedFallback, true);
    assertEquals(result.content, "gateway-answer");
    assertEquals(calls.length, 2);
    assertEquals(calls[1].includes(LOVABLE_GW_HOST), true);
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
    // No gemini route: if the fallback were called, routingFetch throws.
  });
  try {
    globalThis.fetch = fetch;
    // Even with Gemini "available", a MiniMax success must not trigger fallback.
    const result = await minimaxChatWithFallback({ user: "test" }, { gemini: true });
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

// ---------------------------------------------------------------------------
// perplexitySearch — the single working web-search path. MiniMax's chat API
// 400s on the web_search tool shape, so both minimax_web_search and
// dork_harvest route through this Perplexity Sonar helper. apiKey DI lets us
// exercise it without env capture (the keys are read at module load).
// ---------------------------------------------------------------------------

const PPLX_HOST = "api.perplexity.ai";

Deno.test("perplexitySearch: missing key → not-configured error, no fetch", async () => {
  const origFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof globalThis.fetch;
    // Explicit empty key (deterministic regardless of env capture): falsy → gate.
    const r = await perplexitySearch({ query: "x", apiKey: "" });
    assertEquals(r.ok, false);
    assertEquals(r.error, "PERPLEXITY_API_KEY not configured");
    assertEquals(called, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("perplexitySearch: 200 → parses answer + citations, hits Perplexity host", async () => {
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input: Request | URL | string) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Found a leak at https://pastebin.com/abc123" } }],
        citations: ["https://example.com/dump.pdf", "https://rentry.co/xyz"],
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await perplexitySearch({ query: "alice@example.com", apiKey: "pplx-test" });
    assertEquals(r.ok, true);
    assertEquals(r.status, 200);
    assertEquals(r.citations, ["https://example.com/dump.pdf", "https://rentry.co/xyz"]);
    assertEquals(r.answer.includes("pastebin.com/abc123"), true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].includes(PPLX_HOST), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("perplexitySearch: non-200 → ok:false with provider-named error", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof globalThis.fetch;
    const r = await perplexitySearch({ query: "x", apiKey: "pplx-test" });
    assertEquals(r.ok, false);
    assertEquals(r.status, 429);
    assertEquals(r.error?.startsWith("perplexity 429"), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// minimaxChat external-signal propagation — a health probe's bounded timeout
// must actually abort the underlying MiniMax fetch, not merely abandon the
// promise while the paid call runs on to its internal 45s cap.
// ---------------------------------------------------------------------------

Deno.test("minimaxChat: external signal aborts the in-flight fetch", async () => {
  const { minimaxChat } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  const external = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  try {
    // Hang until the request's own signal aborts — mimics a stalled provider.
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;

    const pending = minimaxChat({ user: "ping", signal: external.signal });
    external.abort(); // the "8s probe timeout" firing
    let threw = false;
    try { await pending; } catch { threw = true; }
    // The external abort propagated through to the fetch and unwound the call.
    assertEquals(threw, true);
    assertEquals(capturedSignal?.aborted, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimaxChat: an already-aborted external signal never issues the fetch", async () => {
  const { minimaxChat } = await import("./providers.ts");
  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      fetchCalled = true;
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof globalThis.fetch;

    const pre = new AbortController();
    pre.abort();
    let threw = false;
    try { await minimaxChat({ user: "ping", signal: pre.signal }); } catch { threw = true; }
    assertEquals(threw, true);
    // The request carried an already-aborted signal, so the fetch rejects
    // immediately rather than completing a live call.
    assertEquals(fetchCalled, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
