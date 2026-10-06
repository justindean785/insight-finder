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
import { isPreProviderGate } from "./runtime-policy.ts";
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

Deno.test("youtube/roblox/steam are SKIPS now — each points at its replacement", () => {
  // CHANGED 2026-09-30. These were fast_timeout (youtube) and normal
  // (roblox/steam). The original reasoning for youtube is quoted in the
  // tool-registry block: skip was rejected because "there is no proven-working
  // reader for them today", so a short attempt preserved the rare channel-About
  // page. That precondition is gone — youtube_oembed / roblox_user /
  // steam_profile now land the same facts keylessly — and the 14-day record says
  // the rare case never arrived: 0/10 youtube, 0/3 roblox, every steam attempt
  // aborted. Each hint must NAME its replacement, or the planner just stops
  // reading these hosts instead of reading them a better way.
  const cases: Array<[string, string]> = [
    ["youtube.com", "youtube_oembed"],
    ["www.youtube.com", "youtube_oembed"],
    ["m.youtube.com", "youtube_oembed"],
    ["youtu.be", "youtube_oembed"],
    ["roblox.com", "roblox_user"],
    ["www.roblox.com", "roblox_user"],
    ["steamcommunity.com", "steam_profile"],
  ];
  for (const [host, replacement] of cases) {
    const decision = socialfetchHostPolicy(host);
    assertEquals(decision.action, "skip", host);
    assert(
      decision.action === "skip" && decision.hint.includes(replacement),
      `${host} must name ${replacement} in its hint`,
    );
  }
});

Deno.test("jina-reachable slow hosts are skipped toward jina_reader_scrape", () => {
  for (const host of ["chess.com", "namemc.com", "gofundme.com", "scamadviser.com", "threads.net"]) {
    const decision = socialfetchHostPolicy(host);
    assertEquals(decision.action, "skip", host);
    assert(decision.action === "skip" && decision.hint.includes("jina_reader_scrape"), host);
  }
});

Deno.test("x.com / twitter.com are NOT routed to jina — jina hard-blocks them", () => {
  // The guard on a real defect in the change request that produced this commit:
  // both hosts were proposed for the jina-preferring list, and both are in
  // JINA_HARD_BLOCK_HOSTS. Routing them there hands them to a reader that
  // refuses them, leaving no reader at all — strictly worse than the 18s abort
  // they get today. Any future edit that adds them here must first give them a
  // reader that works.
  for (const host of ["x.com", "twitter.com", "www.x.com"]) {
    assertEquals(socialfetchHostPolicy(host).action, "normal", host);
  }
});

