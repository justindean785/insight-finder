// socq_test.ts — SocQ client (submit + bounded poll), tool wiring and free-first gating.
// Every HTTP call is stubbed and the clock is fake: no test reaches api.socq.ai or sleeps.
// Handles and URLs are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import {
  SOCQ_BASE_URL,
  SOCQ_ENDPOINTS,
  SOCQ_MAX_RESULTS,
  SOCQ_SUBMIT_TOOLS,
  SOCQ_TOTAL_TIMEOUT_MS,
  type SocqDeps,
  buildSubmitBody,
  normalizeHandle,
  shapeTask,
  socqSelfTest,
  socqSubmit,
  socqTaskResult,
} from "../../functions/osint-agent/lib/socq.ts";
import * as socqTools from "../../functions/osint-agent/tools/socq.ts";
import { classifyToolOutcome } from "../../functions/osint-agent/tool-outcome.ts";
import { costForTool, costForToolCall } from "../../functions/osint-agent/costs.ts";
import { classifySource } from "../../functions/osint-agent/source-classification.ts";
import { isCacheableToolResult, wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { PAID_GUARD_POLICIES } from "../../functions/osint-agent/lib/paid-provider-guard.ts";
import { GUARDED_PAID_TOOLS } from "../../functions/osint-agent/lib/paid-guard-policies.ts";

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string };

