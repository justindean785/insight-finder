// media_leads_test.ts — the first hop of the GeoSeer chain.
//
// Measured 2026-10-18: 276 cases used a social or scrape tool, 48 ran gemini_vision,
// geoseer_geolocate fired once. lib/media-leads.ts hands the model the image URLs a
// scrape/profile result already contains. These tests DRIVE the shipped wrapper and
// extractor; the wiring tests read the real source files so a dropped call site fails.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachMediaLeads,
  extractMediaLeads,
  MAX_MEDIA_LEADS,
  MEDIA_LEAD_SOURCE_TOOLS,
  MEDIA_LEADS_NOTE,
  mediaLeadsDisabled,
  mediaLeadsSelfTest,
  wrapToolsWithMediaLeads,
} from "../../../functions/osint-agent/lib/media-leads.ts";
import { extractFindings } from "../../../functions/osint-agent/auto-persist-findings.ts";

const read = (p: string) => Deno.readTextFile(new URL(`../../../functions/osint-agent/${p}`, import.meta.url));
const INDEX = await read("index.ts");
const HEALTH = await read("health-handler.ts");
const PROMPT = await read("system-prompt.ts");
const REGISTRY = await read("tool-registry.ts");

// ── extraction ───────────────────────────────────────────────────────────────

Deno.test("extract: markdown image, bare URL and a keyed avatar; content ranks before the avatar", () => {
  const leads = extractMediaLeads("socialfetch_lookup", {
    content:
      "Profile page. ![Image 1: hike](https://scontent.example.com/v/t51/trail.jpg?sig=abc) and https://cdn.example.com/post/storefront.png.",
    profile_pic_url: "https://cdn.example.com/av/me",
  });
  assertEquals(
    leads.map((l) => [l.kind, l.url, l.geolocation_candidate]),
    [
      ["content", "https://scontent.example.com/v/t51/trail.jpg?sig=abc", true],
      ["content", "https://cdn.example.com/post/storefront.png", true],
      ["avatar", "https://cdn.example.com/av/me", false],
    ],
  );
  assert(leads.every((l) => l.source_tool === "socialfetch_lookup"));
});

Deno.test("extract: camelCase provider keys are understood", () => {
  const leads = extractMediaLeads("socialfetch_lookup", {
    data: { profilePicUrl: "https://cdn.example.com/p/1", displayUrl: "https://cdn.example.com/p/2" },
  });
  assertEquals(leads.map((l) => [l.kind, l.url]), [
    ["content", "https://cdn.example.com/p/2"],
    ["avatar", "https://cdn.example.com/p/1"],
  ]);
});

Deno.test("extract: icons, vectors, animations, trackers and non-public hosts never become leads", () => {
  const junk = [
    "![](https://x.example.com/favicon.ico)",
    "![](https://x.example.com/img/logo.png)",
    "![](https://x.example.com/img/sprite-1.png)",
    "![](https://x.example.com/art/banner.svg)",
    "![](https://x.example.com/loop.gif)",
    "![](https://www.facebook.com/tr?id=1&ev=PageView)",
    "![](https://x.example.com/img/default_avatar.png)",
    "![](http://localhost/a.jpg)",
    "![](http://192.168.1.5/a.jpg)",
    "![](http://10.0.0.1/a.jpg)",
    "![](http://169.254.169.254/a.jpg)",
    "![](http://172.16.0.9/a.jpg)",
    "![](http://[::1]/a.jpg)",
    "![](http://db.internal/a.jpg)",
  ].join("\n");
  const leads = extractMediaLeads("jina_reader_scrape", { content: `${junk}\n![ok](https://cdn.example.com/real/photo.jpg)` });
  assertEquals(leads.map((l) => l.url), ["https://cdn.example.com/real/photo.jpg"]);
});

