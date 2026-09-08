// socialfetch_host_policy_test.ts — 2026-09-08 performance audit's SocialFetch
// host-routing fix. Production measured socialfetch_web_read systematically
// aborting at ~18.1-18.4s on t.me and youtube.com/youtu.be URLs — "YouTube and
// Telegram URLs are systematically fed to it and systematically abort" — while
// jina_reader_scrape read the SAME t.me pages successfully 7/7 times (avg 2.9s)
// in the identical window. socialfetchHostPolicy() is the deterministic,
// unit-testable routing decision that closes this; the second half of this file
// drives it through the REAL tool (mirrors jina_skiplist_test.ts's pattern) so
// the property that matters — "a doomed URL never hits the network for the full
// 18s" — is demonstrated end to end, not just at the predicate.
import "./_test_env_socialfetch_key.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTools,
  socialfetchHostPolicy,
  SOCIALFETCH_DEFAULT_TIMEOUT_MS,
  SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS,
  type ToolContext,
} from "./tool-registry.ts";

// ---- pure predicate --------------------------------------------------------

Deno.test("t.me is a SKIP, with a hint pointing at the proven-working alternative", () => {
  const decision = socialfetchHostPolicy("t.me");
  assertEquals(decision.action, "skip");
  assert(decision.action === "skip" && decision.hint.includes("jina_reader_scrape"));
});

Deno.test("a t.me SUBDOMAIN is also gated (endswith match, not exact-only)", () => {
  // Telegram does not commonly use subdomains of t.me, but the matcher must be
  // consistent with SOCIALFETCH_YOUTUBE_HOSTS below — pin the shared helper's
  // behavior explicitly rather than leaving it implicit.
  assertEquals(socialfetchHostPolicy("web.t.me").action, "skip");
});

Deno.test("youtube.com and youtu.be get the FAST timeout, not a skip", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]) {
    const decision = socialfetchHostPolicy(host);
    assertEquals(decision.action, "fast_timeout", host);
    assert(decision.action === "fast_timeout" && decision.timeoutMs === SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS, host);
  }
});

Deno.test("the youtube fast timeout is materially shorter than the default 18s", () => {
  assert(
    SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS < SOCIALFETCH_DEFAULT_TIMEOUT_MS,
    "the whole point of the fast path is to cut the tax below the default cap",
  );
});

Deno.test("an ordinary host is untouched — normal action, no policy applied", () => {
  for (const host of ["linkedin.com", "patreon.com", "creators.spotify.com", "example.com"]) {
    assertEquals(socialfetchHostPolicy(host).action, "normal", host);
  }
});

Deno.test("host matching does not false-positive on a lookalike domain", () => {
  // A domain that merely CONTAINS "t.me" or "youtube.com" as a substring must
  // not match — only an exact host or a genuine subdomain (endsWith '.host').
  assertEquals(socialfetchHostPolicy("nott.me.example.com").action, "normal");
  assertEquals(socialfetchHostPolicy("notyoutube.com.evil.test").action, "normal");
  assertEquals(socialfetchHostPolicy("fakeyoutube.com").action, "normal");
});

// ---- driven through the real tool (mirrors jina_skiplist_test.ts) ---------

function stubCtx(): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t-socialfetch",
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}
type ExecTool = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
function socialfetchWebRead(): ExecTool {
  const { tools } = buildTools(stubCtx());
  return (tools as Record<string, ExecTool>).socialfetch_web_read;
}

Deno.test("a t.me URL is skipped INSTANTLY, without hitting the network", async () => {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network must NOT be hit for a t.me URL");
  }) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    const r = await tool.execute({ url: "https://t.me/somechannel" }, {});
    assertEquals(r.skipped, true);
    assert(typeof r.hint === "string" && (r.hint as string).includes("jina_reader_scrape"));
    assertEquals(fetchCalls, 0, "no fetch may be issued for a t.me URL");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("a YouTube URL still reaches the network (fast timeout, not a skip)", async () => {
  const origFetch = globalThis.fetch;
  let hit = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    hit = String(input);
    return Promise.resolve(new Response(JSON.stringify({ data: "markdown" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    const r = await tool.execute({ url: "https://www.youtube.com/watch?v=abc123" }, {});
    assertEquals(r.skipped, undefined, "a fast-timeout host must still attempt the read");
    assert(hit.includes("youtube.com"), "the target URL must actually be forwarded");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("an ordinary host is unaffected by the policy — same behavior as before", async () => {
  const origFetch = globalThis.fetch;
  let hit = "";
  globalThis.fetch = ((input: string | URL | Request) => {
    hit = String(input);
    return Promise.resolve(new Response(JSON.stringify({ data: "markdown" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    const r = await tool.execute({ url: "https://www.linkedin.com/in/someone" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.skipped, undefined);
    assert(hit.includes("linkedin.com"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("an unparseable URL falls through to normal handling rather than throwing", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ data: "x" }), { status: 200 }))) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    const r = await tool.execute({ url: "not-a-valid-url" }, {});
    // Must not throw; whatever the underlying fetch does with a malformed URL
    // is unrelated to this policy — it must simply not crash the tool.
    assertEquals(typeof r, "object");
  } finally {
    globalThis.fetch = origFetch;
  }
});
