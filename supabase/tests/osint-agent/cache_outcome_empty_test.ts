// cache_outcome_empty_test.ts — H1: a successful negative must persist as
// `outcome:"empty"`, not `outcome:"ok"`.
//
// These tests drive the REAL write path through wrapToolsWithCache with a fake
// Supabase client that captures the actual `tool_usage_log` INSERT row. A passing
// unit test of the pure predicate is NOT sufficient evidence: the defect was that
// `cache.ts` short-circuited outcome classification whenever `ok` was true
// (`const outcome = ok ? "ok" : classifyToolOutcome(...)`), and that the three
// cache-replay paths passed a hardcoded `ok=true` literal with no payload at all.
// Only an assertion on the persisted row proves either one is fixed.
//
// SCOPE GUARD — this branch changes the stored `outcome` and NOTHING else. Every
// test below therefore also asserts the invariants that must NOT move: `ok`
// stays true, charging still happens, the result is still cached, and no tool
// outside the explicit table shifts classification.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import { isProvenEmptyResult, PROVEN_EMPTY_PREDICATES } from "../../functions/osint-agent/tool-outcome.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

interface Harness {
  db: SupabaseClient;
  usage: Row[];
  cacheUpserts: Row[];
  executions: () => number;
  bump: () => void;
}

/** Fake Supabase: records tool_usage_log inserts + tool_call_cache upserts, and can
 *  serve a stored cache row to either the input_hash lookup or the selector-reuse
 *  lookup (distinguished by which columns the query filtered on). */