Deno.test("extract: the same picture as an avatar and as a post image is one content lead", () => {
  const leads = extractMediaLeads("socialfetch_lookup", {
    avatar_url: "https://cdn.example.com/u/9/pic.jpg?size=50",
    posts: [{ image_url: "https://cdn.example.com/u/9/pic.jpg?size=800" }],
  });
  assertEquals(leads.length, 1);
  assertEquals(leads[0].kind, "content");
  assertEquals(leads[0].geolocation_candidate, true);
});

Deno.test("extract: capped at MAX_MEDIA_LEADS, content images kept ahead of avatars", () => {
  const posts = Array.from({ length: 8 }, (_, i) => ({ image_url: `https://cdn.example.com/p/${i}.jpg` }));
  const leads = extractMediaLeads("socialfetch_lookup", { avatar_url: "https://cdn.example.com/av/1", avatar2: "https://cdn.example.com/av/2.jpg", posts });
  assertEquals(leads.length, MAX_MEDIA_LEADS);
  assert(leads.every((l) => l.kind === "content"));
});

Deno.test("extract: a cyclic or very deep result neither throws nor hangs", () => {
  const a: Record<string, unknown> = { image_url: "https://cdn.example.com/c.jpg" };
  a.self = a;
  assertEquals(extractMediaLeads("github_user", a).length, 1);
  let deep: Record<string, unknown> = { image_url: "https://cdn.example.com/deep.jpg" };
  for (let i = 0; i < 50; i++) deep = { child: deep };
  assertEquals(extractMediaLeads("github_user", deep), []);
});

// ── attach ───────────────────────────────────────────────────────────────────

Deno.test("attach: every original key survives untouched; only the two new keys are added", () => {
  const original = { ok: true, url: "https://x.example/", content: "![a](https://cdn.example.com/a.jpg)", n: 3, nested: { k: [1, 2] } };
  const out = attachMediaLeads("jina_reader_scrape", structuredClone(original)) as Record<string, unknown>;
  const { media_leads, media_leads_note, ...rest } = out;
  assertEquals(rest, original);
  assertEquals((media_leads as unknown[]).length, 1);
  assertEquals(media_leads_note, MEDIA_LEADS_NOTE);
});

Deno.test("attach: anything that is not a mineable object comes back as the very same value", () => {
  const withImg = { content: "![a](https://cdn.example.com/a.jpg)" };
  const cases: Array<[string, unknown]> = [
    ["whois_lookup", withImg], // not a source tool
    ["jina_reader_scrape", [withImg]], // array
    ["jina_reader_scrape", "![a](https://cdn.example.com/a.jpg)"], // string
    ["jina_reader_scrape", null],
    ["jina_reader_scrape", { ...withImg, skipped: true }],
    ["jina_reader_scrape", { ...withImg, found: false }],
    ["jina_reader_scrape", { error: "jina 500", url: "https://x.example/" }], // nothing to mine
    ["jina_reader_scrape", { ...withImg, media_leads: [] }], // idempotent
  ];
  for (const [tool, value] of cases) assert(attachMediaLeads(tool, value) === value, `${tool} ${JSON.stringify(value)}`);
  const stream = { async *[Symbol.asyncIterator]() { yield 1; }, content: "![a](https://cdn.example.com/a.jpg)" };
  assert(attachMediaLeads("jina_reader_scrape", stream) === stream, "a streaming result is never touched");
});

Deno.test("attach: a Gravatar 'not found' carries no lead, a hit carries one avatar", () => {
  const miss = { ok: true, found: false, hash: "abc", avatar_url: "https://gravatar.com/avatar/abc" };
  assert(attachMediaLeads("gravatar_profile", miss) === miss);
  const hit = attachMediaLeads("gravatar_profile", { ok: true, found: true, hash: "abc", avatar_url: "https://gravatar.com/avatar/abc" }) as Record<string, unknown>;
  const leads = hit.media_leads as Array<{ kind: string; geolocation_candidate: boolean }>;
  assertEquals(leads.map((l) => [l.kind, l.geolocation_candidate]), [["avatar", false]]);
});

