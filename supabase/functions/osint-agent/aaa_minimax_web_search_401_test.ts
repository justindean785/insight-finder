// aaa_minimax_web_search_401_test.ts
//
// Regression: minimax_web_search must NOT leak Perplexity's raw 401/403 upstream
// body into tool output (live logs 2026-07-09 surfaced `perplexity 401: {...}` 5x
// to testers when PERPLEXITY_API_KEY was dead). The tool now logs the auth failure
// internally and returns a clean, empty "skipped" result so the orchestrator falls
// through to its other search tools. Non-auth failures (429/5xx) are UNCHANGED.
//
// env.ts captures PERPLEXITY_API_KEY at module-load, so it must be set (truthy)
// BEFORE the first import of env.ts (transitively tool-registry.ts) — otherwise the
// tool hits the absent-key early-return instead of the live-401 path. This file
// mirrors aaa_dork_harvest_test.ts: "aaa_" prefix to sort early + a DYNAMIC import
// after Deno.env.set (no static import that pulls env.ts).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("PERPLEXITY_API_KEY", "pplx-dead-key");

const { buildTools } = await import("./tool-registry.ts");

const PPLX = "api.perplexity.ai";
type Row = Record<string, unknown>;

function stubCtx() {
  const supabase = {
    from: (_t: string) => ({ insert: (_rows: Row[]) => Promise.resolve({ error: null }) }),
  };
  return {
    supabase, supabaseAdmin: supabase, userId: "t", threadId: "t-mws-401",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
}

function getTool(name: string) {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>)[name];
}

const RAW_401 = JSON.stringify({
  error: { message: "You didn't provide an API key. You need to provide your API key in an Authorization header.", type: "invalid_auth" },
});

Deno.test("minimax_web_search: perplexity 401 is swallowed — no '401' / no raw body / no 'perplexity' leaks", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(PPLX)) return new Response(RAW_401, { status: 401 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "alice@example.com breach" }, {});
    const s = JSON.stringify(res);
    assert(!s.includes("401"), `tool output must not contain "401": ${s}`);
    assert(!/api key/i.test(s), `raw upstream body must not leak: ${s}`);
    assert(!/perplexity/i.test(s), `provider error text must not leak: ${s}`);
    assertEquals(res.ok, false, "auth-failed search is not a success");
    assertEquals(res.skipped, true, "auth failure returns a clean skipped result");
    assertEquals(res.answer, "");
    assertEquals(res.citations, []);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("minimax_web_search: perplexity 403 is also swallowed", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(PPLX)) return new Response(RAW_401, { status: 403 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "test" }, {});
    assert(!JSON.stringify(res).includes("403"), "403 must not leak");
    assertEquals(res.skipped, true);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("minimax_web_search: a successful search preserves the answer + citations contract", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(PPLX)) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "- Alice Example is a developer\n- https://example.com/alice" } }],
        citations: ["https://example.com/alice", "https://news.example.org/story"],
      }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "Alice Example" }, {});
    assertEquals(res.ok, true, "valid key + real answer → success unchanged");
    assert(String(res.answer).includes("Alice Example"), "answer preserved");
    assertEquals((res.citations as string[]).length, 2, "citations preserved");
    assertEquals(res.skipped, undefined, "success is never marked skipped");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("minimax_web_search: transient 500 still surfaces status (non-auth path unchanged)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(PPLX)) return new Response("upstream boom", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const res = await getTool("minimax_web_search").execute({ query: "test" }, {});
    // 500 is transient (not a dead key) — the planner still uses status to decide
    // retry, so this path is intentionally unchanged.
    assertEquals(res.ok, false);
    assertEquals(res.status, 500);
    assertEquals(res.skipped, undefined, "non-auth failure is not a silent skip");
  } finally {
    globalThis.fetch = orig;
  }
});
