// contextdev_test.ts — Context.dev client, tool wiring and free-first gating.
// Every HTTP call is stubbed; no test reaches api.context.dev. Selectors are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import {
  CONTEXT_DEV_BASE_URL,
  SCRAPE_MAX_CHARS,
  buildPeopleQuery,
  contextDevPeopleSearch,
  contextDevScrape,
  contextDevSelfTest,
  normalizeScrapeUrl,
  type ContextDevDeps,
} from "../../functions/osint-agent/lib/contextdev.ts";
import { contextdev_people_search, contextdev_scrape } from "../../functions/osint-agent/tools/contextdev.ts";
import { classifyToolOutcome } from "../../functions/osint-agent/tool-outcome.ts";
import { costForTool } from "../../functions/osint-agent/costs.ts";
import { classifySource } from "../../functions/osint-agent/source-classification.ts";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { PAID_GUARD_POLICIES } from "../../functions/osint-agent/lib/paid-provider-guard.ts";
import { GUARDED_PAID_TOOLS } from "../../functions/osint-agent/lib/paid-guard-policies.ts";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function deps(handler: (call: Call) => Response, over: Partial<ContextDevDeps> = {}): { deps: ContextDevDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      apiKey: "test-key",
      disabled: false,
      fetch: (url, init) => {
        const call = { url, init, body: JSON.parse(String(init.body ?? "{}")) };
        calls.push(call);
        return Promise.resolve(handler(call));
      },
      ...over,
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const scrapeOk = (data: string) => json(200, {
  url: "https://example.com/protected",
  markdown: { requested: true, success: true, data },
  metadata: { title: "Example page" },
  cache_metadata: { status: "miss", age_ms: 0 },
  key_metadata: { credits_consumed: 1, credits_remaining: 99 },
});

// ---- scrape ------------------------------------------------------------------------

Deno.test("scrape: sends one POST to /web/scrape with Bearer auth, Markdown only, main content only", async () => {
  const { deps: d, calls } = deps(() => scrapeOk("# Hello"));
  const r = await contextDevScrape({ url: "https://example.com/protected?utm_source=x#frag" }, d);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${CONTEXT_DEV_BASE_URL}/web/scrape`);
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");
  assertEquals(calls[0].body.url, "https://example.com/protected");
  assertEquals(calls[0].body.formats, { markdown: true });
  assertEquals((calls[0].body.sharedParams as Record<string, unknown>).mainContentOnly, true);
  assertEquals("maxAgeMs" in calls[0].body, false, "the provider cache is used unless fresh is asked for");
  assertEquals(r.ok, true);
  assertEquals(r.markdown, "# Hello");
  assertEquals(r.title, "Example page");
  assertEquals(r.credits_consumed, 1);
  assertEquals(r.source, "context.dev");
  assert(typeof r.captured_at === "string");
});

Deno.test("scrape: fresh:true sends maxAgeMs 0", async () => {
  const { deps: d, calls } = deps(() => scrapeOk("x"));
  await contextDevScrape({ url: "https://example.com/a", fresh: true }, d);
  assertEquals(calls[0].body.maxAgeMs, 0);
});

Deno.test("scrape: Markdown is capped at 8,000 chars and marked truncated", async () => {
  const { deps: d } = deps(() => scrapeOk("y".repeat(SCRAPE_MAX_CHARS + 500)));
  const r = await contextDevScrape({ url: "https://example.com/a" }, d);
  assertEquals(String(r.markdown).length, SCRAPE_MAX_CHARS);
  assertEquals(r.truncated, true);
  assertEquals(r.chars, SCRAPE_MAX_CHARS + 500);
});

Deno.test("scrape: an empty page is an EMPTY outcome; a failed output is FAILED with the provider code", async () => {
  const empty = await contextDevScrape({ url: "https://example.com/a" }, deps(() => scrapeOk("   ")).deps);
  assertEquals(empty.empty, true);
  assertEquals(classifyToolOutcome(empty.error as string, null), "empty");
  const failed = await contextDevScrape({ url: "https://example.com/a" }, deps(() =>
    json(200, { url: "https://example.com/a", markdown: { requested: true, success: false, data: null, error_code: "TARGET_BLOCKED", message: "blocked by origin" } })
  ).deps);
  assertEquals(failed.ok, false);
  assertEquals(failed.error, "context.dev scrape failed (TARGET_BLOCKED)");
  assertEquals(failed.provider_message, "blocked by origin");
  assertEquals(classifyToolOutcome(failed.error as string, null), "failed");
});

Deno.test("scrape: 402 and 429 log as skipped (balance/rate), 500 as failed; provider text never reaches error", async () => {
  const r402 = await contextDevScrape({ url: "https://example.com/a" }, deps(() => json(402, { message: "out of credits", error_code: "INSUFFICIENT" })).deps);
  assertEquals(classifyToolOutcome(r402.error as string, 402), "skipped");
  assertEquals(r402.provider_message, "out of credits");
  const r429 = await contextDevScrape({ url: "https://example.com/a" }, deps(() => json(429, { message: "slow down" }, { "retry-after": "7" })).deps);
  assertEquals(classifyToolOutcome(r429.error as string, 429), "skipped");
  assertEquals(r429.retry_after_s, 7);
  const r500 = await contextDevScrape({ url: "https://example.com/a" }, deps(() => json(500, { message: "internal: example.com secret" })).deps);
  assertEquals(classifyToolOutcome(r500.error as string, 500), "failed");
  assertEquals(String(r500.error).includes("secret"), false);
});

Deno.test("scrape: a timeout or network error is a failure, never a throw", async () => {
  const timeout = await contextDevScrape({ url: "https://example.com/a" }, {
    apiKey: "k", disabled: false, fetch: () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
  });
  assertEquals(timeout.error, "context.dev web/scrape timed out");
  const net = await contextDevScrape({ url: "https://example.com/a" }, {
    apiKey: "k", disabled: false, fetch: () => Promise.reject(new TypeError("dns")),
  });
  assertEquals(net.error, "context.dev web/scrape network error");
});

Deno.test("scrape: missing key, kill switch and non-http URLs never reach the provider and log as skipped", async () => {
  for (const [over, url] of [
    [{ apiKey: undefined }, "https://example.com/a"],
    [{ disabled: true }, "https://example.com/a"],
    [{}, "javascript:alert(1)"],
    [{}, "ftp://example.com/file"],
  ] as const) {
    const { deps: d, calls } = deps(() => scrapeOk("x"), over as Partial<ContextDevDeps>);
    const r = await contextDevScrape({ url }, d);
    assertEquals(calls.length, 0, `${JSON.stringify(over)} ${url}`);
    assertEquals(r.provider_attempted, false);
    assertEquals(classifyToolOutcome(r.error as string, null), "skipped");
  }
});

Deno.test("normalizeScrapeUrl: scheme added, fragment and tracking params dropped, real params kept", () => {
  assertEquals(normalizeScrapeUrl("example.com/a"), "https://example.com/a");
  assertEquals(normalizeScrapeUrl("https://example.com/a?id=2&fbclid=z&utm_medium=q#x"), "https://example.com/a?id=2");
  assertEquals(normalizeScrapeUrl("   "), null);
});

// ---- people search -----------------------------------------------------------------

const peoplePage = (n: number, cursor: string | null = "next-page") => json(200, {
  results: Array.from({ length: n }, (_v, i) => ({
    name: `Jane Example ${i}`,
    description: "d".repeat(400),
    profiles: ["https://example.com/in/jane", "https://example.org/jane", "not-a-url", "https://example.net/1", "https://example.net/2", "https://example.net/3", "https://example.net/4"],
    location: { country_code: "US", region: "Illinois", city: "Springfield" },
    role: { title: "Engineer", seniority: null, functions: [], started_on: null, company: { name: "Example Corp", domain: "example.com" } },
    years_of_experience: 5, is_founder: false, skills: ["a", "b"], schools: ["x"],
  })),
  next_cursor: cursor,
  key_metadata: { credits_consumed: 10, credits_remaining: 90 },
});

Deno.test("people: one page only — no cursor is ever sent, more_available is reported", async () => {
  const { deps: d, calls } = deps(() => peoplePage(3));
  const r = await contextDevPeopleSearch({ name: "Jane Example", company: "Example Corp" }, d);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${CONTEXT_DEV_BASE_URL}/people/search`);
  assertEquals("cursor" in calls[0].body, false);
  assertEquals(calls[0].body.mode, "fast");
  assertEquals(calls[0].body.query, "Jane Example, at Example Corp");
  assertEquals(r.more_available, true);
  assertEquals(r.count, 3);
  assertEquals(r.credits_consumed, 10);
  assert(String(r.linkage).startsWith("unverified"));
});