/** Fake deps: a scripted response queue, a fake clock that sleep() advances. */
function fake(responses: Array<Response | Error>, over: Partial<SocqDeps> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: SocqDeps = {
    apiKey: "test-key",
    disabled: false,
    now: () => clock,
    sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    fetch: (url, init) => {
      calls.push({
        url,
        method: String(init.method),
        body: init.body ? JSON.parse(String(init.body)) : null,
        auth: (init.headers as Record<string, string>).Authorization,
      });
      const next = responses.length > 1 ? responses.shift()! : responses[0];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
    },
    ...over,
  };
  return { deps, calls, sleeps, elapsed: () => clock - 1_000_000 };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const submitted = (id = "TASKEXAMPLE001") => json(200, { code: 200, data: { task_id: id, status: "pending" } });
const running = (id = "TASKEXAMPLE001") => json(200, { code: 200, data: { task_id: id, status: "running" } });
const profileDone = (id = "TASKEXAMPLE001", items: unknown[] = [{
  id: "1", platform: "instagram", resource: "profiles", type: "profile", url: "https://www.instagram.com/example.handle/",
  username: "example.handle", name: "Example Person", text: "b".repeat(900), website: "https://example.com/links",
  is_verified: false, is_private: false, location: { name: "Springfield", city: "Springfield", region: "IL", country: "US" },
  metrics: { followers_count: 120, following_count: 80, posts_count: 33 }, avatar_url: "https://example.com/a.jpg",
  cover_url: "https://example.com/c.jpg", collected_at: "2026-11-09T00:00:00Z", extra_field: "dropped",
}]) => json(200, {
  code: 200,
  data: { task_id: id, status: "succeeded", result_count: items.length, credits_amount: 0.6, results: { schema_id: "account", has_more: false, items } },
});

// ---- request building ------------------------------------------------------------------

Deno.test("submit: one POST to /v1/<path> with Bearer auth, the normalized handle, and no callback_url", async () => {
  const f = fake([submitted(), profileDone()]);
  const r = await socqSubmit("socq_instagram_profile", { username: "@Example.Handle" }, f.deps);
  assertEquals(f.calls[0].url, `${SOCQ_BASE_URL}/v1/instagram/profiles`);
  assertEquals(f.calls[0].method, "POST");
  assertEquals(f.calls[0].auth, "Bearer test-key");
  assertEquals(f.calls[0].body, { usernames: ["example.handle"] });
  assertEquals(f.calls[1].url, `${SOCQ_BASE_URL}/v1/tasks/TASKEXAMPLE001?view=standard&limit=1`);
  assertEquals(r.ok, true);
});

Deno.test("submit: list endpoints ALWAYS send a clamped results_limit (linkedin/profile-posts defaults to 100 otherwise)", () => {
  const ep = SOCQ_ENDPOINTS.socq_linkedin_posts;
  const url = "https://www.linkedin.com/in/example-person/";
  const def = buildSubmitBody(ep, { url });
  const big = buildSubmitBody(ep, { url, results_limit: 500 });
  const tiny = buildSubmitBody(ep, { url, results_limit: 0 });
  assert("body" in def && "body" in big && "body" in tiny);
  assertEquals(def.body.results_limit, 10);
  assertEquals(big.body.results_limit, SOCQ_MAX_RESULTS);
  assertEquals(tiny.body.results_limit, 1);
  const fc = buildSubmitBody(SOCQ_ENDPOINTS.socq_instagram_followers_count, { username: "example", results_limit: 25 });
  assert("body" in fc);
  assertEquals(fc.body.results_limit, 1, "followers-count is one record per username");
  for (const tool of SOCQ_SUBMIT_TOOLS) {
    const ep2 = SOCQ_ENDPOINTS[tool];
    const sample = ep2.input === "usernames" ? { username: "example" }
      : ep2.input === "query" ? { query: "example search" }
      : { url: ep2.path.startsWith("instagram") ? "https://www.instagram.com/p/ABC123/" : ep2.path === "linkedin/companies" ? "https://www.linkedin.com/company/example/" : "https://www.linkedin.com/in/example/" };
    const built = buildSubmitBody(ep2, sample);
    assert("body" in built, `${tool} sample did not build`);
    assertEquals("callback_url" in built.body, false, tool);
    if (ep2.limited) assert(typeof built.body.results_limit === "number", `${tool} must send results_limit`);
  }
});

Deno.test("submit: a bad handle, a wrong-kind URL or a punctuated Instagram query is gated before any call", async () => {
  for (const [tool, input] of [
    ["socq_instagram_profile", { username: "not a handle!" }],
    ["socq_x_profile", { username: "this_handle_is_far_too_long_for_x" }],
    ["socq_linkedin_profile", { url: "https://www.linkedin.com/company/example/" }],
    ["socq_linkedin_company", { url: "https://example.com/company/x" }],
    ["socq_instagram_post_info", { url: "https://www.instagram.com/example.handle/" }],
    ["socq_instagram_search", { query: "example, person!" }],
  ] as const) {
    const f = fake([submitted()]);
    const r = await socqSubmit(tool, input, f.deps);
    assertEquals(f.calls.length, 0, `${tool} ${JSON.stringify(input)}`);
    assertEquals(r.provider_attempted, false);
    assertEquals(classifyToolOutcome(r.error as string, null), "skipped");
  }
});

Deno.test("normalizeHandle: strips @ and case, enforces each platform's charset", () => {
  assertEquals(normalizeHandle("@Example.Handle", "instagram"), "example.handle");
  assertEquals(normalizeHandle("example.handle", "x"), null, "X handles have no dots");
  assertEquals(normalizeHandle("@Example_Handle", "x"), "example_handle");
});

// ---- polling ------------------------------------------------------------------------------

Deno.test("poll: backs off 2s → 3s → 5s until succeeded, then returns trimmed records with provenance", async () => {
  const f = fake([submitted(), running(), running(), profileDone()]);
  const r = await socqSubmit("socq_instagram_profile", { username: "example.handle" }, f.deps);
  assertEquals(f.sleeps, [2000, 3000, 5000]);
  assertEquals(r.ok, true);
  assertEquals(r.provider, "socq");
  assertEquals(r.endpoint, "instagram/profiles");
  assertEquals(r.task_id, "TASKEXAMPLE001");
  assertEquals(r.credits_amount, 0.6);
  assert(typeof r.captured_at === "string");
  assert(String(r.linkage).startsWith("unverified"));
  const item = (r.items as Array<Record<string, unknown>>)[0];
  assertEquals(item.website, "https://example.com/links");
  assertEquals(item.location, "Springfield, IL, US");
  assertEquals(item.followers_count, 120);
  assertEquals(String(item.bio).length, 400);
  assertEquals("extra_field" in item, false);
  assertEquals("cover_url" in item, false);
});

Deno.test("poll: a task still running at the deadline returns pending + task_id, never cached, within the budget", async () => {
  const f = fake([submitted("TASKSLOW00001"), running("TASKSLOW00001")]);
  const r = await socqSubmit("socq_x_profile", { username: "example_handle" }, f.deps);
  assertEquals(r.ok, true);
  assertEquals(r.pending, true);
  assertEquals(r.partial, true);
  assertEquals(r.task_id, "TASKSLOW00001");
  assertEquals((r.read_with as Record<string, unknown>).tool, "socq_task_result");
  assert(f.elapsed() <= SOCQ_TOTAL_TIMEOUT_MS, `polled ${f.elapsed()}ms past the ${SOCQ_TOTAL_TIMEOUT_MS}ms budget`);
  assertEquals(isCacheableToolResult(r), false, "a pending snapshot must never be replayed from cache");
  assertEquals(f.calls.filter((c) => c.method === "POST").length, 1, "exactly one submit");
});

Deno.test("poll: a transient 5xx or 429 on a poll is retried inside the budget; a 404 ends it", async () => {
  const f = fake([submitted(), json(503, {}), json(429, {}), profileDone()]);
  const r = await socqSubmit("socq_instagram_profile", { username: "example.handle" }, f.deps);
  assertEquals(r.ok, true);
  const g = fake([submitted(), json(404, { code: 404, error: { message: "task gone", type: "not_found" } })]);
  const r404 = await socqSubmit("socq_instagram_profile", { username: "example.handle" }, g.deps);
  assertEquals(r404.error, "socq tasks HTTP 404");
  // A missing TASK is not "the target has no record": no `status:404` (read as empty), logged failed.
  assertEquals(r404.status, undefined);
  assertEquals(r404.http_status, 404);
  assertEquals(classifyToolOutcome(r404.error as string, (r404.status as number | undefined) ?? null), "failed");
});

Deno.test("results: a failed task is FAILED; a succeeded task with no records is EMPTY", async () => {
  const failed = await socqSubmit("socq_instagram_profile", { username: "example.handle" }, fake([
    submitted(), json(200, { code: 200, data: { task_id: "TASKEXAMPLE001", status: "failed", error_message: "profile unavailable: example detail" } }),
  ]).deps);
  assertEquals(failed.error, "socq task failed");
  assertEquals(failed.provider_message, "profile unavailable: example detail");
  assertEquals(classifyToolOutcome(failed.error as string, null), "failed");
  const empty = await socqSubmit("socq_instagram_profile", { username: "example.handle" }, fake([submitted(), profileDone("TASKEXAMPLE001", [])]).deps);
  assertEquals(empty.empty, true);
  assertEquals(classifyToolOutcome(empty.error as string, null), "empty");
});

Deno.test("errors: 402/429 log as skipped, 422/401 as failed, provider text never in error; a submit timeout says do not resubmit", async () => {
  const r402 = await socqSubmit("socq_x_profile", { username: "example" }, fake([json(402, { code: 402, error: { message: "Insufficient credits", type: "payment_required" } })]).deps);
  assertEquals(classifyToolOutcome(r402.error as string, 402), "skipped");
  const r429 = await socqSubmit("socq_x_profile", { username: "example" }, fake([json(429, { code: 429, error: { message: "slow", type: "rate_limit" } }, { "retry-after": "30" })]).deps);
  assertEquals(classifyToolOutcome(r429.error as string, 429), "skipped");
  assertEquals(r429.retry_after_s, 30);
  const r422 = await socqSubmit("socq_x_profile", { username: "example" }, fake([json(422, { code: 422, error: { message: "invalid_field_type:usernames secret", type: "validation_error" } })]).deps);
  assertEquals(r422.error, "socq x/profiles HTTP 422");
  assertEquals(classifyToolOutcome(r422.error as string, 422), "failed");
  const timeout = await socqSubmit("socq_x_profile", { username: "example" }, fake([Object.assign(new Error("t"), { name: "TimeoutError" })]).deps);
  assertEquals(timeout.error, "socq x/profiles submit timed out");
  assert(String(timeout.note).includes("Do not resubmit"));
});

Deno.test("gate: missing key and SOCQ_DISABLED never reach the provider and log as skipped", async () => {
  for (const over of [{ apiKey: undefined }, { disabled: true }]) {
    const f = fake([submitted()], over);
    const r = await socqSubmit("socq_instagram_profile", { username: "example" }, f.deps);
    assertEquals(f.calls.length, 0);
    assertEquals(r.provider_attempted, false);
    assertEquals(classifyToolOutcome(r.error as string, null), "skipped");
  }
});

Deno.test("socq_task_result: reads a finished task at once (no sleep), rejects a malformed id without a call", async () => {
  const f = fake([profileDone("TASKDONE00001")]);
  const r = await socqTaskResult({ task_id: "TASKDONE00001" }, f.deps);
  assertEquals(f.sleeps, []);
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].method, "GET");
  assertEquals(r.ok, true);
  const g = fake([profileDone()]);
  const bad = await socqTaskResult({ task_id: "../../v1/account" }, g.deps);
  assertEquals(g.calls.length, 0);
  assertEquals(classifyToolOutcome(bad.error as string, null), "skipped");
});

