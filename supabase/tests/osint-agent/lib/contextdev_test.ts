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