function makeDb(serve?: (eqs: Array<[string, unknown]>) => unknown): Harness {
  const usage: Row[] = [];
  const cacheUpserts: Row[] = [];
  let execs = 0;
  let table = "";
  let eqs: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.in = chain;
  q.order = chain;
  q.limit = chain;
  q.update = chain;
  q.eq = (col: string, val: unknown) => { eqs.push([col, val]); return q; };
  q.maybeSingle = () =>
    Promise.resolve({
      data: table === "tool_call_cache" && serve ? (serve([...eqs]) ?? null) : null,
      error: null,
    });
  q.insert = (r: Row) => { if (table === "tool_usage_log") usage.push(r); return Promise.resolve({ error: null }); };
  q.upsert = (r: Row) => { if (table === "tool_call_cache") cacheUpserts.push(r); return Promise.resolve({ error: null }); };
  const db = {
    from: (t: string) => { table = t; eqs = []; return q; },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { db, usage, cacheUpserts, executions: () => execs, bump: () => { execs++; } };
}

function makeTool(execute: (i: unknown, o: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

/** Run one call through the wrapper and return the persisted tool_usage_log row. */
async function runOnce(
  toolName: string,
  thread: string,
  payload: unknown,
  opts: { serve?: (eqs: Array<[string, unknown]>) => unknown; input?: Record<string, unknown> } = {},
): Promise<{ row: Row; h: Harness; returned: unknown }> {
  clearRuntime(thread);
  const h = makeDb(opts.serve);
  const wrapped = wrapToolsWithCache(
    { [toolName]: makeTool(async () => { h.bump(); return payload; }) },
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  );
  const exec = wrapped[toolName].execute as (i: unknown, o: unknown) => Promise<unknown>;
  const input = opts.input ?? { email: `probe@${thread}.example`, force: true };
  const returned = await exec(input, { toolCallId: `${thread}-1`, messages: [] });
  // logUsage on the live path is fire-and-forget; let the microtask drain.
  await new Promise((r) => setTimeout(r, 40));
  const row = h.usage.find((u) => u.tool_name === toolName) ?? h.usage[0] ?? {};
  return { row, h, returned };
}

const outcomeOf = async (tool: string, thread: string, payload: unknown) =>
  (await runOnce(tool, thread, payload)).row.outcome;

// ---------------------------------------------------------------------------
// Fixtures. Shapes copied verbatim from the returns in tool-registry.ts.
// ---------------------------------------------------------------------------
interface Fx { negative: unknown; positive: unknown }
const FIXTURES: Record<string, Fx> = {
  gravatar_profile: {
    negative: { ok: true, status: 404, found: false, hash: "h", avatar_url: "u", data: {} },
    positive: { ok: true, status: 200, found: true, hash: "h", avatar_url: "u", data: { display_name: "X" } },
  },
  leakcheck_lookup: {
    negative: { ok: true, status: 200, source: "leakcheck.v2", found: 0, data: { success: true, found: 0, quota: 9, sources: [], raw: {} } },
    positive: { ok: true, status: 200, source: "leakcheck.v2", data: { success: true, found: 3, quota: 9, sources: ["acme"], raw: {} } },
  },
  socialfetch_lookup: {
    negative: { ok: true, status: 404, found: false, lookupStatus: "not_found", data: { lookupStatus: "not_found" }, meta: null, error: null },
    positive: { ok: true, status: 200, found: true, lookupStatus: "found", data: { lookupStatus: "found" }, meta: null, error: null },
  },
  ransomwarelive_lookup: {
    negative: { ok: true, domain: "acme.com", listed: false, count: 0, victims: [] },
    positive: { ok: true, domain: "acme.com", listed: true, count: 2, victims: [{ v: 1 }, { v: 2 }] },
  },
  census_geocode: {
    negative: { ok: true, address: "a", matched: false, count: 0, matches: [] },
    positive: { ok: true, address: "a", matched: true, count: 1, matches: [{ matchedAddress: "a", lon: 1, lat: 2 }] },
  },
  nominatim_geocode: {
    negative: { ok: true, address: "a", matched: false },
    positive: { ok: true, address: "a", matched: true, lat: 1, lon: 2, place_type: null },
  },
  wayback_cdx_search: {
    negative: { ok: true, url: "u", archived: false, sampled_count: 0, capped: false, earliest: null, latest: null, captures: [] },
    positive: { ok: true, url: "u", archived: true, sampled_count: 2, capped: false, earliest: "2020", latest: "2024", captures: [{ t: 1 }, { t: 2 }] },
  },
  gleif_lei_search: {
    negative: { ok: true, name: "n", count: 0, records: [], note: "no LEI record matched" },
    positive: { ok: true, name: "n", count: 1, records: [{ lei: "X", legalName: "N" }] },
  },
  oathnet_stealer_search: {
    negative: { ok: true, status: 200, count: 0, total: 0, items: [], quota_left: 5, note: "n" },
    positive: { ok: true, status: 200, count: 2, total: 2, items: [{ a: 1 }, { a: 2 }], quota_left: 5, note: "n" },
  },
  oathnet_victims_search: {
    negative: { ok: true, status: 200, count: 0, total: 0, items: [], quota_left: 5, note: "n" },
    positive: { ok: true, status: 200, count: 1, total: 1, items: [{ a: 1 }], quota_left: 5, note: "n" },
  },
  oathnet_subdomains: {
    negative: { ok: true, status: 200, domain: "d", count: 0, subdomains: [], source: "oathnet_stealer_subdomain", quota_left: 5 },
    positive: { ok: true, status: 200, domain: "d", count: 2, subdomains: ["a.d", "b.d"], source: "oathnet_stealer_subdomain", quota_left: 5 },
  },
  // lib/negative-lookup.ts — InternetDB's HTTP 404 and Jina's wrapped origin 404/410.
  shodan_internetdb: {
    negative: { ok: true, found: false, upstream_status: 404, data: { detail: "No information available" }, note: "n" },
    positive: { ok: true, status: 200, data: { ip: "192.0.2.1", ports: [80], hostnames: [] } },
  },
  jina_reader_scrape: {
    negative: { ok: true, found: false, url: "https://example.test/x", target_status: 404, note: "n" },
    positive: { ok: true, url: "https://example.test/x", markdown: "Title: A", truncated: false },
  },
  oathnet_lookup: {
    negative: { ok: true, status: 200, quota_left: 5, data: { success: true, message: "V2-Breach-Search completed successfully", data: { items: [], meta: {} }, _meta: {} } },
    positive: { ok: true, status: 200, quota_left: 5, data: { success: true, message: "V2-Breach-Search completed successfully", data: { items: [{ a: 1 }], meta: { total: 1 } }, _meta: {} } },
  },
};

// ===========================================================================
// 1. Every tool in the table: genuine negative → empty
// ===========================================================================
Deno.test("H1: every listed tool persists its genuine negative as outcome=empty", async () => {
  let i = 0;
  for (const [tool, fx] of Object.entries(FIXTURES)) {
    const { row } = await runOnce(tool, `neg-${i++}-${tool}`, fx.negative);
    assertEquals(row.outcome, "empty", `${tool} negative should log empty`);
    // Execution success is UNCHANGED — this is the whole point of the fix.
    assertEquals(row.ok, true, `${tool} negative must stay ok=true`);
    assertEquals(row.cached, false);
  }
  assertEquals(Object.keys(FIXTURES).length, Object.keys(PROVEN_EMPTY_PREDICATES).length,
    "fixture set must cover exactly the predicate table");
});

// ===========================================================================
// 2. Same tools: positives keep outcome=ok
// ===========================================================================
Deno.test("H1: every listed tool still persists its positive as outcome=ok", async () => {
  let i = 0;
  for (const [tool, fx] of Object.entries(FIXTURES)) {
    const { row } = await runOnce(tool, `pos-${i++}-${tool}`, fx.positive);
    assertEquals(row.outcome, "ok", `${tool} positive must stay ok`);
    assertEquals(row.ok, true);
  }
});

// ===========================================================================
// 3-5. The three explicitly-decided non-empty cases
// ===========================================================================
Deno.test("D3: socialfetch lookupStatus 'private' is a positive existence finding, stays ok", async () => {
  const priv = { ok: true, status: 200, found: false, lookupStatus: "private", data: { lookupStatus: "private" }, meta: null, error: null };
  assertEquals(await outcomeOf("socialfetch_lookup", "sf-private", priv), "ok");
  // `found:false` alone must never drive the decision — that is why there is no
  // generic `found` sweep.
  assertEquals(isProvenEmptyResult("socialfetch_lookup", priv), false);
});

Deno.test("D4: GLEIF fuzzy-suggestions path is a partial result, stays ok", async () => {
  const fuzzy = { ok: true, name: "n", count: 0, fuzzy: true, suggestions: [{ legalName: "Acme", lei: "X" }], note: "no exact legalName match" };
  assertEquals(await outcomeOf("gleif_lei_search", "gleif-fuzzy", fuzzy), "ok");
});

Deno.test("D5: OpenCorporates zero/malformed payload is NOT reclassified", async () => {
  // Its dedicated malformed-response guard and its genuine zero-result return emit a
  // byte-identical payload, so neither can be proven empty. Tool stays untouched.
  const amb = { ok: true, name: "n", count: 0, companies: [] };
  assertEquals(await outcomeOf("opencorporates_search", "oc-amb", amb), "ok");
  assertEquals(isProvenEmptyResult("opencorporates_search", amb), false);
});

Deno.test("oathnet_lookup: pagination controls — an empty page mid-scroll is NOT empty", async () => {
  const env = (inner: Record<string, unknown>) => ({
    ok: true, status: 200, quota_left: 5,
    data: { success: true, message: "V2-Breach-Search completed successfully", data: inner, _meta: {} },
  });
  // Control 1: the real production shape — empty items, no offset, no cursor.
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [], meta: {} })), true);
  // Control 2: empty page at a non-zero offset = end of pagination, not "no record".
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [], offset: 25 })), false);
  // Control 3: empty page that still advertises more = not "no record".
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [], next_cursor: "abc" })), false);
  // Control 4: offset 0 is the first page and stays classifiable.
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [], offset: 0, next_cursor: null })), true);
  // Control 5: a NON-EMPTY page is never empty, with or without pagination.
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [{ a: 1 }], offset: 0 })), false);
  assertEquals(isProvenEmptyResult("oathnet_lookup", env({ items: [{ a: 1 }], next_cursor: "abc" })), false);
  // And end-to-end through the write path: the mid-scroll empty page stays ok.
  assertEquals(await outcomeOf("oathnet_lookup", "oa-paged", env({ items: [], offset: 25 })), "ok");
});

