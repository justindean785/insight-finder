// Regression: minimax_web_search must NOT leak Perplexity's raw 401/403 upstream
// error body into tool output. Live logs (2026-07-09) surfaced 5× `perplexity
// 401: {"error":{"message":"You...` to testers when PERPLEXITY_API_KEY was dead.
// The tool now logs the auth failure internally and returns a clean, empty
// "skipped" result so the orchestrator falls through to its other search tools.
//
// PERPLEXITY_API_KEY is captured at import time (env.ts), so it must be set
// BEFORE the dynamic buildTools import — present-but-dead here, to exercise the
// live-401 path (not the absent-key early return).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("PERPLEXITY_API_KEY", "pplx-dead-key");

const { buildTools } = await import("./tool-registry.ts");

type AnyRec = Record<string, unknown>;

function stubCtx() {
  const supabase = {
    from: (_t: string) => ({ insert: (_rows: AnyRec[]) => Promise.resolve({ error: null }) }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "u", threadId: "t-mws-401",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}

function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>)[name];
}

const RAW_401_BODY = JSON.stringify({
  error: { message: "You didn't provide an API key. You need to provide your API key in an Authorization header.", type: "invalid_auth" },
});

Deno.test("minimax_web_search: perplexity 401 is swallowed — no '401' / no raw body leaks", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("api.perplexity.ai")) return new Response(RAW_401_BODY, { status: 401 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "alice@example.com breach" }, {}) as AnyRec;
    const serialized = JSON.stringify(res);
    assert(!serialized.includes("401"), `tool output must not contain "401": ${serialized}`);
    assert(!serialized.toLowerCase().includes("api key"), `raw upstream body must not leak: ${serialized}`);
    assert(!/perplexity/i.test(serialized), `provider error text must not leak: ${serialized}`);
    assertEquals(res.ok, false, "auth-failed search is not a success");
    assertEquals(res.skipped, true, "auth failure returns a clean skipped result");
    assertEquals(res.answer, "");
    assertEquals(res.citations, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimax_web_search: perplexity 403 is also swallowed", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("api.perplexity.ai")) return new Response(RAW_401_BODY, { status: 403 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "test" }, {}) as AnyRec;
    assert(!JSON.stringify(res).includes("403"), "403 must not leak");
    assertEquals(res.skipped, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimax_web_search: a successful search preserves the answer+citations contract", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("api.perplexity.ai")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "- Alice Example is a developer\n- https://example.com/alice" } }],
        citations: ["https://example.com/alice", "https://news.example.org/story"],
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "Alice Example" }, {}) as AnyRec;
    assertEquals(res.ok, true, "valid key + real answer → success unchanged");
    assert(String(res.answer).includes("Alice Example"), "answer preserved");
    assertEquals((res.citations as string[]).length, 2, "citations preserved");
    assertEquals(res.skipped, undefined, "success is never marked skipped");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("minimax_web_search: transient 500 still surfaces status (non-auth path unchanged)", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("api.perplexity.ai")) return new Response("upstream boom", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "test" }, {}) as AnyRec;
    // 500 is transient (not a dead key) — the planner still uses status to decide
    // retry, so this path is intentionally unchanged.
    assertEquals(res.ok, false);
    assertEquals(res.status, 500);
    assertEquals(res.skipped, undefined, "non-auth failure is not a silent skip");
  } finally {
    globalThis.fetch = origFetch;
  }
});
