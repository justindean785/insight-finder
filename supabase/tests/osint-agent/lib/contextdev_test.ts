// lib/contextdev_test.ts — the Context.dev client (lib/contextdev.ts), driven with a
// scripted fetch and a fake clock so retries and Retry-After waits run in milliseconds.
//
// Contract under test: https://docs.context.dev/api-reference/{web/search,web/scrape,
// people/search}.md and account/credits.md, read 2026-11-03. Every request shape and
// status code below is taken from those pages.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONTEXT_DEV_BASE_URL,
  CONTEXT_DEV_ERRORS,
  CONTEXT_DEV_RETRY_AFTER_CAP_MS,
  CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS,
  canonicalUrl,
  contextdevGate,
  contextdevHealthDetail,
  contextdevRequest,
  dedupByUrl,
  CONTEXT_DEV_HIGHLIGHTS_MAX,
  CONTEXT_DEV_HIGHLIGHT_MAX_CHARS,
  CONTEXT_DEV_MARKDOWN_MAX_CHARS,
  CONTEXT_DEV_SNIPPET_MAX_CHARS,
  contextdevPeopleSearch,
  contextdevScrape,
  contextdevWebSearch,
  type ContextDevDeps,
} from "../../../functions/osint-agent/lib/contextdev.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Reply = Response | (() => Response) | Error;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Scripted Context.dev: replies in order, the last one repeating. A fake clock
 *  advances 300 ms per request and by the full amount on every sleep. */