Deno.test("oathnet_lookup ip-info service (no items key) is not swept in", async () => {
  const ipinfo = { ok: true, status: 200, quota_left: 5, data: { success: true, message: "Ip-Info completed successfully", data: { query: "1.2.3.4", status: "success", city: "X" }, _meta: {} } };
  assertEquals(await outcomeOf("oathnet_lookup", "oa-ipinfo", ipinfo), "ok");
});

// ===========================================================================
// 6. Every write path persists the correct outcome
// ===========================================================================
const NEG = FIXTURES.gravatar_profile.negative;

Deno.test("path: live call persists empty", async () => {
  const { row } = await runOnce("gravatar_profile", "path-live", NEG);
  assertEquals([row.cached, row.outcome, row.ok], [false, "empty", true]);
});

Deno.test("path: NO_CACHE_TOOLS branch runs the resolver and fails closed", async () => {
  // No tool in the predicate table is a NO_CACHE tool today, so this branch proves
  // the payload is threaded and that an unlisted tool cannot be reclassified.
  const { row } = await runOnce("triage_seed", "path-nocache", { ok: true, found: false, count: 0 });
  assertEquals([row.cached, row.outcome, row.ok], [false, "ok", true]);
});

Deno.test("path: memory (thread LRU) cache replay persists empty, not ok", async () => {
  const thread = "path-mem";
  clearRuntime(thread);
  const h = makeDb();
  const wrapped = wrapToolsWithCache(
    { gravatar_profile: makeTool(async () => { h.bump(); return NEG; }) },
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  );
  const exec = wrapped.gravatar_profile.execute as (i: unknown, o: unknown) => Promise<unknown>;
  const input = { email: "probe@mem.example", force: true };
  await exec(input, { toolCallId: "m1", messages: [] });
  clearRuntime(thread);
  await exec(input, { toolCallId: "m2", messages: [] });
  await new Promise((r) => setTimeout(r, 40));
  assertEquals(h.executions(), 1, "second call must be served from the LRU");
  const replay = h.usage.filter((u) => u.cached === true);
  assertEquals(replay.length, 1, "expected exactly one cached replay row");
  assertEquals(replay[0].outcome, "empty", "cached negative replay must log empty");
  assertEquals(replay[0].ok, true);
});