Deno.test("the fast-timeout mechanism is retained and still shorter than the default", () => {
  // No host selects fast_timeout after 2026-09-30, but the constant and the
  // branch stay: tool_timeout_caps_test.ts asserts the wrapper-above-internal
  // invariant against this value, and the shape is the right answer for the next
  // host that is slow-but-sometimes-works rather than never-works.
  assert(
    SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS < SOCIALFETCH_DEFAULT_TIMEOUT_MS,
    "a fast path that is not shorter than the default cap is not a fast path",
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

Deno.test("a YouTube URL costs ZERO network and zero credits now", async () => {
  // The measured waste this commit removes: every youtube read burned ~6.5s of a
  // 180s invocation budget and returned nothing, 10 times out of 10.
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network must NOT be hit for a youtube URL");
  }) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    const r = await tool.execute({ url: "https://www.youtube.com/watch?v=abc123" }, {});
    assertEquals(r.skipped, true);
    assert(typeof r.hint === "string" && (r.hint as string).includes("youtube_oembed"));
    assertEquals(fetchCalls, 0, "a skipped host must not issue a request, so it cannot spend a credit");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("an ordinary host is unaffected by the policy — same behavior as before", async () => {
  const origFetch = globalThis.fetch;
  let hit = "";
  // FIXTURE WIDENED 2026-09-30. This used to return the 8-char body "markdown",
  // which the empty-body guard added in the same commit now correctly rejects as
  // an interstitial rather than a page. The guard is the intended behaviour —
  // socialfetch_fallback_test.ts asserts a short body IS refused — so the fixture
  // becomes a realistic page instead of the threshold being lowered to suit it.
  const page = "a realistic page body ".repeat(20);
  globalThis.fetch = ((input: string | URL | Request) => {
    hit = String(input);
    return Promise.resolve(new Response(JSON.stringify({ data: page }), { status: 200 }));
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

// ---------------------------------------------------------------------------
// Review findings on this branch (Codex, 2026-10-01). Both are the same shape:
// the skip saves the right thing in one dimension and silently fails to save it
// in another, and nothing in the suite noticed.
// ---------------------------------------------------------------------------

Deno.test("a host-policy skip releases the PAID-CALL SLOT, not just the seconds", async () => {
  // `startCall` reserves a paid slot at admission; cache.ts releases it ONLY on
  // the structural `provider_attempted: false` marker — never on `skipped`,
  // which also covers rate-limits, 5xx and timeouts that really did spend. A
  // skip without the marker still burned one of the run's 12 paid calls on a
  // lookup it never performed, so repeated YouTube/Roblox/Steam URLs could
  // exhaust the budget and force early finalization having fetched nothing.
  const origFetch = globalThis.fetch;
  let networkHits = 0;
  globalThis.fetch = (() => {
    networkHits++;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const tool = socialfetchWebRead();
    for (
      const url of [
        "https://www.youtube.com/watch?v=abc",
        "https://www.roblox.com/users/1/profile",
        "https://steamcommunity.com/id/someone",
        "https://t.me/somechannel",
        "https://www.chess.com/member/someone",
      ]
    ) {
      const r = await tool.execute({ url }, {});
      assertEquals(r.skipped, true, url);
      assertEquals(r.failure_class, "host_unsupported", url);
      assertEquals(
        isPreProviderGate(r),
        true,
        `${url}: the skip must carry provider_attempted:false or the paid slot is never refunded`,
      );
    }
    assertEquals(networkHits, 0, "a skip must issue no request at all");
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("every tool a skip hint NAMES is on the live planner menu", () => {
  // The hint is the whole value of the skip: it tells the planner where to go
  // instead. A hint naming a tool the planner cannot select routes the pivot
  // nowhere, which is strictly worse than the slow failure it replaced.
  //
  // This is NOT the list in tools/minimax.ts — nothing imports that file, so
  // the names added there were dead. `buildTools()` defines its own inline
  // `baseToolList` in tool-registry.ts and that is the one that ships; the
  // negative control below fails if this test is ever pointed back at the
  // dead copy.
  const src = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));
  const start = src.indexOf("const baseToolList = [");
  assert(start > 0, "inline baseToolList not found — buildTools() shape changed");
  const list = src.slice(start, src.indexOf("];", start));
  assert(
    !list.includes("intelbase_email_lookup"),
    "negative control: this is the dead tools/minimax.ts list, not the live one",
  );

  const hosts = [
    "www.youtube.com",
    "youtu.be",
    "www.roblox.com",
    "steamcommunity.com",
    "t.me",
    "www.chess.com",
    "namemc.com",
    "www.gofundme.com",
    "www.scamadviser.com",
    "www.threads.net",
  ];
  const named = new Set<string>();
  for (const h of hosts) {
    const d = socialfetchHostPolicy(h);
    assertEquals(d.action, "skip", h);
    if (d.action !== "skip") continue;
    // Drop `{ ... }` argument illustrations first — `roblox_user { user_id }`
    // would otherwise contribute `user_id` as if it were a tool name.
    const prose = d.hint.replace(/\{[^}]*\}/g, " ");
    for (const m of prose.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      // The hint names the failing tool too; only the replacements matter.
      if (m[1] !== "socialfetch_web_read") named.add(m[1]);
    }
  }
  assert(named.size >= 4, `expected several named replacements, got ${[...named].join(", ")}`);
  for (const t of named) {
    assert(
      list.includes(`"${t}"`),
      `skip hints name ${t} but the live planner baseToolList cannot propose it`,
    );
  }
});