export function harness(opts: { replies?: Reply[]; apiKey?: string | undefined; disabled?: boolean; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const replies = [...(opts.replies ?? [])];
  const take = (): Response => {
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (!r) throw new Error("unscripted request");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  };
  const deps: ContextDevDeps = {
    apiKey: "apiKey" in opts ? opts.apiKey : "test_key",
    disabled: opts.disabled ?? false,
    fetch: (url, init) => {
      calls.push({
        method: String(init.method ?? "GET"),
        url,
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      clock += 300;
      return Promise.resolve(take());
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    signal: opts.signal,
  };
  return { deps, calls, elapsed: () => clock - 1_000_000 };
}

// ── Gate ────────────────────────────────────────────────────────────────────

Deno.test("gate: missing key → not-configured skip, provider never attempted", () => {
  assertEquals(contextdevGate({ apiKey: undefined, disabled: false }), {
    error: CONTEXT_DEV_ERRORS.not_configured,
    skipped: true,
    provider_attempted: false,
  });
});

Deno.test("gate: kill switch → disabled skip", () => {
  assertEquals(contextdevGate({ apiKey: "k", disabled: true }), {
    error: CONTEXT_DEV_ERRORS.disabled,
    skipped: true,
    provider_attempted: false,
  });
});

Deno.test("gate: key present and enabled → null (proceed)", () => {
  assertEquals(contextdevGate({ apiKey: "k", disabled: false }), null);
});

// ── URL canonicalisation + in-run dedup ─────────────────────────────────────

Deno.test("canonicalUrl: lowercases scheme+host, strips tracking params, drops hash, keeps path case", () => {
  assertEquals(canonicalUrl("HTTPS://Example.COM/Path?utm_source=x&b=2&fbclid=1#frag"), "https://example.com/Path?b=2");
  assertEquals(canonicalUrl("https://example.com/"), "https://example.com/");
  assertEquals(canonicalUrl("https://example.com"), "https://example.com/");
  assertEquals(canonicalUrl("https://example.com/a/?gclid=1&igshid=2&mc_cid=3&mc_eid=4"), "https://example.com/a/");
});

Deno.test("canonicalUrl: non-http schemes, bare text and non-strings → null, never a throw", () => {
  assertEquals(canonicalUrl("javascript:alert(1)"), null);
  assertEquals(canonicalUrl("not a url"), null);
  assertEquals(canonicalUrl(42), null);
  assertEquals(canonicalUrl(null), null);
  assertEquals(canonicalUrl("ftp://example.com/x"), null);
});

Deno.test("dedupByUrl: same URL twice in one batch → one kept, deduped 1, invalid counted; seen set carries across calls", () => {
  const seen = new Set<string>();
  const a = dedupByUrl([{ url: "https://a.com/x?utm_source=1" }, { url: "https://A.com/x" }, { url: "nope" }], seen);
  assertEquals(a.kept.length, 1);
  assertEquals(a.kept[0].url, "https://a.com/x?utm_source=1", "the original value is preserved for evidence");
  assertEquals(a.deduped, 1);
  assertEquals(a.dropped_invalid, 1);
  const b = dedupByUrl([{ url: "https://a.com/x" }, { url: "https://b.com/" }], seen);
  assertEquals(b.kept.map((k) => k.url), ["https://b.com/"]);
  assertEquals(b.deduped, 1);
  assertEquals(b.dropped_invalid, 0);
});

// ── Request + retry policy ──────────────────────────────────────────────────

Deno.test("request: POSTs JSON with bearer auth to BASE_URL+path; 200 → json + credits + request_id", async () => {
  const h = harness({
    replies: [json(200, { results: [], key_metadata: { credits_consumed: 1, credits_remaining: 9 }, request_id: "r1" })],
  });
  const out = await contextdevRequest("/web/search", { query: "q" }, h.deps, 20_000);
  assert(out.ok);
  assertEquals(h.calls.length, 1);
  assertEquals(h.calls[0].method, "POST");
  assertEquals(h.calls[0].url, `${CONTEXT_DEV_BASE_URL}/web/search`);
  assertEquals(h.calls[0].headers.Authorization, "Bearer test_key");
  assertEquals(h.calls[0].body, { query: "q" });
  assertEquals(out.status, 200);
  assertEquals(out.credits_consumed, 1);
  assertEquals(out.request_id, "r1");
  assertEquals(out.json.results, []);
});

Deno.test("request: 429 with Retry-After: 2 → waits 2000 ms, retries once, succeeds", async () => {
  const h = harness({ replies: [json(429, { error_code: "RATE_LIMITED" }, { "Retry-After": "2" }), json(200, { ok: 1 })] });
  const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
  assert(out.ok);
  assertEquals(h.calls.length, 2);
  assert(h.elapsed() >= 2_000 && h.elapsed() < 3_000, `elapsed ${h.elapsed()}`);
});

Deno.test("request: 429 Retry-After: 3600 → wait capped at CAP; non-numeric → DEFAULT", async () => {
  const big = harness({ replies: [json(429, {}, { "Retry-After": "3600" }), json(200, {})] });
  await contextdevRequest("/web/search", {}, big.deps, 20_000);
  assert(big.elapsed() >= CONTEXT_DEV_RETRY_AFTER_CAP_MS && big.elapsed() < CONTEXT_DEV_RETRY_AFTER_CAP_MS + 1_000, `elapsed ${big.elapsed()}`);
  const txt = harness({ replies: [json(429, {}, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }), json(200, {})] });
  await contextdevRequest("/web/search", {}, txt.deps, 20_000);
  assert(txt.elapsed() >= CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS && txt.elapsed() < CONTEXT_DEV_RETRY_AFTER_DEFAULT_MS + 1_000, `elapsed ${txt.elapsed()}`);
});

Deno.test("request: 429 twice → ok:false status 429, one retry only, error_code carried", async () => {
  const h = harness({ replies: [json(429, { error_code: "RATE_LIMITED", message: "slow down" })] });
  const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
  assert(!out.ok);
  assertEquals(out.status, 429);
  assertEquals(out.error, CONTEXT_DEV_ERRORS.http);
  assertEquals(out.error_code, "RATE_LIMITED");
  assertEquals(out.retries, 1);
  assertEquals(h.calls.length, 2);
});

Deno.test("request: 503 → backoff 500 then 1000 ms, two retries, then ok:false status 503", async () => {
  const h = harness({ replies: [json(503, { message: "down" })] });
  const out = await contextdevRequest("/web/scrape", {}, h.deps, 20_000);
  assert(!out.ok);
  assertEquals(out.status, 503);
  assertEquals(out.retries, 2);
  assertEquals(h.calls.length, 3);
  assert(h.elapsed() >= 1_500 && h.elapsed() < 3_000, `elapsed ${h.elapsed()}`);
});

Deno.test("request: 408 is retried like a 5xx and succeeds on the second attempt", async () => {
  const h = harness({ replies: [json(408, { error_code: "REQUEST_TIMEOUT" }), json(200, {})] });
  const out = await contextdevRequest("/web/scrape", {}, h.deps, 20_000);
  assert(out.ok);
  assertEquals(h.calls.length, 2);
});

Deno.test("request: 400 / 402 / 422 → ok:false with status + error_code, NO retry, provider_message bounded", async () => {
  for (const [status, code] of [[400, "INPUT_VALIDATION_ERROR"], [402, "USAGE_EXCEEDED"], [422, "FREE_EMAIL_DETECTED"]] as const) {
    const h = harness({ replies: [json(status, { error_code: code, message: "x".repeat(300) })] });
    const out = await contextdevRequest("/people/search", {}, h.deps, 20_000);
    assert(!out.ok);
    assertEquals(out.status, status);
    assertEquals(out.error_code, code);
    assertEquals(out.retries, 0);
    assertEquals(h.calls.length, 1, `status ${status} must not retry`);
    assertEquals(out.provider_message?.length, 200);
    assertEquals("skipped" in out, false, "a provider error is never a skip");
  }
});

Deno.test("request: thrown network error → one retry, then ok:false status null error network", async () => {
  const h = harness({ replies: [new Error("ECONNRESET")] });
  const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
  assert(!out.ok);
  assertEquals(out.status, null);
  assertEquals(out.error, CONTEXT_DEV_ERRORS.network);
  assertEquals(out.retries, 1);
  assertEquals(h.calls.length, 2);
});

Deno.test("request: wrapper signal already aborted → no retry after the failed attempt", async () => {
  const c = new AbortController();
  c.abort();
  const h = harness({ replies: [new DOMException("Aborted", "AbortError")], signal: c.signal });
  const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
  assert(!out.ok);
  assertEquals(out.status, null);
  assertEquals(h.calls.length, 1);
});

Deno.test("request: a non-JSON body on an error status is tolerated", async () => {
  const h = harness({ replies: [new Response("<html>bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })] });
  const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
  assert(!out.ok);
  assertEquals(out.status, 502);
});

Deno.test("request: the api key never appears in any result, success or failure", async () => {
  for (const reply of [json(200, { echo: "fine" }), json(401, { error_code: "UNAUTHORIZED", message: "bad key" }), new Error("boom")]) {
    const h = harness({ replies: [reply] });
    const out = await contextdevRequest("/web/search", {}, h.deps, 20_000);
    assertEquals(JSON.stringify(out).includes("test_key"), false);
  }
});

// ── Health ──────────────────────────────────────────────────────────────────

Deno.test("healthDetail: disabled / unset / configured", () => {
  assertStringIncludes(contextdevHealthDetail(true, true).detail, "disabled via CONTEXT_DEV_DISABLED");
  assertStringIncludes(contextdevHealthDetail(false, false).detail, "CONTEXT_DEV_API_KEY unset");
  assertStringIncludes(contextdevHealthDetail(true, false).detail, "configured");
  assertEquals(contextdevHealthDetail(true, false).ok, true);
});

// ── Web search ──────────────────────────────────────────────────────────────

const META = { key_metadata: { credits_consumed: 2, credits_remaining: 5 }, request_id: "req-1" };

function searchRaw(n: number, dupOf: number[] = []) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const src = dupOf[i - (n - dupOf.length)] ?? null;
    results.push({
      url: src === null ? `https://site${i}.example/p?utm_source=x&id=${i}` : `https://SITE${src}.example/p?id=${src}`,
      title: `Title ${i}`,
      description: "d".repeat(900),
      relevance: "high",
      markdown: { markdown: null, code: "NOT_REQUESTED" },
      highlights: { highlights: ["h".repeat(400), "a", "b", "c", "d", "e"], code: "SUCCESS" },
    });
  }
  return { results, ...META };
}

Deno.test("search: trims to 10, snippet ≤600, highlights ≤4×280, reports deduped on canonical URL, keeps original url", async () => {
  const h = harness({ replies: [json(200, searchRaw(12, [0, 1]))] });
  const seen = new Set<string>();
  const out = await contextdevWebSearch({ query: "jordan vale", highlights: true }, h.deps, seen);
  assertEquals(out.ok, true);
  assertEquals(out.provider, "context.dev");
  const results = out.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 10);
  assertEquals(out.count, 10);
  assertEquals(out.deduped, 2);
  assertEquals(out.dropped_invalid, 0);
  assertEquals(results[0].url, "https://site0.example/p?utm_source=x&id=0");
  assertEquals(results[0].title, "Title 0");
  assertEquals(results[0].relevance, "high");
  assertEquals((results[0].snippet as string).length, CONTEXT_DEV_SNIPPET_MAX_CHARS);
  const hl = results[0].highlights as string[];
  assertEquals(hl.length, CONTEXT_DEV_HIGHLIGHTS_MAX);
  assertEquals(hl[0].length, CONTEXT_DEV_HIGHLIGHT_MAX_CHARS);
  assertEquals("markdown" in results[0], false);
  assertEquals("description" in results[0], false);
  assertEquals(out.credits_consumed, 2);
  assertEquals(out.request_id, "req-1");
  assertEquals(seen.size, 10, "the run-wide seen set now holds the 10 canonical URLs");
});

Deno.test("search: empty description → snippet omitted; highlights not SUCCESS → omitted; empty results → ok count 0", async () => {
  const raw = {
    results: [{ url: "https://a.example/", title: "A", description: "", relevance: "low", markdown: { markdown: null, code: "NOT_REQUESTED" }, highlights: { highlights: null, code: "NOT_REQUESTED" } }],
    ...META,
  };
  const h = harness({ replies: [json(200, raw), json(200, { results: [], ...META })] });
  const out = await contextdevWebSearch({ query: "q" }, h.deps, new Set());
  const r = (out.results as Array<Record<string, unknown>>)[0];
  assertEquals("snippet" in r, false);
  assertEquals("highlights" in r, false);
  const empty = await contextdevWebSearch({ query: "q2" }, h.deps, new Set());
  assertEquals(empty.ok, true);
  assertEquals(empty.count, 0);
  assertEquals(empty.results, []);
});

Deno.test("search: body caps numResults at 10, asks for return-partial under the fetch cap, highlights only when asked", async () => {
  const h = harness({ replies: [json(200, { results: [], ...META })] });
  await contextdevWebSearch({ query: "q", numResults: 50, includeDomains: ["a.com"], freshness: "last_week" }, h.deps, new Set());
  const body = h.calls[0].body as Record<string, unknown>;
  assertEquals(body.numResults, 10);
  assertEquals(body.timeoutOpts, { milliseconds: 15_000, behavior: "return-partial" });
  assertEquals(body.includeDomains, ["a.com"]);
  assertEquals(body.freshness, "last_week");
  assertEquals("highlightsOptions" in body, false);
  assertEquals("markdownOptions" in body, false);
  await contextdevWebSearch({ query: "q", highlights: true }, h.deps, new Set());
  assertEquals((h.calls[1].body as Record<string, unknown>).highlightsOptions, { enabled: true, query: "q" });
});

Deno.test("search: partial:true is passed through", async () => {
  const h = harness({ replies: [json(200, { partial: true, results: [], ...META })] });
  const out = await contextdevWebSearch({ query: "q" }, h.deps, new Set());
  assertEquals(out.partial, true);
});

// ── Scrape ──────────────────────────────────────────────────────────────────

Deno.test("scrape: 200 success → markdown capped, truncated:true, chars = original length, title/final_url/cache from metadata", async () => {
  const raw = {
    url: "https://example.com/",
    markdown: { requested: true, success: true, data: "x".repeat(5_000) },
    metadata: { sourceUrl: "https://example.com", finalUrl: "https://example.com/", title: "Example Domain" },
    cache_metadata: { status: "hit", age_ms: 10 },
    key_metadata: { credits_consumed: 1, credits_remaining: 4 },
    request_id: "req-2",
  };
  const h = harness({ replies: [json(200, raw)] });
  const out = await contextdevScrape({ url: "https://Example.com?utm_source=x" }, h.deps);
  assertEquals(out.ok, true);
  assertEquals(out.provider, "context.dev");
  assertEquals(out.url, "https://Example.com?utm_source=x");
  assertEquals(out.url_canonical, "https://example.com/");
  assertEquals((out.markdown as string).length, CONTEXT_DEV_MARKDOWN_MAX_CHARS);
  assertEquals(out.truncated, true);
  assertEquals(out.chars, 5_000);
  assertEquals(out.title, "Example Domain");
  assertEquals(out.final_url, "https://example.com/");
  assertEquals(out.cache_status, "hit");
  assertEquals(out.credits_consumed, 1);
  assertEquals(out.request_id, "req-2");
  assertEquals("html" in out, false);
});

Deno.test("scrape: 200 with markdown.success:false → ok:false, error output_failed, error_code carried", async () => {
  const raw = { url: "https://x.example/", markdown: { requested: true, success: false, data: null, error_code: "WEBSITE_BLOCKED", message: "blocked by origin" } };
  const h = harness({ replies: [json(200, raw)] });
  const out = await contextdevScrape({ url: "https://x.example/" }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.status, 200);
  assertEquals(out.error, CONTEXT_DEV_ERRORS.output_failed);
  assertEquals(out.error_code, "WEBSITE_BLOCKED");
  assertEquals(out.provider_message, "blocked by origin");
  assertEquals("skipped" in out, false);
});

Deno.test("scrape: body requests markdown only with mainContentOnly; fresh:true → maxAgeMs 0, default omits it", async () => {
  const ok = { markdown: { requested: true, success: true, data: "# hi" }, metadata: { title: "hi" } };
  const h = harness({ replies: [json(200, ok)] });
  await contextdevScrape({ url: "https://a.example/" }, h.deps);
  const body = h.calls[0].body as Record<string, unknown>;
  assertEquals(body.url, "https://a.example/");
  assertEquals(body.formats, { markdown: true });
  assertEquals(body.sharedParams, { mainContentOnly: true });
  assertEquals(body.timeoutOpts, { milliseconds: 25_000, behavior: "fail" });
  assertEquals("maxAgeMs" in body, false);
  await contextdevScrape({ url: "https://a.example/", fresh: true }, h.deps);
  assertEquals((h.calls[1].body as Record<string, unknown>).maxAgeMs, 0);
});

Deno.test("scrape: a short page is not marked truncated", async () => {
  const h = harness({ replies: [json(200, { markdown: { requested: true, success: true, data: "# hi" }, metadata: {} })] });
  const out = await contextdevScrape({ url: "https://a.example/" }, h.deps);
  assertEquals(out.markdown, "# hi");
  assertEquals(out.truncated, false);
  assertEquals(out.chars, 4);
});

// ── People search ───────────────────────────────────────────────────────────

function peopleRaw(n: number, dupOf: number[] = [], next_cursor: string | null = "cur-2") {
  const results = [];
  for (let i = 0; i < n; i++) {
    const src = dupOf[i - (n - dupOf.length)] ?? i;
    results.push({
      name: `Person ${i}`,
      description: `CTO at Company ${i}`,
      profiles: [`https://www.linkedin.com/in/person-${src}/`, `https://github.com/person-${src}`],
      location: { country: "US", region: "CA", city: "San Francisco" },
      role: { title: "CTO", seniority: "executive", company: { name: `Company ${i}`, domain: `c${i}.example` } },
      years_of_experience: 7,
      skills: ["a", "b"],
      schools: [{ name: "MIT" }],
    });
  }
  return { results, next_cursor, ...META };
}

Deno.test("people: trims to 10, maps name/headline/profiles/location/role, authority lead, has_more from next_cursor, deduped on first profile", async () => {
  const h = harness({ replies: [json(200, peopleRaw(12, [0, 1]))] });
  const seen = new Set<string>();
  const out = await contextdevPeopleSearch({ query: "CTOs at solar companies in California" }, h.deps, seen);
  assertEquals(out.ok, true);
  assertEquals(out.provider, "context.dev");
  assertEquals(out.authority, "lead");
  const results = out.results as Array<Record<string, unknown>>;
  assertEquals(results.length, 10);
  assertEquals(out.count, 10);
  assertEquals(out.deduped, 2);
  assertEquals(out.empty, false);
  assertEquals(out.has_more, true);
  assertEquals("next_cursor" in out, false);
  assertEquals(results[0].name, "Person 0");
  assertEquals(results[0].headline, "CTO at Company 0");
  assertEquals(results[0].profiles, ["https://www.linkedin.com/in/person-0/", "https://github.com/person-0"]);
  assertEquals(results[0].location, { city: "San Francisco", region: "CA", country: "US" });
  assertEquals(results[0].role, { title: "CTO", company: { name: "Company 0", domain: "c0.example" } });
  assertEquals(results[0].years_of_experience, 7);
  assertEquals("skills" in results[0], false);
  assertEquals(out.credits_consumed, 2);
});

Deno.test("people: empty results → ok:true, empty:true, count 0, has_more false", async () => {
  const h = harness({ replies: [json(200, peopleRaw(0, [], null))] });
  const out = await contextdevPeopleSearch({ query: "nobody" }, h.deps, new Set());
  assertEquals(out.ok, true);
  assertEquals(out.empty, true);
  assertEquals(out.count, 0);
  assertEquals(out.has_more, false);
});

Deno.test("people: body is mode fast, never contains cursor, query ≤ 500 chars, countries → filters", async () => {
  const h = harness({ replies: [json(200, peopleRaw(0, [], null))] });
  await contextdevPeopleSearch({ query: "q".repeat(600), countries: ["US", "GB"] }, h.deps, new Set());
  const body = h.calls[0].body as Record<string, unknown>;
  assertEquals(body.mode, "fast");
  assertEquals("cursor" in body, false);
  assertEquals((body.query as string).length, 500);
  assertEquals(body.filters, { countries: ["US", "GB"] });
  await contextdevPeopleSearch({ query: "q" }, h.deps, new Set());
  assertEquals("filters" in (h.calls[1].body as Record<string, unknown>), false);
});

// ── Cross-tool failure shapes ───────────────────────────────────────────────

Deno.test("each tool: missing key → gate skip with no fetch; kill switch likewise", async () => {
  for (const apiKey of [undefined, ""]) {
    const h = harness({ apiKey, replies: [json(200, {})] });
    const s = new Set<string>();
    for (const out of [
      await contextdevWebSearch({ query: "q" }, h.deps, s),
      await contextdevScrape({ url: "https://a.example/" }, h.deps),
      await contextdevPeopleSearch({ query: "q" }, h.deps, s),
    ]) {
      assertEquals(out.skipped, true);
      assertEquals(out.error, CONTEXT_DEV_ERRORS.not_configured);
    }
    assertEquals(h.calls.length, 0);
  }
  const off = harness({ disabled: true, replies: [json(200, {})] });
  const out = await contextdevScrape({ url: "https://a.example/" }, off.deps);
  assertEquals(out.error, CONTEXT_DEV_ERRORS.disabled);
  assertEquals(off.calls.length, 0);
});

Deno.test("each tool: provider 402 → ok:false status 402 USAGE_EXCEEDED, no retry", async () => {
  const reply = json(402, { error_code: "USAGE_EXCEEDED", message: "Insufficient credits" });
  for (const run of [
    (d: ContextDevDeps) => contextdevWebSearch({ query: "q" }, d, new Set()),
    (d: ContextDevDeps) => contextdevScrape({ url: "https://a.example/" }, d),
    (d: ContextDevDeps) => contextdevPeopleSearch({ query: "q" }, d, new Set()),
  ]) {
    const h = harness({ replies: [reply] });
    const out = await run(h.deps);
    assertEquals(out.ok, false);
    assertEquals(out.status, 402);
    assertEquals(out.error_code, "USAGE_EXCEEDED");
    assertEquals(h.calls.length, 1);
  }
});

Deno.test("each tool: an unexpected 200 body shape is a legible failure, not a throw", async () => {
  const h = harness({ replies: [json(200, { nothing: "here" })] });
  const s = await contextdevWebSearch({ query: "q" }, h.deps, new Set());
  assertEquals(s.ok, false);
  assertEquals(s.error_code, "UNEXPECTED_SHAPE");
  const p = await contextdevPeopleSearch({ query: "q" }, h.deps, new Set());
  assertEquals(p.error_code, "UNEXPECTED_SHAPE");
  const c = await contextdevScrape({ url: "https://a.example/" }, h.deps);
  assertEquals(c.error_code, "UNEXPECTED_SHAPE");
});