Deno.test("path: memory cache replay of a POSITIVE still persists ok", async () => {
  const thread = "path-mem-pos";
  clearRuntime(thread);
  const h = makeDb();
  const wrapped = wrapToolsWithCache(
    { gravatar_profile: makeTool(async () => { h.bump(); return FIXTURES.gravatar_profile.positive; }) },
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  );
  const exec = wrapped.gravatar_profile.execute as (i: unknown, o: unknown) => Promise<unknown>;
  const input = { email: "probe@mempos.example", force: true };
  await exec(input, { toolCallId: "p1", messages: [] });
  clearRuntime(thread);
  await exec(input, { toolCallId: "p2", messages: [] });
  await new Promise((r) => setTimeout(r, 40));
  const replay = h.usage.filter((u) => u.cached === true);
  assertEquals(replay.length, 1);
  assertEquals(replay[0].outcome, "ok");
});

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const storedRow = (payload: unknown) => ({
  output_json: payload,
  created_at: new Date().toISOString(),
  expires_at: future(),
  source_created_at: new Date().toISOString(),
});

Deno.test("path: input-hash DB cache replay persists empty", async () => {
  const serve = (eqs: Array<[string, unknown]>) =>
    eqs.some(([c]) => c === "input_hash") ? storedRow(NEG) : null;
  const { row, h } = await runOnce("gravatar_profile", "path-dbhash", NEG, { serve });
  assertEquals(h.executions(), 0, "must be served from the durable cache");
  assertEquals([row.cached, row.outcome, row.ok], [true, "empty", true]);
});

Deno.test("path: selector-reuse DB cache replay persists empty", async () => {
  const serve = (eqs: Array<[string, unknown]>) =>
    eqs.some(([c]) => c === "params_hash") ? storedRow(NEG) : null;
  const { row, h } = await runOnce("gravatar_profile", "path-selreuse", NEG, { serve });
  assertEquals(h.executions(), 0, "must be served from the selector-reuse layer");
  assertEquals([row.cached, row.outcome, row.ok], [true, "empty", true]);
  assert((row.input_json as Row)?.runtime !== undefined);
});

// ===========================================================================
// 7. Billing + cacheability invariants for a successful negative
// ===========================================================================
Deno.test("invariant: a leakcheck negative stays CHARGEABLE and CACHEABLE", async () => {
  const { row, h } = await runOnce("leakcheck_lookup", "inv-leakcheck", FIXTURES.leakcheck_lookup.negative);
  assertEquals(row.outcome, "empty");
  assertEquals(row.ok, true, "operational success unchanged");
  assert((row.charged_micro_usd as number) > 0, `negative must still be charged, got ${row.charged_micro_usd}`);
  assert((row.cost_micro_usd as number) > 0, "attributed list price unchanged");
  assertEquals(h.cacheUpserts.length, 1, "negative must still be written to the durable cache");
  assertEquals((h.cacheUpserts[0] as Row).tool_name, "leakcheck_lookup");
});