Deno.test("shapeTask: account / post / company schemas keep only analyst fields", () => {
  const post = shapeTask({ data: { task_id: "T1", status: "succeeded", results: { schema_id: "post", items: [{
    url: "https://x.com/example/status/1", text: "t".repeat(800), author: { username: "example" }, hashtags: Array(20).fill("h"),
    media: [{ url: "https://example.com/m.jpg" }], metrics: { likes: 1 },
  }] } } }, { endpoint: "x/user-posts", maxItems: 10 });
  const p = (post.items as Array<Record<string, unknown>>)[0];
  assertEquals(String(p.text).length, 400);
  assertEquals(p.author, "example");
  assertEquals((p.hashtags as string[]).length, 10);
  assertEquals("media" in p, false);
  const company = shapeTask({ data: { task_id: "T2", status: "succeeded", results: { schema_id: "company", items: [{
    name: "Example Corp", website: "https://example.com", industry: "Software", logo_url: "https://example.com/l.png",
  }] } } }, { endpoint: "linkedin/companies", maxItems: 1 });
  const c = (company.items as Array<Record<string, unknown>>)[0];
  assertEquals(c.name, "Example Corp");
  assertEquals("logo_url" in c, false);
});

// ---- wiring --------------------------------------------------------------------------------

const ALL = [...SOCQ_SUBMIT_TOOLS, "socq_task_result"];