Deno.test("people: each person is trimmed (≤5 http profiles, bounded description, no skills/schools)", async () => {
  const r = await contextDevPeopleSearch({ name: "Jane Example", city: "Springfield" }, deps(() => peoplePage(1)).deps);
  const p = (r.people as Array<Record<string, unknown>>)[0];
  assertEquals((p.profiles as string[]).length, 5);
  assert((p.profiles as string[]).every((u) => u.startsWith("https://")));
  assert(String(p.description).length <= 240);
  assertEquals(p.company, "Example Corp");
  assertEquals(p.location, "Springfield, Illinois, US");
  assertEquals("skills" in p, false);
  assertEquals("schools" in p, false);
});

Deno.test("people: a name without an anchor, or a one-word name, is gated before any call", async () => {
  for (const input of [{ name: "Jane Example" }, { name: "Jane", company: "Example Corp" }]) {
    const { deps: d, calls } = deps(() => peoplePage(1));
    const r = await contextDevPeopleSearch(input, d);
    assertEquals(calls.length, 0, JSON.stringify(input));
    assertEquals(r.provider_attempted, false);
    assertEquals(classifyToolOutcome(r.error as string, null), "skipped");
  }
  assertEquals(buildPeopleQuery({ name: "Jane Example", title: "Engineer", company: "Example Corp", city: "Springfield" }),
    "Jane Example, Engineer, at Example Corp, in Springfield");
});