// ── wrapper (drives the shipped execute path) ────────────────────────────────

type FakeTool = { description?: string; inputSchema?: unknown; execute?: (i: unknown, o: unknown) => Promise<unknown> };

Deno.test("wrapper: source tools gain media_leads; other tools and execute-less tools are the same objects", async () => {
  const seen: unknown[] = [];
  const tools: Record<string, FakeTool> = {
    jina_reader_scrape: {
      description: "d",
      inputSchema: { x: 1 },
      execute: async (i, o) => {
        seen.push(i, o);
        return { ok: true, content: "![a](https://cdn.example.com/a.jpg)" };
      },
    },
    whois_lookup: { execute: async () => ({ ok: true, content: "![a](https://cdn.example.com/a.jpg)" }) },
    steam_profile: { description: "no execute" },
  };
  const wrapped = wrapToolsWithMediaLeads(tools, () => undefined);
  assert(wrapped.whois_lookup === tools.whois_lookup);
  assert(wrapped.steam_profile === tools.steam_profile);
  assertEquals(wrapped.jina_reader_scrape.description, "d");
  assertEquals(wrapped.jina_reader_scrape.inputSchema, { x: 1 });
  const input = { url: "https://x.example/" };
  const opts = { abortSignal: new AbortController().signal };
  const res = await wrapped.jina_reader_scrape.execute!(input, opts) as Record<string, unknown>;
  assertEquals((res.media_leads as unknown[]).length, 1);
  assert(seen[0] === input && seen[1] === opts, "input and options reach the original tool untouched");
});

Deno.test("wrapper: MEDIA_LEADS_DISABLED is read on every call, and an original throw still propagates", async () => {
  let disabled = "";
  const env = (k: string) => (k === "MEDIA_LEADS_DISABLED" ? disabled : undefined);
  const tools: Record<string, FakeTool> = {
    jina_reader_scrape: { execute: async () => ({ ok: true, content: "![a](https://cdn.example.com/a.jpg)" }) },
    reddit_user: { execute: async () => { throw new Error("boom"); } },
  };
  const wrapped = wrapToolsWithMediaLeads(tools, env);
  assert("media_leads" in (await wrapped.jina_reader_scrape.execute!({}, {}) as object));
  disabled = "true";
  assertEquals(await wrapped.jina_reader_scrape.execute!({}, {}), { ok: true, content: "![a](https://cdn.example.com/a.jpg)" });
  disabled = "";
  assert("media_leads" in (await wrapped.jina_reader_scrape.execute!({}, {}) as object));
  await assertRejects(() => wrapped.reddit_user.execute!({}, {}), Error, "boom");
});

// ── it must not change a single evidence row ─────────────────────────────────

