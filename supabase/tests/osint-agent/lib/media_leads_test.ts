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
  MEDIA_LEADS_UNLINKED_NOTE,
  mediaLeadsDisabled,
  mediaLeadsSelfTest,
  UNPROVEN_LINKAGE_RUNTIME_KEY,
  wrapToolsWithMediaLeads,
} from "../../../functions/osint-agent/lib/media-leads.ts";
import { UNPROVEN_LINKAGE_KEY, unprovenLinkageMarker } from "../../../functions/osint-agent/lib/unproven-linkage.ts";
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

// ── the real socialfetch_lookup shape (synthetic values, production key names) ─
//
// Measured 2026-10-18 on tool_call_cache: socialfetch_lookup rows carry
// data.profile.{avatarUrl, avatarUrlHd} and data.recentPosts[].{displayUrl, thumbnailUrl,
// videoUrl, location:{lat,lng,name}, takenAt}. Instagram CDN URLs end in .jpg, which is
// what exposed two defects the synthetic fixtures above could not: an avatar URL being
// re-scanned as free text and promoted to a "content" image, and thumbnails eating the
// six-lead cap.

const cdn = (p: string) => `https://scontent-sjc.cdninstagram.com/v/t51.2885-15/${p}.jpg?stp=dst-jpg&oe=6a1b2c3d`;
const post = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  caption: `post ${n}`,
  displayUrl: cdn(`full${n}`),
  thumbnailUrl: cdn(`thumb${n}`),
  videoUrl: `https://scontent-sjc.cdninstagram.com/o1/v/t16/clip${n}.mp4`,
  ...extra,
});
const igProfile = (posts: unknown[]) => ({
  ok: true,
  data: {
    profile: { handle: "jvale", avatarUrl: cdn("av_small"), avatarUrlHd: cdn("av_hd"), profileUrl: "https://www.instagram.com/jvale/" },
    recentPosts: posts,
  },
});

Deno.test("real shape: an avatar URL that ends in .jpg stays an avatar", () => {
  const leads = extractMediaLeads("socialfetch_lookup", igProfile([post(1)]));
  const av = leads.find((l) => l.url.includes("av_hd"));
  assert(av, "the avatar is still listed, as its large variant");
  assertEquals(leads.filter((l) => l.kind === "avatar").length, 1, "two sizes of one avatar are one lead");
  assertEquals([av.kind, av.geolocation_candidate], ["avatar", false]);
  assertEquals(leads.filter((l) => l.kind === "content").map((l) => l.url), [cdn("full1")]);
});

Deno.test("real shape: a post lists its full-size picture, not its thumbnail; a lone thumbnail is kept", () => {
  const leads = extractMediaLeads("socialfetch_lookup", igProfile([post(1), { id: "p2", thumbnailUrl: cdn("only_thumb") }]));
  const content = leads.filter((l) => l.kind === "content").map((l) => l.url);
  assertEquals(content, [cdn("full1"), cdn("only_thumb")]);
  assert(!leads.some((l) => l.url.includes("thumb1")), "the thumbnail of a post that has a full-size picture is dropped");
  assert(!leads.some((l) => l.url.endsWith(".mp4") || l.url.includes("clip")), "videos are not image leads");
});

Deno.test("real shape: twelve posts spread over the cap instead of three posts taking every slot", () => {
  const leads = extractMediaLeads("socialfetch_lookup", igProfile(Array.from({ length: 12 }, (_, i) => post(i + 1))));
  assertEquals(leads.length, MAX_MEDIA_LEADS);
  assertEquals(leads.filter((l) => l.kind === "content").length, MAX_MEDIA_LEADS);
  assertEquals(new Set(leads.map((l) => l.url)).size, MAX_MEDIA_LEADS, "six different pictures");
  assert(leads.every((l) => l.url.includes("/full")), "all full-size");
});

Deno.test("post context: a platform place tag is carried, untagged pictures rank first, avatars stay last", () => {
  const tagged = post(1, { takenAt: 1773140993, location: { id: "9", lat: 42.3577, lng: -71.0565, name: "Boston, Massachusetts" } });
  const untagged = post(2, { takenAt: 1768751124 });
  const leads = extractMediaLeads("socialfetch_lookup", igProfile([tagged, untagged]));
  assertEquals(leads.map((l) => l.url), [cdn("full2"), cdn("full1"), cdn("av_hd")]);
  assertEquals(leads[0].post, { has_location_tag: false, taken_at: "2026-01-18" });
  assertEquals(leads[1].post, { has_location_tag: true, place: "Boston, Massachusetts", taken_at: "2026-03-10" });
  assertEquals(leads[2].post, undefined, "an avatar never carries post context");
});