Deno.test("people: a valid country becomes a filter; an invalid one is dropped; no results is EMPTY", async () => {
  const { deps: d, calls } = deps(() => peoplePage(0, null));
  const r = await contextDevPeopleSearch({ name: "Jane Example", city: "Springfield", country: "us" }, d);
  assertEquals(calls[0].body.filters, { countries: ["US"] });
  assertEquals(r.empty, true);
  assertEquals(classifyToolOutcome(r.error as string, null), "empty");
  const bad = deps(() => peoplePage(1));
  await contextDevPeopleSearch({ name: "Jane Example", city: "Springfield", country: "USA" }, bad.deps);
  assertEquals("filters" in bad.calls[0].body, false);
});

// ---- wiring --------------------------------------------------------------------------

Deno.test("costs, classes and the guarded set are what the PR states", () => {
  assertEquals(costForTool("contextdev_scrape"), 4000);
  assertEquals(costForTool("contextdev_people_search"), 40000);
  assertEquals(classifySource("contextdev_scrape"), "independent_public");
  assertEquals(classifySource("contextdev_people_search"), "data_broker");
  assert(GUARDED_PAID_TOOLS.includes("contextdev_scrape") && GUARDED_PAID_TOOLS.includes("contextdev_people_search"));
  for (const t of GUARDED_PAID_TOOLS) assert(PAID_GUARD_POLICIES.has(t), t);
  assertEquals(PAID_GUARD_POLICIES.get("contextdev_scrape")!.rules[0].tools, ["jina_reader_scrape", "socialfetch_web_read"]);
  assertEquals(PAID_GUARD_POLICIES.get("contextdev_people_search")!.rules[0].tools, ["indicia_person"]);
});