Deno.test("invariant: the payload handed back to the model is unchanged", async () => {
  const { returned } = await runOnce("gravatar_profile", "inv-payload", NEG);
  const r = returned as Row;
  assertEquals(r.ok, true);
  assertEquals(r.found, false);
  assertEquals(r.status, 404);
  assertEquals(r.hash, "h");
});

// ===========================================================================
// 2b. Failures and intentional skips keep their existing classification
// ===========================================================================
Deno.test("regression: a genuine failure is still classified failed", async () => {
  const { row } = await runOnce("gravatar_profile", "reg-fail",
    { ok: false, status: 500, error: "upstream returned HTTP 500" });
  assertEquals(row.outcome, "failed");
  assertEquals(row.ok, false);
});

Deno.test("regression: a governance skip is still classified skipped", async () => {
  const { row } = await runOnce("gravatar_profile", "reg-skip-gov",
    { ok: false, error: "expected value 52 below 70" });
  assertEquals(row.outcome, "skipped");
});

Deno.test("D1 pin: a TOOL-EMITTED skip keeps its current classification (defect left OPEN)", async () => {
  // deriveOk() checks isIntentionalSkip() BEFORE r.ok, so a result carrying
  // `skipped:true` is logged ok=true and therefore outcome="ok". That is a real,
  // separately-tracked defect. It is deliberately NOT fixed here: changing it would
  // shift `skipped` classifications and break this branch's "no unrelated
  // classification shifts" criterion. This test pins the CURRENT behaviour so the
  // branch is provably scoped, and will need updating when the follow-up lands.
  const { row } = await runOnce("leakcheck_lookup", "reg-skip-tool",
    { ok: false, skipped: true, source: "leakcheck.v2", reason: "name/keyword not supported by LeakCheck v2" });
  assertEquals(row.outcome, "ok", "unchanged by this branch — see the D1 follow-up");
  assertEquals(row.charged_micro_usd, 0, "tool-emitted skips remain free");
});

// ===========================================================================
// 8. Exhaustive scope proof: no unlisted tool can shift
// ===========================================================================
Deno.test("scope: the predicate table is exactly the 14 approved tools", () => {
  assertEquals(Object.keys(PROVEN_EMPTY_PREDICATES).sort(), [
    "census_geocode",
    "gleif_lei_search",
    "gravatar_profile",
    "jina_reader_scrape",
    "leakcheck_lookup",
    "nominatim_geocode",
    "oathnet_lookup",
    "oathnet_stealer_search",
    "oathnet_subdomains",
    "oathnet_victims_search",
    "ransomwarelive_lookup",
    "shodan_internetdb",
    "socialfetch_lookup",
    "wayback_cdx_search",
  ]);
});

Deno.test("scope: no unlisted tool is reclassified, even on a negative-looking payload", () => {
  // Internal/analysis tools and the deliberately-excluded provider tools all emit
  // fields a generic sweep would have caught. None may become empty.
  const decoys: Array<[string, unknown]> = [
    ["memory_recall", { ok: true, count: 0, memories: [] }],
    ["detect_contradictions", { ok: true, count: 0, contradictions: [] }],
    ["opencorporates_search", { ok: true, name: "n", count: 0, companies: [] }],
    ["breach_check", { ok: true, source: "s", data: { success: false, found: 0 } }],
    ["hibp_lookup", { ok: true, source: "hibp.v3", data: { breachCount: 0, pasteCount: 0, breaches: [], pastes: null } }],
    ["dns_records", { ok: true, host: "h", records: { A: [], MX: [] } }],
    ["username_sweep", { ok: true, found: false, count: 0 }],
    ["record_artifacts", { ok: true, count: 0, accepted: [], rejected: [] }],
    ["some_future_tool", { ok: true, found: 0, count: 0, matched: false, listed: false, archived: false }],
  ];
  for (const [tool, payload] of decoys) {
    assertEquals(isProvenEmptyResult(tool, payload), false, `${tool} must not be reclassified`);
  }
});

Deno.test("scope: resolver fails closed on junk input and never throws", () => {
  for (const junk of [null, undefined, 0, "", "str", [], [1, 2], true, NaN]) {
    assertEquals(isProvenEmptyResult("gravatar_profile", junk), false);
    assertEquals(isProvenEmptyResult("unknown_tool", junk), false);
  }
});