Deno.test("post context: coordinates alone are a tag; junk timestamps and control characters are cleaned", () => {
  const coordsOnly = extractMediaLeads("socialfetch_lookup", { posts: [{ image_url: cdn("a"), location: { lat: 1.5, lng: 2.5 } }] });
  assertEquals(coordsOnly[0].post, { has_location_tag: true });
  const bad = extractMediaLeads("socialfetch_lookup", {
    posts: [{ image_url: cdn("b"), takenAt: 12, location: { name: `Pier\u0000 9\n${"x".repeat(200)}` } }],
  });
  assertEquals(bad[0].post?.taken_at, undefined, "epoch 12 is not a plausible capture date");
  assertEquals(bad[0].post?.has_location_tag, true);
  assert(![...(bad[0].post?.place ?? "")].some((ch) => ch.charCodeAt(0) < 32), "no control characters reach the model");
  assertEquals((bad[0].post?.place ?? "").length, 80);
  const ms = extractMediaLeads("socialfetch_lookup", { posts: [{ image_url: cdn("c"), created_at: "2026-02-03T10:00:00Z" }] });
  assertEquals(ms[0].post, { has_location_tag: false, taken_at: "2026-02-03" });
});

Deno.test("post context: a plain scrape or an object with no place and no time grows no `post` key", () => {
  const leads = extractMediaLeads("jina_reader_scrape", { content: "![a](https://cdn.example.com/a.jpg)", image: "https://cdn.example.com/b.jpg" });
  assert(leads.length === 2 && leads.every((l) => !("post" in l)));
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

Deno.test("linkage: a result from an unproven-linkage dispatch keeps its leads but none is a geolocation candidate", () => {
  const body = {
    content: "![a](https://cdn.example.com/p/1.jpg) ![b](https://cdn.example.com/p/2.jpg)",
    avatar_url: "https://cdn.example.com/av/9",
  };
  const clean = attachMediaLeads("jina_reader_scrape", structuredClone(body)) as Record<string, unknown>;
  const cleanLeads = clean.media_leads as Array<{ kind: string; geolocation_candidate: boolean; linkage_unproven?: boolean }>;
  assertEquals(cleanLeads.filter((l) => l.geolocation_candidate).length, 2, "baseline: two content leads are candidates");
  assert(cleanLeads.every((l) => !("linkage_unproven" in l)), "a linked account carries no linkage flag");

  const marker = unprovenLinkageMarker("username", "harvested_handle", "name-only collision");
  const tainted = attachMediaLeads("jina_reader_scrape", { ...structuredClone(body), _runtime: { [UNPROVEN_LINKAGE_KEY]: marker } }) as Record<string, unknown>;
  const leads = tainted.media_leads as Array<{ kind: string; geolocation_candidate: boolean; linkage_unproven?: boolean }>;
  assertEquals(leads.length, 3, "the leads are still visible, as leads");
  assert(leads.every((l) => l.geolocation_candidate === false && l.linkage_unproven === true));
  assertEquals(tainted.media_leads_note, MEDIA_LEADS_NOTE + MEDIA_LEADS_UNLINKED_NOTE);
  assert(String(tainted.media_leads_note).includes("linkage_unproven"));
  // The taint itself is left exactly as the dispatch wrapper wrote it.
  assertEquals((tainted._runtime as Record<string, unknown>)[UNPROVEN_LINKAGE_KEY], marker);
});

Deno.test("linkage: the runtime key this module reads is the one the dispatch wrapper writes", () => {
  assertEquals(UNPROVEN_LINKAGE_RUNTIME_KEY, UNPROVEN_LINKAGE_KEY);
});

Deno.test("linkage: other _runtime metadata, or a falsy/odd taint value, does not trip the guard", () => {
  const body = { content: "![a](https://cdn.example.com/p/1.jpg)" };
  const probes: unknown[] = [
    { selector: "x", weak_lead: true, weak_lead_reasons: ["single-source"] },
    { [UNPROVEN_LINKAGE_KEY]: null },
    { [UNPROVEN_LINKAGE_KEY]: false },
    [],
    "unproven_linkage",
  ];
  for (const rt of probes) {
    const out = attachMediaLeads("jina_reader_scrape", { ...body, _runtime: rt }) as Record<string, unknown>;
    const leads = out.media_leads as Array<{ geolocation_candidate: boolean; linkage_unproven?: boolean }>;
    assertEquals(leads.map((l) => l.geolocation_candidate), [true], JSON.stringify(rt));
    assertEquals(out.media_leads_note, MEDIA_LEADS_NOTE);
  }
});

Deno.test("linkage: through the wrapper, a tainted social result is downgraded and the original is not mutated", async () => {
  const marker = unprovenLinkageMarker("username", "harvested_handle", null);
  const original = { data: { recentPosts: [{ displayUrl: "https://cdn.example.com/p/1.jpg" }] }, _runtime: { [UNPROVEN_LINKAGE_KEY]: marker } };
  const frozen = structuredClone(original);
  const wrapped = wrapToolsWithMediaLeads(
    { socialfetch_lookup: { execute: async () => original } },
    () => undefined,
  ) as { socialfetch_lookup: { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> } };
  const out = await wrapped.socialfetch_lookup.execute({}, {});
  const leads = out.media_leads as Array<{ geolocation_candidate: boolean; linkage_unproven?: boolean }>;
  assertEquals(leads.map((l) => [l.geolocation_candidate, l.linkage_unproven]), [[false, true]]);
  assertEquals(original, frozen, "the cached/original result object is untouched");
});

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
      // The production shape: profile + recentPosts with place tags. The profile branch of
      // extractFindings must read exactly what it read before, whatever recentPosts holds.
      tool: "socialfetch_lookup",
      input: { platform: "instagram", username: "jvale" },
      mustYield: true,
      output: {
        ok: true,
        data: {
          profile: { handle: "jvale", username: "jvale", url: "https://www.instagram.com/jvale/", avatarUrl: cdn("av") },
          recentPosts: [post(1, { takenAt: 1773140993, location: { lat: 42.3577, lng: -71.0565, name: "Boston, Massachusetts" } }), post(2)],
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

Deno.test("wiring: the geolocation rule is bounded, defers to a platform place tag, and respects the minor-safety stop", () => {
  const line = PROMPT.split("\n").find((l) => l.includes("IMAGE GEOLOCATION (GEO-OSINT)")) ?? "";
  assert(line.length > 0, "the IMAGE GEOLOCATION bullet exists");
  assert(line.includes("up to 3"), "vision reads per result are bounded");
  assert(line.includes("at most 2 GeoSeer calls"), "paid geolocation per investigation is bounded");
  assert(line.includes("post.has_location_tag"), "a platform-reported place is read before paying for GeoSeer");
  assert(line.includes("possible-minor") && line.includes("Minor-safety"), "the workflow stops on the existing minor-safety signal");
  assert(line.includes("never geolocation candidates"), "avatars are not geolocation candidates");
  // The existing safety bullet this rule points at must still be there.
  assert(PROMPT.includes("Minor-safety detection:"));
  assert(MEDIA_LEADS_NOTE.includes("post.has_location_tag"));
});

Deno.test("wiring: the geolocation rule is TRIGGERED (corroborate, or other pivots done) rather than run on every photo", () => {
  const line = PROMPT.split("\n").find((l) => l.includes("IMAGE GEOLOCATION (GEO-OSINT)")) ?? "";
  assert(line.includes("never an opening move"), "geolocation is not an opening move");
  assert(line.includes("(a) CORROBORATE data you already hold"), "trigger A: correlate with data already found");
  assert(line.includes("AGREES with or CONTRADICTS"), "the result is reported against the data already held");
  assert(/other pivots for this seed have been attempted or recorded UNAVAILABLE/.test(line), "trigger B: only once the other pivots are done");
  assert(line.includes("cheaper, higher-yield pivots are still pending"), "no credits while better pivots remain");
  // Same vocabulary as the EXHAUSTION / SATURATION RULE so the two cannot disagree about when pivots are done.
  assert(PROMPT.includes("attempted, satisfied, or explicitly recorded UNAVAILABLE"));
});

Deno.test("wiring: the AUTHENTICITY GATE names what to skip and sits BEFORE the vision/GeoSeer mechanics", () => {
  const line = PROMPT.split("\n").find((l) => l.includes("IMAGE GEOLOCATION (GEO-OSINT)")) ?? "";
  const gate = line.indexOf("AUTHENTICITY GATE");
  assert(gate > 0, "the gate exists");
  assert(gate < line.indexOf("MECHANICS:"), "the gate is read before the how-to");
  assert(gate < line.indexOf("gemini_vision"), "the gate precedes the first vision instruction");
  assert(line.includes("durable linkage"), "the account must be tied to the subject");
  for (const word of ["fan pages", "parody", "impersonation", "bot-", "stock", "meme", "repost", "AI-generated"]) {
    assert(line.includes(word), `the gate must name: ${word}`);
  }
  assert(line.includes("linkage_unproven"), "the lead-level flag is named");
  assert(line.includes("spend nothing on it"), "unclear authenticity costs nothing");
  assert(line.includes("A photo the analyst attached is exempt"), "an analyst's own upload is not second-guessed");
  assert(MEDIA_LEADS_NOTE.includes("authenticity gate"));
  assert(MEDIA_LEADS_UNLINKED_NOTE.includes("gemini_vision") && MEDIA_LEADS_UNLINKED_NOTE.includes("geoseer_geolocate"));
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