Deno.test("/health self-test passes and reports configuration without calling the provider", () => {
  const h = contextDevSelfTest(true, false);
  assertEquals(h.ok, true, h.detail);
  assertEquals(contextDevSelfTest(false, false).configured, false);
  assert(contextDevSelfTest(true, true).detail.includes("CONTEXT_DEV_DISABLED"));
});

// ---- free-first through the REAL wrap path, with the REAL tool and a stubbed fetch ----

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
const fakeDb = () => ({
  from: () => makeChain({ data: [], error: null }),
  rpc: () => Promise.resolve({ data: null, error: null }),
}) as unknown as SupabaseClient;

Deno.test("guard: contextdev_scrape is refused until jina fails on the same URL, then it calls the provider once", async () => {
  const origFetch = globalThis.fetch;
  const prevKey = Deno.env.get("CONTEXT_DEV_API_KEY");
  Deno.env.set("CONTEXT_DEV_API_KEY", "test-key");
  const providerCalls: string[] = [];
  globalThis.fetch = ((url: string | URL | Request) => {
    providerCalls.push(String(url));
    return Promise.resolve(scrapeOk("# Protected page"));
  }) as typeof fetch;
  try {
    const investigationId = "55555555-6666-4777-8888-000000000001";
    clearRuntime(investigationId);
    circuit.clearThread(investigationId);
    const jina = { description: "t", execute: () => Promise.resolve({ ok: false, error: "jina 403", origin_error: true, target_status: 403 }) } as unknown as Tool;
    const w = wrapToolsWithCache({ contextdev_scrape: contextdev_scrape as unknown as Tool, jina_reader_scrape: jina }, {
      investigationId, userId: "u1", supabase: fakeDb(),
    });
    type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
    const first = await (w.contextdev_scrape as unknown as Exec).execute({ url: "https://example.com/protected" }, {});
    assertEquals(first.paid_guard, "free_first");
    assertEquals(providerCalls.length, 0, "refused before any provider call");
    await (w.jina_reader_scrape as unknown as Exec).execute({ url: "https://example.com/protected" }, {});
    const second = await (w.contextdev_scrape as unknown as Exec).execute({ url: "https://example.com/protected" }, {});
    assertEquals(second.ok, true);
    assertEquals(providerCalls.length, 1);
    assertEquals(providerCalls[0], `${CONTEXT_DEV_BASE_URL}/web/scrape`);
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) Deno.env.delete("CONTEXT_DEV_API_KEY"); else Deno.env.set("CONTEXT_DEV_API_KEY", prevKey);
  }
});

Deno.test("tools: the AI SDK defs pass inputs through and never expose a cursor or page parameter", () => {
  const shape = (contextdev_people_search as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
  assertEquals(Object.keys(shape).sort(), ["city", "company", "country", "force_second_source", "name", "second_source_justification", "title"]);
  const scrapeShape = (contextdev_scrape as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape;
  assertEquals(Object.keys(scrapeShape).sort(), ["force_second_source", "fresh", "second_source_justification", "url"]);
});

Deno.test("wiring: registry, capability gate, planner list, catalog and /health all name both tools", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../../functions/osint-agent/${p}`, import.meta.url));
  const [registry, caps, catalog, health, prompt] = await Promise.all([
    read("tool-registry.ts"), read("capabilities.ts"), read("catalog.ts"), read("health-handler.ts"), read("system-prompt.ts"),
  ]);
  for (const t of ["contextdev_scrape", "contextdev_people_search"]) {
    assert(registry.includes(`(tools as ToolRegistry).${t} = ${t};`), `${t} attached`);
    assert(caps.includes(`${t}: { requiresKey: "CONTEXT_DEV_API_KEY" }`), `${t} key-gated`);
    assert(catalog.includes(`name: "${t}"`), `${t} in catalog`);
  }
  assert(registry.includes('"contextdev_scrape","contextdev_people_search"'), "planner base list");
  assert(health.includes("r.checks.contextdev = contextDevSelfTest("));
  assert(prompt.includes("contextdev_scrape"));
});
