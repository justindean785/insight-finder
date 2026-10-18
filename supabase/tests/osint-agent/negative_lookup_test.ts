// negative_lookup_test.ts — a lookup that found nothing is a RESULT, not a failure,
// and a read of an origin's error page is not evidence.
//
// Two measured shapes (2026-10-06):
//  • shodan_internetdb answers HTTP 404 for an IP it has no record of. The tool returned
//    `{ok:false, status:404}`; `circuit.classifyResult` filed `http_404`, a SECOND distinct
//    404 disabled the tool for the thread, a third VALID IP was refused, and the refusal
//    was logged `outcome=failed`.
//  • jina_reader_scrape answers HTTP 200 with "Warning: Target URL returned error 404" in
//    the body for a page whose ORIGIN errored. The tool returned `{ok:true, markdown}`, so
//    the error page was saved and cited as page evidence (73 of 1,047 stored outputs).
//
// These tests drive the REAL tools (stubbed `fetch`) through the REAL cache wrapper and the
// REAL circuit breaker — not a copy of their rules. Kill switch NEGATIVE_LOOKUP_DISABLED
// restores the old shapes; the kill-switch tests double as the negative control, because
// they must reproduce the measured chain on the old shape.
//
// Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { classifyToolOutcome, isProvenEmptyResult } from "../../functions/osint-agent/tool-outcome.ts";
import { buildDeadTargets } from "../../functions/osint-agent/lib/dead-target.ts";
import { cacheVersionFor, describeToolCacheVersions, TOOL_CACHE_VERSION } from "../../functions/osint-agent/lib/tool-cache-version.ts";
import {
  negativeLookupSelfTest,
  parseJinaTargetError,
  shapeJinaBody,
  shapeShodanResponse,
} from "../../functions/osint-agent/lib/negative-lookup.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;
type Exec = (i: unknown, o: unknown) => Promise<Record<string, unknown>>;

const SWITCH = "NEGATIVE_LOOKUP_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

