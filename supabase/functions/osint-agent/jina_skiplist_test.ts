import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { fetchRetry } from "./fetch_retry.ts";

// Regression guard for the Jina fail-fast fix (#247, verified in the Gemini PR):
//   (5a) the per-tool AbortSignal is forwarded into fetchRetry, and
//   (5b) always-blocked hosts (X/Twitter, Twitch, Instagram, Reddit, Facebook)
//        skip Jina INSTANTLY (no ~8s dead round-trip), returning a `skipped`
//        result — while staying valid targets for socialfetch_lookup/reddit_user.
// These live in tool-registry.ts; this test locks the behavior so a refactor
// can't silently reintroduce the timeout tax.

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t-jina",
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}
type ExecTool = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
function jina(): ExecTool {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, ExecTool>).jina_reader_scrape;
}

const BLOCKED = [
  "https://x.com/someone",
  "https://twitter.com/someone",
  "https://www.instagram.com/someone/",
  "https://www.twitch.tv/someone",
  "https://www.reddit.com/user/someone",
  "https://facebook.com/someone",
];

Deno.test("Fix #5b: always-blocked hosts skip Jina instantly WITHOUT hitting the network", async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls++; throw new Error("network must NOT be hit for a hard-blocked host"); }) as typeof fetch;
  try {
    const tool = jina();
    for (const url of BLOCKED) {
      const r = await tool.execute({ url }, {});
      assertEquals(r.skipped, true, `${url} must be skipped`);
      assertEquals(r.status, 451, `${url} must report the origin-block status`);
    }
    assertEquals(fetchCalls, 0, "no fetch may be issued for any blocked host");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("Fix #5b: a non-blocked host DOES reach Jina (skip is host-specific, not global)", async () => {
  const origFetch = globalThis.fetch;
  let hit = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    hit = String(input);
    return Promise.resolve(new Response("clean markdown", { status: 200 }));
  }) as typeof fetch;
  try {
    const tool = jina();
    const r = await tool.execute({ url: "https://example.com/article" }, {});
    assertEquals(r.ok, true);
    assert(hit.includes("r.jina.ai"), "a normal host must be scraped through r.jina.ai");
    assert(hit.includes("example.com"), "the target URL must be forwarded to Jina");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("Fix #5a: fetchRetry aborts on a pre-fired external signal, issuing no request", async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls++; return Promise.resolve(new Response("x")); }) as typeof fetch;
  const ctrl = new AbortController();
  ctrl.abort(); // outer per-tool timeout already fired
  try {
    let threw = false;
    try {
      await fetchRetry("https://r.jina.ai/https://example.com", { signal: ctrl.signal }, { retries: 2 });
    } catch (e) {
      threw = true;
      assert(e instanceof DOMException && e.name === "AbortError", "must throw AbortError, not spin");
    }
    assert(threw, "fetchRetry must reject when the outer signal is already aborted");
    assertEquals(fetchCalls, 0, "no request may be issued after the signal has fired");
  } finally {
    globalThis.fetch = origFetch;
  }
});