Deno.test("evidence: extractFindings returns the same rows with and without media_leads", () => {
  // github_user reads `user.*` + `repos`; socialfetch_lookup reads `data.profile.*` (auto-persist-findings.ts).
  // jina_reader_scrape and gravatar_profile are included so the claim covers every source shape, but they are
  // not what makes this test non-vacuous: jina is on AUTO_PERSIST_TOOL_DENYLIST and never yields rows.
  const cases: Array<{ tool: string; input: unknown; output: Record<string, unknown>; opts?: { escalated?: boolean }; mustYield: boolean }> = [
    {
      tool: "github_user",
      input: { username: "jvale" },
      mustYield: true,
      output: {
        user: {
          login: "jvale",
          html_url: "https://github.com/jvale",
          blog: "https://jvale.example",
          email: "jvale@example.com",
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        },
        repos: [{ url: "https://github.com/jvale/trail-maps" }],
      },
    },
    {
      tool: "socialfetch_lookup",
      input: { platform: "instagram", username: "jvale" },
      mustYield: true,
      output: {
        data: {
          profile: {
            url: "https://example.social/jvale",
            username: "jvale",
            profile_pic_url: "https://cdn.example.com/p/jvale.jpg",
            recent_posts: [{ display_url: "https://cdn.example.com/p/post1.jpg" }],
          },
        },
      },
    },
    {
      tool: "jina_reader_scrape",
      input: { url: "https://example.com/about" },
      mustYield: false,
      output: {
        ok: true,
        url: "https://example.com/about",
        title: "Jordan Vale",
        content: "Jordan Vale. Contact jvale@example.com. ![me](https://cdn.example.com/me/trail.jpg)",
      },
    },
    {
      tool: "jina_reader_scrape",
      input: { url: "https://example.com/about" },
      opts: { escalated: true },
      mustYield: false,
      output: {
        ok: true,
        url: "https://example.com/about",
        title: "Jordan Vale",
        content: "Jordan Vale. Contact jvale@example.com. ![me](https://cdn.example.com/me/trail.jpg)",
      },
    },
    {
      tool: "gravatar_profile",
      input: { email: "jvale@example.com" },
      mustYield: false,
      output: { ok: true, found: true, hash: "abc", avatar_url: "https://gravatar.com/avatar/abc", data: { display_name: "Jordan Vale" } },
    },
  ];
  for (const c of cases) {
    const withLeads = attachMediaLeads(c.tool, structuredClone(c.output)) as Record<string, unknown>;
    assert("media_leads" in withLeads, `${c.tool}: fixture must actually produce leads`);
    const before = extractFindings(c.tool, c.output, c.input, undefined, c.opts);
    const after = extractFindings(c.tool, withLeads, c.input, undefined, c.opts);
    assertEquals(after, before, `${c.tool}${c.opts?.escalated ? " (escalated)" : ""}`);
    if (c.mustYield) assert(before.length > 0, `${c.tool}: fixture must yield findings or this proves nothing`);
  }
});

// ── wiring: a dropped call site must fail loudly ─────────────────────────────

Deno.test("wiring: index.ts applies the wrapper OUTSIDE wrapToolsWithCache", () => {
  assert(/import \{ wrapToolsWithMediaLeads \} from "\.\/lib\/media-leads\.ts";/.test(INDEX));
  assert(/wrapToolsWithMediaLeads\(\s*wrapToolsWithCache\(/.test(INDEX), "must wrap the cache-wrapped set, not the raw one");
  assertEquals((INDEX.match(/wrapToolsWithCache\(/g) ?? []).length, 1, "a second un-wrapped call site would bypass media leads");
});

Deno.test("wiring: /health reports checks.media_leads and the prompt tells the model what the field is", () => {
  assert(HEALTH.includes("r.checks.media_leads = mediaLeadsSelfTest();"));
  // system-prompt.ts is a template literal, so its source escapes backticks as \`.
  assert(PROMPT.includes("media_leads"));
});

Deno.test("wiring: every source tool is a real registered tool, and the note names real tools", () => {
  for (const name of MEDIA_LEAD_SOURCE_TOOLS) {
    assert(new RegExp(`\\b${name}: tool\\(`).test(REGISTRY), `${name} is not defined in tool-registry.ts`);
  }
  for (const name of ["gemini_vision", "geoseer_geolocate"]) {
    assert(MEDIA_LEADS_NOTE.includes(name));
    assert(REGISTRY.includes(name), `${name} missing from tool-registry.ts`);
  }
});

Deno.test("self-test: passes, and reports the kill switch", () => {
  const on = mediaLeadsSelfTest(() => undefined);
  assertEquals([on.ok, on.enabled], [true, true]);
  assertEquals(mediaLeadsSelfTest((k) => (k === "MEDIA_LEADS_DISABLED" ? "true" : undefined)).enabled, false);
  assertEquals(mediaLeadsDisabled(() => " TRUE "), true);
  assertEquals(mediaLeadsDisabled(() => undefined), false);
});