Deno.test("costs: single-record tools at one record, list tools scale with results_limit; task_result is free", () => {
  assertEquals(costForTool("socq_instagram_profile"), 6000);
  assertEquals(costForTool("socq_linkedin_profile"), 25000);
  assertEquals(costForTool("socq_task_result"), 0);
  assertEquals(costForToolCall("socq_linkedin_posts", {}), 100000);
  assertEquals(costForToolCall("socq_linkedin_posts", { results_limit: 3 }), 30000);
  assertEquals(costForToolCall("socq_linkedin_posts", { results_limit: 999 }), 250000);
  assertEquals(costForToolCall("socq_instagram_profile", { results_limit: 25 }), 6000);
});

Deno.test("classes and the guard: every SocQ tool is a passive social observation; every submit tool is guarded", () => {
  for (const t of ALL) assertEquals(classifySource(t), "social_profile_passive", t);
  for (const t of SOCQ_SUBMIT_TOOLS) {
    assert(GUARDED_PAID_TOOLS.includes(t), `${t} must be free-first guarded`);
    assert(PAID_GUARD_POLICIES.has(t), `${t} policy registered`);
  }
  assertEquals(PAID_GUARD_POLICIES.has("socq_task_result"), false, "reading a task is free and never guarded");
  assertEquals(PAID_GUARD_POLICIES.get("socq_instagram_profile")!.rules[0].tools, ["socialfetch_lookup"]);
  assertEquals(PAID_GUARD_POLICIES.get("socq_linkedin_profile")!.rules[0].tools, ["jina_reader_scrape", "socialfetch_web_read"]);
  assertEquals(PAID_GUARD_POLICIES.get("socq_x_search")!.rules, []);
});