function makeDb() {
  const usage: Row[] = [];
  const cacheUpserts: Row[] = [];
  let table = "";
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain; q.in = chain; q.order = chain; q.limit = chain; q.update = chain; q.eq = chain;
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = (r: Row) => { if (table === "tool_usage_log") usage.push(r); return Promise.resolve({ error: null }); };
  q.upsert = (r: Row) => { if (table === "tool_call_cache") cacheUpserts.push(r); return Promise.resolve({ error: null }); };
  const db = {
    from: (t: string) => { table = t; return q; },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { db, usage, cacheUpserts };
}

function stubCtx(thread: string): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: thread,
    archiveEnabled: false, detectedSeedType: "ip", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

/** The real shodan/jina tools behind the real wrapper, on a fresh thread. */
function harness(thread: string) {
  circuit.clearThread(thread);
  clearRuntime(thread);
  const h = makeDb();
  const real = buildTools(stubCtx(thread)).tools as Record<string, unknown>;
  const wrapped = wrapToolsWithCache(
    { shodan_internetdb: real.shodan_internetdb, jina_reader_scrape: real.jina_reader_scrape } as never,
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  ) as unknown as Record<string, { execute: Exec }>;
  const call = async (tool: string, input: Record<string, unknown>) => {
    const out = await wrapped[tool].execute({ ...input, force: true }, { toolCallId: `${thread}-${Math.random()}`, messages: [] });
    await new Promise((r) => setTimeout(r, 40)); // logUsage is fire-and-forget on the live path
    return out;
  };
  return { h, call };
}

const errPage = (code: number, reason = "Not Found") =>
  `Title: ${reason}\n\nURL Source: https://example.test/p\n\nWarning: Target URL returned error ${code}: ${reason}\n\nMarkdown Content:\n# ${reason}\n`;

/** fetch stub: shodan answers by IP, jina answers by target URL. */
function stubFetch(routes: { shodan?: Record<string, number>; jina?: Record<string, string> }) {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const u = String(input);
    seen.push(u);
    if (u.includes("internetdb.shodan.io")) {
      const ip = decodeURIComponent(u.split("internetdb.shodan.io/")[1] ?? "");
      const status = routes.shodan?.[ip] ?? 200;
      const body = status === 404 ? { detail: "No information available" } : { ip, ports: [80], hostnames: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }
    if (u.includes("r.jina.ai")) {
      const target = u.split("r.jina.ai/")[1] ?? "";
      return Promise.resolve(new Response(routes.jina?.[target] ?? "Title: ok\n\nMarkdown Content:\nhello", { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

// ── shodan_internetdb: the measured chain ──────────────────────────────────────

Deno.test("shodan: two valid negative lookups do NOT disable the tool — a third IP is still looked up", async () => {
  const f = stubFetch({ shodan: { "192.0.2.1": 404, "192.0.2.2": 404 } });
  try {
    const { h, call } = harness("nl-shodan-a");
    const a = await call("shodan_internetdb", { ip: "192.0.2.1" });
    const b = await call("shodan_internetdb", { ip: "192.0.2.2" });
    const c = await call("shodan_internetdb", { ip: "192.0.2.3" });

    for (const r of [a, b]) {
      assertEquals(r.ok, true);
      assertEquals(r.found, false);
      assertEquals(r.upstream_status, 404);
      assert(!("status" in r), "a negative must not carry a bare `status:404` for the breaker to read");
    }
    assertEquals(c.ok, true, "the third, valid IP must reach the provider");
    assertEquals(f.seen.filter((u) => u.includes("internetdb.shodan.io")).length, 3, "all three lookups hit the network");
    assert(!JSON.stringify(c).includes("disabled for thread"), "no breaker refusal");

    const rows = h.usage.filter((u) => u.tool_name === "shodan_internetdb");
    assertEquals(rows.map((r) => r.outcome), ["empty", "empty", "ok"]);
    assertEquals(rows.map((r) => r.ok), [true, true, true]);
  } finally { f.restore(); }
});

Deno.test("shodan: a genuine 5xx is still a failure and still trips the breaker (the rule is scoped to 404)", async () => {
  const f = stubFetch({ shodan: { "192.0.2.9": 503 } });
  try {
    const { h, call } = harness("nl-shodan-b");
    const r = await call("shodan_internetdb", { ip: "192.0.2.9" });
    assertEquals(r.ok, false);
    assertEquals(r.status, 503);
    assertEquals(h.usage.find((u) => u.tool_name === "shodan_internetdb")?.outcome, "failed");
  } finally { f.restore(); }
});

Deno.test("NEGATIVE CONTROL — kill switch restores the old shape and reproduces the measured chain", async () => {
  await withEnv(SWITCH, "true", async () => {
    const f = stubFetch({ shodan: { "192.0.2.1": 404, "192.0.2.2": 404 } });
    try {
      const { h, call } = harness("nl-shodan-ctl");
      const a = await call("shodan_internetdb", { ip: "192.0.2.1" });
      assertEquals(a.ok, false);
      assertEquals(a.status, 404);
      await call("shodan_internetdb", { ip: "192.0.2.2" });
      const c = await call("shodan_internetdb", { ip: "192.0.2.3" });
      // The old chain: two distinct 404s disabled the tool, so a VALID third IP is refused.
      assertEquals(c.skipped, true);
      assert(String(c.error).includes("disabled for thread"), String(c.error));
      assertEquals(f.seen.filter((u) => u.includes("internetdb.shodan.io")).length, 2, "the third IP never reached the provider");
      // …and that refusal is logged as a SKIP, not a provider failure (SKIP_RE).
      const refusal = h.usage.filter((u) => u.tool_name === "shodan_internetdb").at(-1);
      assertEquals(refusal?.outcome, "skipped");
    } finally { f.restore(); }
  });
});

// ── the refusal text is a skip, wherever it comes from ─────────────────────────

Deno.test("a circuit-disable refusal classifies as skipped, never failed (it fed dead-target memory)", () => {
  for (const msg of [
    "endpoint returned 404 on 2 distinct inputs — disabled for thread",
    "402 payment required — disabled for thread",
    "403/401 unauthorized — disabled for thread",
    "502 bad gateway — disabled for thread",
  ]) assertEquals(classifyToolOutcome(msg, null), "skipped", msg);
  // Genuine failures are untouched.
  assertEquals(classifyToolOutcome("jina 403", 403), "failed");
  assertEquals(classifyToolOutcome("Failed to fetch", null), "failed");
  assertEquals(classifyToolOutcome("503 Service Unavailable", 503), "failed");
});

Deno.test("dead-target memory ignores circuit-refusal rows and resets on a proven negative", () => {
  const sel = (i: Record<string, unknown>) => String(i.ip ?? "");
  const mk = (outcome: string, extra: Row = {}): Row => ({
    tool_name: "shodan_internetdb", outcome, input_json: { input: { ip: "192.0.2.7" } }, created_at: "2026-10-06T10:00:00Z", ...extra,
  });
  // Two REFUSALS of a valid IP used to be two `failed` rows == a dead target (floor 2).
  const refused = buildDeadTargets([mk("skipped"), mk("skipped")] as never, sel);
  assertEquals([...refused.values()].reduce((a, b) => a + b, 0), 0);
  // Positive control: the same two rows logged `failed` ARE counted — so the zero above is the
  // classification's doing, not an input the reader ignores.
  const failed = buildDeadTargets([mk("failed"), mk("failed")] as never, sel);
  assertEquals([...failed.values()].reduce((a, b) => a + b, 0), 2);
  // A proven negative in between resets the count.
  const reset = buildDeadTargets([mk("failed"), mk("failed", { created_at: "2026-10-06T10:00:01Z" }), mk("empty", { created_at: "2026-10-06T10:00:02Z" })] as never, sel);
  assertEquals([...reset.values()].reduce((a, b) => a + b, 0), 0);
});

// ── jina_reader_scrape: origin error pages ─────────────────────────────────────

Deno.test("jina: an origin 404 is a proven negative — the error page is NOT returned as page content", async () => {
  const f = stubFetch({ jina: { "https://example.test/gone": errPage(404) } });
  try {
    const { h, call } = harness("nl-jina-a");
    const r = await call("jina_reader_scrape", { url: "https://example.test/gone" });
    assertEquals(r.ok, true);
    assertEquals(r.found, false);
    assertEquals(r.target_status, 404);
    assert(!("markdown" in r), "the reader's error page must not reach the model or the evidence stream");
    assert(!JSON.stringify(r).includes("Not Found\n"), "no error-page body leaks through");
    const row = h.usage.find((u) => u.tool_name === "jina_reader_scrape");
    assertEquals(row?.outcome, "empty");
    assertEquals(row?.ok, true);
  } finally { f.restore(); }
});

Deno.test("jina: origin 410 is also a negative; 403/405/429/400/401/5xx are FAILED READS that do not trip the breaker", async () => {
  const pages: Record<string, string> = {
    "https://example.test/g410": errPage(410, "Gone"),
    "https://example.test/f403": errPage(403, "Forbidden"),
    "https://example.test/f405": errPage(405, "Method Not Allowed"),
    "https://example.test/f429": errPage(429, "Too Many Requests"),
    "https://example.test/f503": errPage(503, "Service Unavailable"),
    "https://example.test/fine": "Title: Fine\n\nURL Source: https://example.test/fine\n\nMarkdown Content:\nhello world",
  };
  const f = stubFetch({ jina: pages });
  try {
    const { h, call } = harness("nl-jina-b");
    const g = await call("jina_reader_scrape", { url: "https://example.test/g410" });
    assertEquals([g.ok, g.found, g.target_status], [true, false, 410]);

    for (const u of ["f403", "f405", "f429", "f503"]) {
      const r = await call("jina_reader_scrape", { url: `https://example.test/${u}` });
      assertEquals(r.ok, false, u);
      assertEquals(r.origin_error, true, u);
      assert(!("status" in r), `${u}: the origin's code must travel as target_status, never status`);
      assert(!("markdown" in r), `${u}: no error-page body`);
    }
    // Four blocked pages in a row must NOT have taken the reader offline: the next read works.
    const ok = await call("jina_reader_scrape", { url: "https://example.test/fine" });
    assertEquals(ok.ok, true);
    assert(String(ok.markdown).includes("hello world"), "a real page is still returned verbatim");
    assert(!String(ok.error ?? "").includes("disabled"), "the reader was not disabled by blocked origins");

    const outcomes = h.usage.filter((u) => u.tool_name === "jina_reader_scrape").map((r) => r.outcome);
    assertEquals(outcomes, ["empty", "failed", "failed", "failed", "failed", "ok"]);
  } finally { f.restore(); }
});

Deno.test("jina: only a failed read is uncached; a proven negative IS cached; a real page is cached", async () => {
  const f = stubFetch({ jina: { "https://example.test/a": errPage(404), "https://example.test/b": errPage(403, "Forbidden") } });
  try {
    const { h, call } = harness("nl-jina-c");
    await call("jina_reader_scrape", { url: "https://example.test/a" });
    await call("jina_reader_scrape", { url: "https://example.test/b" });
    await call("jina_reader_scrape", { url: "https://example.test/c" });
    assertEquals(h.cacheUpserts.length, 2, "the 404 negative and the real page are cached; the blocked read is not");
  } finally { f.restore(); }
});

Deno.test("NEGATIVE CONTROL — jina kill switch restores the old shape: the error page is saved as ok page content", async () => {
  await withEnv(SWITCH, "true", async () => {
    const f = stubFetch({ jina: { "https://example.test/gone": errPage(404) } });
    try {
      const { h, call } = harness("nl-jina-ctl");
      const r = await call("jina_reader_scrape", { url: "https://example.test/gone" });
      assertEquals(r.ok, true);
      assert(String(r.markdown).includes("Target URL returned error 404"), "legacy: the error page is returned as markdown");
      assertEquals(h.usage.find((u) => u.tool_name === "jina_reader_scrape")?.outcome, "ok");
    } finally { f.restore(); }
  });
});

Deno.test("jina: a page that merely QUOTES the phrase is not an error page", () => {
  const body = "Title: HTTP\n\nURL Source: https://example.test/x\n\nMarkdown Content:\nWarning: Target URL returned error 404 is what the reader prints.";
  assertEquals(parseJinaTargetError(body), null);
  assertEquals(shapeJinaBody("https://example.test/x", body, 100).ok, true);
  assertEquals(shapeJinaBody("https://example.test/x", body, 100).found, undefined);
  // The Title line may be absent; the header block is still recognised — but URL Source may not be (see below).
  assertEquals(parseJinaTargetError("URL Source: https://example.test/x\n\nWarning: Target URL returned error 451: Unavailable"), 451);
  // A non-error code or garbage never matches.
  assertEquals(parseJinaTargetError("Warning: Target URL returned error 200: OK"), null);
});

// ── circuit.classifyResult ─────────────────────────────────────────────────────

Deno.test("circuit: an origin_error is not a provider outcome; the same shape without the marker still is", () => {
  const body = { ok: false, error: "jina target error 403", target_status: 403, url: "https://example.test/f" };
  assertEquals(circuit.classifyResult({ ...body, origin_error: true }, null), "ok");
  assertEquals(circuit.classifyResult(body, null), "other");
  // A real provider 403 from Jina itself (status key) still suppresses the provider.
  assertEquals(circuit.classifyResult({ error: "jina 403", status: 403, url: "https://example.test/f" }, null), "http_403");
});

// ── proven-empty predicates are shape-anchored ─────────────────────────────────

Deno.test("proven-empty: only the exact negative shapes qualify", () => {
  assert(isProvenEmptyResult("shodan_internetdb", { ok: true, found: false, upstream_status: 404, data: {} }));
  assert(!isProvenEmptyResult("shodan_internetdb", { ok: true, status: 200, data: { ip: "192.0.2.1" } }));
  assert(!isProvenEmptyResult("shodan_internetdb", { ok: true, found: false }), "found:false without the 404 anchor is not enough");
  assert(isProvenEmptyResult("jina_reader_scrape", { ok: true, found: false, target_status: 404, url: "u" }));
  assert(isProvenEmptyResult("jina_reader_scrape", { ok: true, found: false, target_status: 410, url: "u" }));
  assert(!isProvenEmptyResult("jina_reader_scrape", { ok: true, found: false, target_status: 403, url: "u" }));
  assert(!isProvenEmptyResult("jina_reader_scrape", { ok: true, url: "u", markdown: "x" }));
});

// ── cache version + /health ────────────────────────────────────────────────────

Deno.test("cache: both tools are versioned so a pre-fix row (error page as ok / 404 as failure) never replays", () => {
  assertEquals(TOOL_CACHE_VERSION.shodan_internetdb, 2);
  assertEquals(TOOL_CACHE_VERSION.jina_reader_scrape, 2);
  assertEquals(cacheVersionFor("shodan_internetdb"), 2);
  assertEquals(cacheVersionFor("jina_reader_scrape"), 2);
  const d = describeToolCacheVersions().detail;
  assert(d.includes("shodan_internetdb=v2") && d.includes("jina_reader_scrape=v2"), d);
});

Deno.test("/health: checks.negative_lookup_semantics is wired, passes, and says when the switch is thrown", async () => {
  assertEquals(negativeLookupSelfTest().ok, true);
  assert(negativeLookupSelfTest().detail.includes("proven-empty"));
  await withEnv(SWITCH, "true", async () => {
    const off = negativeLookupSelfTest();
    assertEquals(off.ok, true);
    assert(off.detail.includes("LEGACY"), off.detail);
  });
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(
    health.includes("r.checks.negative_lookup_semantics = negativeLookupSelfTest()"),
    "the health probe must report the check — its presence is the proof-of-deploy key",
  );
});

Deno.test("shapes: with the kill switch thrown, both helpers return the legacy shapes exactly", async () => {
  await withEnv(SWITCH, "true", () => {
    assertEquals(shapeShodanResponse(404, false, { d: 1 }), { ok: false, status: 404, data: { d: 1 } });
    assertEquals(
      shapeJinaBody("https://example.test/x", errPage(404), 18000),
      { ok: true, url: "https://example.test/x", markdown: errPage(404), truncated: false },
    );
    return Promise.resolve();
  });
});

// ── Review of #696: what must NOT read as a proven negative ─────────────────────

const NO_INFO = { detail: "No information available" };

Deno.test("review/shodan: a 404 for something that is not an IP is NOT a negative (InternetDB answers it identically)", () => {
  // Measured live 2026-10-06: `notanip` and `1.2.3` get the same 404 body as an unindexed address.
  for (const bad of ["notanip", "1.2.3", "example.test", "999.1.1.1", "", " ", "1.2.3.4.5", undefined, null, 42]) {
    const r = shapeShodanResponse(404, false, NO_INFO, bad);
    assertEquals(r, { ok: false, status: 404, data: NO_INFO }, JSON.stringify(bad));
  }
});

Deno.test("review/shodan: IPv4 and IPv6 literals ARE negatives", () => {
  for (const good of ["192.0.2.1", "8.8.4.4", " 203.0.113.7 ", "2001:db8::1", "::1"]) {
    const r = shapeShodanResponse(404, false, NO_INFO, good);
    assertEquals(r.ok, true, good);
    assertEquals(r.found, false, good);
  }
});

Deno.test("review/shodan: an UNDOCUMENTED 404 body is a failure, so a dead endpoint still reads as one", () => {
  for (const body of [{ detail: "Not Found" }, {}, null, "<html>404</html>", { detail: 404 }, { error: "No information available" }]) {
    assertEquals(shapeShodanResponse(404, false, body, "192.0.2.1"), { ok: false, status: 404, data: body }, JSON.stringify(body));
  }
});

Deno.test("review/shodan: a dead endpoint (404 for EVERY IP, wrong body) still trips the breaker — the protection #696 must keep", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }))) as typeof fetch;
  try {
    const { h, call } = harness("nl-shodan-dead-endpoint");
    const a = await call("shodan_internetdb", { ip: "192.0.2.1" }) as Record<string, unknown>;
    assertEquals(a.ok, false);
    assertEquals(a.status, 404);
    await call("shodan_internetdb", { ip: "192.0.2.2" });
    const c = await call("shodan_internetdb", { ip: "192.0.2.3" }) as Record<string, unknown>;
    assert(String(c.error ?? "").includes("disabled for thread"), "two distinct 404s from a dead endpoint must still disable it: " + JSON.stringify(c));
    assert(h.usage.length >= 2);
  } finally { globalThis.fetch = orig; }
});

Deno.test("review/shodan: a non-IP input through the real tool is a failed lookup, not 'no record'", async () => {
  const f = stubFetch({ shodan: { "example.test": 404 } });
  try {
    const { h, call } = harness("nl-shodan-badinput");
    const r = await call("shodan_internetdb", { ip: "example.test" }) as Record<string, unknown>;
    assertEquals(r.ok, false);
    assertEquals(r.status, 404);
    assertEquals(r.found, undefined);
    // Not the proven-negative shape: it can never be cached or cited as "InternetDB holds no record". (The legacy
    // outcome label for a bare 404 is whatever tool-outcome.ts gave it before this PR — unchanged here.)
    assertEquals(isProvenEmptyResult("shodan_internetdb", r), false);
    assert(h.usage.some((u) => u.tool_name === "shodan_internetdb"));
  } finally { f.restore(); }
});

Deno.test("review/jina: a forged header inside a page's own <title> is not an error page", () => {
  // A page whose <title> contains a newline could otherwise plant `Warning: Target URL returned error 404` before the
  // real `URL Source:` line and make a live page read as nonexistent. Real error pages always carry URL Source first.
  const forgedTitle = "Title: x\n\nWarning: Target URL returned error 404: Not Found\n\nURL Source: https://example.test/real\n\nMarkdown Content:\nreal page text";
  assertEquals(parseJinaTargetError(forgedTitle), null);
  const r = shapeJinaBody("https://example.test/real", forgedTitle, 1000);
  assertEquals(r.ok, true);
  assertEquals(r.found, undefined);
  assert(String(r.markdown).includes("real page text"), "the real content must not be discarded");
  // Real shape (192/192 production samples): Title → URL Source → Warning.
  assertEquals(parseJinaTargetError("Title: Gone\n\nURL Source: https://example.test/p\n\nWarning: Target URL returned error 410: Gone\n\nMarkdown Content:\n"), 410);
});