Deno.test("tools: each submit tool takes exactly one selector field; only list tools take results_limit", () => {
  for (const t of SOCQ_SUBMIT_TOOLS) {
    const ep = SOCQ_ENDPOINTS[t];
    const shape = ((socqTools as Record<string, unknown>)[t] as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
    const keys = Object.keys(shape).filter((k) => !["force_second_source", "second_source_justification"].includes(k));
    const selector = ep.input === "usernames" ? "username" : ep.input === "urls" ? "url" : "query";
    const expected = ep.limited && ep.fixedLimit === undefined ? [selector, "results_limit"] : [selector];
    assertEquals(keys.sort(), expected.sort(), t);
  }
});

Deno.test("/health self-test passes and reports configuration without calling the provider", () => {
  const h = socqSelfTest(true, false);
  assertEquals(h.ok, true, h.detail);
  assertEquals(h.tools, 12);
  assert(socqSelfTest(true, true).detail.includes("SOCQ_DISABLED"));
});

Deno.test("wiring: registry, capability gate, planner list, catalog and /health name every SocQ tool", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../../functions/osint-agent/${p}`, import.meta.url));
  const [registry, caps, catalog, health] = await Promise.all([read("tool-registry.ts"), read("capabilities.ts"), read("catalog.ts"), read("health-handler.ts")]);
  for (const t of ALL) {
    assert(registry.includes(`(tools as ToolRegistry).${t} = ${t};`), `${t} attached`);
    assert(caps.includes(`${t}: { requiresKey: "SOCQ_API_KEY" }`), `${t} key-gated`);
    assert(catalog.includes(`name: "${t}"`), `${t} in catalog`);
  }
  assert(health.includes("r.checks.socq = socqHealth;"));
});

// ---- free-first through the REAL wrap path, with the REAL tool and a stubbed fetch ------------

type SupabaseClient = ReturnType<typeof createClient>;
function makeChain(v: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(v);
  node.then = (r: (x: { data: unknown; error: unknown }) => void) => r(v);
  node.insert = () => Promise.resolve({ error: null });
  node.upsert = () => Promise.resolve({ error: null });
  return node;
}
const fakeDb = () => ({ from: () => makeChain({ data: [], error: null }), rpc: () => Promise.resolve({ data: null, error: null }) }) as unknown as SupabaseClient;
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };

async function withSocqEnv(fn: (posts: string[]) => Promise<void>) {
  const origFetch = globalThis.fetch;
  const prevKey = Deno.env.get("SOCQ_API_KEY");
  Deno.env.set("SOCQ_API_KEY", "test-key");
  const posts: string[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(String(url)); return Promise.resolve(submitted()); }
    return Promise.resolve(profileDone());
  }) as typeof fetch;
  try { await fn(posts); } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) Deno.env.delete("SOCQ_API_KEY"); else Deno.env.set("SOCQ_API_KEY", prevKey);
  }
}

let seq = 0;
function wrapWith(tools: Record<string, Tool>) {
  seq += 1;
  const investigationId = `66666666-7777-4888-8999-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache(tools, { investigationId, userId: "u1", supabase: fakeDb() });
}

Deno.test("guard: socq_instagram_profile is refused until socialfetch_lookup fails on the same handle, then submits once", () =>
  withSocqEnv(async (posts) => {
    const socialfetch = { description: "t", execute: () => Promise.resolve({ ok: false, empty: true, error: "socialfetch: no usable result" }) } as unknown as Tool;
    const w = wrapWith({ socq_instagram_profile: socqTools.socq_instagram_profile as unknown as Tool, socialfetch_lookup: socialfetch });
    const first = await (w.socq_instagram_profile as unknown as Exec).execute({ username: "@Example.Handle" }, {});
    assertEquals(first.paid_guard, "free_first");
    assertEquals(posts.length, 0);
    await (w.socialfetch_lookup as unknown as Exec).execute({ platform: "instagram", handle: "example.handle" }, {});
    const second = await (w.socq_instagram_profile as unknown as Exec).execute({ username: "@Example.Handle" }, {});
    assertEquals(posts, [`${SOCQ_BASE_URL}/v1/instagram/profiles`]);
    assertEquals(second.ok, true);
  }));

Deno.test("guard: a search tool is refused no_selector unless force_second_source + justification", () =>
  withSocqEnv(async (posts) => {
    const w = wrapWith({ socq_x_search: socqTools.socq_x_search as unknown as Tool });
    const refused = await (w.socq_x_search as unknown as Exec).execute({ query: "example search terms" }, {});
    assertEquals(refused.paid_guard, "no_selector");
    assertEquals(posts.length, 0);
    await (w.socq_x_search as unknown as Exec).execute({
      query: "example search terms", force_second_source: true, second_source_justification: "discovering accounts for an unverified lead",
    }, {});
    assertEquals(posts, [`${SOCQ_BASE_URL}/v1/x/search`]);
  }));

Deno.test("guard: socq_task_result is never gated", () =>
  withSocqEnv(async () => {
    const w = wrapWith({ socq_task_result: socqTools.socq_task_result as unknown as Tool });
    const r = await (w.socq_task_result as unknown as Exec).execute({ task_id: "TASKEXAMPLE001" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.refused_by, undefined);
  }));
