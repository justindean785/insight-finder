// lib/opsis_test.ts — the Opsis client (lib/opsis.ts), driven with a scripted fetch
// and a fake clock so "Opsis never finishes" runs in milliseconds, not 25 s.
//
// Contract under test: https://useopsis.com/docs/api (v1), read 2026-10-01.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPSIS_MAX_RESULTS_RETURNED,
  OPSIS_POLL_DEADLINE_MS,
  OPSIS_RESULT_METADATA_MAX_CHARS,
  opsisAccount,
  opsisGate,
  opsisHealthDetail,
  opsisResults,
  opsisSearch,
  shapeOpsisResult,
  type OpsisDeps,
} from "./opsis.ts";

type Call = { method: string; url: string; body: unknown };
type Reply = Response | (() => Response) | Error;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Scripted Opsis: POST replies in order; GET replies in order, the last one repeating. */
function harness(opts: { post?: Reply[]; get?: Reply[]; apiKey?: string | undefined; disabled?: boolean; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const post = [...(opts.post ?? [])];
  const get = [...(opts.get ?? [])];
  const take = (q: Reply[]): Response => {
    const r = q.length > 1 ? q.shift()! : q[0];
    if (!r) throw new Error("unscripted request");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  };
  const deps: OpsisDeps = {
    apiKey: "apiKey" in opts ? opts.apiKey : "opsis_test_key",
    disabled: opts.disabled ?? false,
    fetch: (url, init) => {
      const method = String(init.method ?? "GET");
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      // Every request costs some wall time, like a real round trip.
      clock += 300;
      return Promise.resolve(take(method === "POST" ? post : get));
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

const ACCOUNT = (platform: string, i = 1) => ({
  id: i,
  type: "account",
  platform,
  value: `https://${platform}.example/jordanvale`,
  confidence: 0.9,
  source: `${platform}_module`,
  metadata: {},
  created_at: "2026-10-01T00:00:00Z",
});

// ── Gate ────────────────────────────────────────────────────────────────────

Deno.test("key unset: a free skip that refunds the paid slot and never touches the network", async () => {
  const h = harness({ apiKey: undefined });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);
  assertEquals(out, { error: "OPSIS_API_KEY not configured", skipped: true, provider_attempted: false });
  assertEquals(h.calls.length, 0);
});

Deno.test("kill switch beats a configured key, for every opsis operation", async () => {
  const h = harness({ disabled: true });
  for (const out of [
    await opsisSearch({ kind: "email", value: "a@b.test" }, h.deps),
    await opsisResults({ kind: "email", value: "a@b.test", run_id: "r1" }, h.deps),
    await opsisAccount("balance", h.deps),
    await opsisAccount("status", h.deps),
  ]) {
    assertEquals(out.skipped, true);
    assertEquals(out.provider_attempted, false);
    assertStringIncludes(String(out.error), "provider disabled in config");
  }
  assertEquals(h.calls.length, 0);
});

Deno.test("gate texts match the house skip vocabulary the cache wrapper recognises", () => {
  // cache.ts SKIP_REASON_RE: /not configured|provider disabled in config|.../
  const re = /not configured|provider disabled in config/i;
  assert(re.test(String(opsisGate({ apiKey: undefined, disabled: false })?.error)));
  assert(re.test(String(opsisGate({ apiKey: "k", disabled: true })?.error)));
  assertEquals(opsisGate({ apiKey: "k", disabled: false }), null);
});

// ── Search: start, poll, complete ───────────────────────────────────────────

Deno.test("search: POSTs wait:false once, polls the run, returns a completed run", async () => {
  const h = harness({
    post: [json(200, { run_id: "run-1", status: "running" })],
    get: [
      json(200, { run_id: "run-1", status: "running", results: [ACCOUNT("github")], progress: { modules_total: 500, modules_completed: 100, modules_with_hits: 1 } }),
      json(200, { run_id: "run-1", status: "completed", type: "username", query: "jordanvale", total_results: 2, results: [ACCOUNT("github"), ACCOUNT("gitlab", 2)], progress: { modules_total: 500, modules_completed: 500, modules_with_hits: 2 } }),
    ],
  });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);

  const posts = h.calls.filter((c) => c.method === "POST");
  assertEquals(posts.length, 1);
  assertEquals(posts[0].url, "https://api.useopsis.com/v1/searches");
  assertEquals(posts[0].body, { type: "username", query: "jordanvale", wait: false, premium: false });
  assertEquals(h.calls.filter((c) => c.method === "GET").every((c) => c.url.endsWith("/v1/searches/run-1")), true);

  assertEquals(out.ok, true);
  assertEquals(out.run_status, "completed");
  assertEquals(out.complete, true);
  assertEquals(out.partial, undefined);
  assertEquals(out.total_results, 2);
  assertEquals(out.results_returned, 2);
  assertEquals((out.results as Array<Record<string, unknown>>)[1], {
    platform: "gitlab",
    value: "https://gitlab.example/jordanvale",
    type: "account",
    module: "gitlab_module",
    opsis_confidence: 0.9,
  });
});

Deno.test("search: Opsis's own source/confidence never surface under OUR field names", async () => {
  const row = shapeOpsisResult(ACCOUNT("github"))!;
  assertEquals("source" in row, false);
  assertEquals("confidence" in row, false);
  assertEquals(row.module, "github_module");
  assertEquals(row.opsis_confidence, 0.9);
});

Deno.test("search: premium is sent only for a username, never for email or domain", async () => {
  for (const [kind, value, sent] of [["username", "jv", true], ["email", "a@b.test", false], ["domain", "b.test", false]] as const) {
    const h = harness({ post: [json(200, { run_id: "r", status: "completed", results: [] })] });
    const out = await opsisSearch({ kind, value, premium: true }, h.deps);
    assertEquals((h.calls[0].body as Record<string, unknown>).premium, sent, kind);
    assertEquals(out.premium, sent);
  }
});

// ── Search: the deadline ────────────────────────────────────────────────────

Deno.test("search: a run that never finishes returns partial results with its run_id inside the deadline", async () => {
  const h = harness({
    post: [json(200, { run_id: "run-slow", status: "running" })],
    get: [json(200, { run_id: "run-slow", status: "running", results: [ACCOUNT("github"), ACCOUNT("reddit", 2)], progress: { modules_total: 500, modules_completed: 120, modules_with_hits: 2 } })],
  });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);

  assertEquals(out.ok, true);
  assertEquals(out.partial, true);
  assertEquals(out.run_status, "running");
  assertEquals(out.complete, false);
  assertEquals(out.run_id, "run-slow");
  assertEquals(out.results_returned, 2);
  assertStringIncludes(String(out.note), "opsis_results");
  // Bounded: never past the deadline (one request's slack at most).
  assert(h.elapsed() <= OPSIS_POLL_DEADLINE_MS + 300, `took ${h.elapsed()}ms`);
  // And it really did keep polling rather than giving up early.
  assert(h.calls.filter((c) => c.method === "GET").length >= 5);
  // Never a second paid search.
  assertEquals(h.calls.filter((c) => c.method === "POST").length, 1);
});

Deno.test("search: an aborted wrapper signal ends the poll early with what has arrived", async () => {
  const ctrl = new AbortController();
  let polls = 0;
  const h = harness({
    signal: ctrl.signal,
    post: [json(200, { run_id: "run-a", status: "running" })],
    get: [() => {
      polls += 1;
      if (polls === 2) ctrl.abort();
      return json(200, { run_id: "run-a", status: "running", results: [ACCOUNT("github")] });
    }],
  });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);
  assertEquals(out.partial, true);
  assertEquals(out.run_id, "run-a");
  assertEquals(polls, 2);
});

Deno.test("search: 429 and 5xx on a poll are retried on the next tick, not returned", async () => {
  const h = harness({
    post: [json(200, { run_id: "run-r", status: "running" })],
    get: [
      json(429, { error: "rate_limited" }),
      json(503, {}),
      json(200, { run_id: "run-r", status: "completed", results: [ACCOUNT("github")] }),
    ],
  });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);
  assertEquals(out.ok, true);
  assertEquals(out.run_status, "completed");
});

Deno.test("search: a start request that fails is NOT retried — a retried POST is a second paid search", async () => {
  const h = harness({ post: [new TypeError("network down")] });
  const out = await opsisSearch({ kind: "email", value: "a@b.test" }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.code, "start_failed");
  assertEquals(h.calls.length, 1);
});

Deno.test("search: an upstream run failure is ok:false with a constant error and the run id kept", async () => {
  const h = harness({
    post: [json(200, { run_id: "run-f", status: "running" })],
    get: [json(200, { run_id: "run-f", status: "failed", results: [] })],
  });
  const out = await opsisSearch({ kind: "domain", value: "b.test" }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.error, "opsis search failed upstream");
  assertEquals(out.run_id, "run-f");
});

// ── HTTP failures ───────────────────────────────────────────────────────────

const FAILURES: Array<[number, Record<string, unknown>, string]> = [
  [400, { error: "invalid_request", message: "'x y' is not a valid username" }, "invalid_request"],
  [401, { error: "invalid_api_key", message: "Invalid API key" }, "invalid_api_key"],
  [402, { error: "insufficient_api_credits", message: "Top up" }, "insufficient_api_credits"],
  [402, { error: "api_credit_adjustment_required", message: "Negative balance" }, "api_credit_adjustment_required"],
  [403, { error: "plan_required", message: "Pro required" }, "plan_required"],
  [429, { detail: { msg: "slow down" } }, "rate_limited"],
];

for (const [status, body, code] of FAILURES) {
  Deno.test(`search: HTTP ${status} (${code}) is an honest ok:false with a numeric status, not a skip`, async () => {
    const h = harness({ post: [json(status, body)] });
    const out = await opsisSearch({ kind: "email", value: "a@b.test" }, h.deps);
    assertEquals(out.ok, false);
    assertEquals(out.status, status);
    assertEquals(out.code, code);
    // Not a skip: a tool-emitted skip is logged as outcome "ok", which would hide
    // an out-of-credits account from checks.credentials and the circuit.
    assertEquals(out.skipped, undefined);
    // Provider text never reaches `error`, which isIntentionalSkip regex-matches.
    if (typeof body.message === "string") {
      assert(!String(out.error).includes(body.message));
      assertEquals(out.provider_message, body.message);
    }
    assertEquals(h.calls.length, 1);
  });
}

Deno.test("no error text could be mistaken for a skip by the cache wrapper or the circuit", () => {
  // cache.ts SKIP_REASON_RE and circuit.ts classifyResult's "disabled|not configured".
  const skipish = /not configured|provider disabled in config|unavailable:\s*(?:disabled|missing_key|gated)|\bgated\b|disabled/i;
  const texts = [
    "opsis rejected the query as invalid",
    "opsis API key was rejected",
    "opsis account is out of API credits",
    "opsis plan does not include API access",
    "opsis run was not found",
    "opsis rate limit reached",
    "opsis upstream error",
    "opsis request failed",
    "opsis search failed upstream",
    "opsis search start request failed",
    "opsis run belongs to a different selector",
  ];
  for (const t of texts) assert(!skipish.test(t), t);
});

Deno.test("search: a username with spaces is refused locally, before any credit is spent", async () => {
  const h = harness();
  const out = await opsisSearch({ kind: "username", value: "Jordan Vale" }, h.deps);
  assertEquals(out.skipped, true);
  assertEquals(out.provider_attempted, false);
  assertEquals(h.calls.length, 0);
  // The selector is never interpolated into the reason.
  assert(!String(out.reason).includes("Jordan"));
});

// ── Prompt budget ───────────────────────────────────────────────────────────

Deno.test("results are capped for the prompt, and the overflow is counted", async () => {
  const many = Array.from({ length: OPSIS_MAX_RESULTS_RETURNED + 37 }, (_, i) => ACCOUNT(`p${i}`, i));
  const h = harness({ post: [json(200, { run_id: "r", status: "completed", total_results: many.length, results: many })] });
  const out = await opsisSearch({ kind: "username", value: "jordanvale" }, h.deps);
  assertEquals(out.results_returned, OPSIS_MAX_RESULTS_RETURNED);
  assertEquals(out.results_truncated, 37);
  assertEquals(out.total_results, many.length);
});

Deno.test("oversized metadata is dropped and flagged, small metadata is kept", () => {
  const small = shapeOpsisResult({ ...ACCOUNT("github"), metadata: { followers: 12 } })!;
  assertEquals(small.metadata, { followers: 12 });
  const big = shapeOpsisResult({ ...ACCOUNT("github"), metadata: { bio: "x".repeat(OPSIS_RESULT_METADATA_MAX_CHARS) } })!;
  assertEquals(big.metadata, undefined);
  assertEquals(big.metadata_omitted, true);
  assertEquals(shapeOpsisResult({ id: 1, type: "account" }), null);
});

// ── Resume ──────────────────────────────────────────────────────────────────

Deno.test("results: reads an existing run immediately, free, and never POSTs", async () => {
  const h = harness({ get: [json(200, { run_id: "run-1", status: "completed", type: "username", query: "JordanVale", results: [ACCOUNT("github")] })] });
  const out = await opsisResults({ kind: "username", value: "jordanvale", run_id: "run-1" }, h.deps);
  assertEquals(out.ok, true);
  assertEquals(out.run_status, "completed");
  assertEquals(h.calls.map((c) => c.method), ["GET"]);
  assertEquals(h.elapsed(), 300); // no sleep before the first read
});

Deno.test("results: a run started for a different selector is refused, results withheld", async () => {
  for (const run of [
    { run_id: "run-1", status: "completed", type: "username", query: "someone_else", results: [ACCOUNT("github")] },
    { run_id: "run-1", status: "completed", type: "email", query: "jordanvale", results: [ACCOUNT("github")] },
  ]) {
    const h = harness({ get: [json(200, run)] });
    const out = await opsisResults({ kind: "username", value: "jordanvale", run_id: "run-1" }, h.deps);
    assertEquals(out.ok, false);
    assertEquals(out.code, "selector_mismatch");
    assertEquals(out.results, undefined);
  }
});

Deno.test("results: a vanished run (404) stops polling at once", async () => {
  const h = harness({ get: [json(404, { error: "not_found" })] });
  const out = await opsisResults({ kind: "username", value: "jv", run_id: "gone" }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.status, 404);
  assertEquals(h.calls.length, 1);
});

// ── Account lookups ─────────────────────────────────────────────────────────

Deno.test("balance and status return only documented, non-identifying fields", async () => {
  const h = harness({
    get: [
      json(200, { tier: "pro", available_api_credits: 250, api_credits_remaining: 250, use_subscription_credits: false, period_end: "2026-11-01" }),
      json(200, { user_id: "user_secret", tier: "pro", api_access: true, rate_limit_per_minute: 120, supports_streaming: true, search_types: ["domain", "email", "username"] }),
    ],
  });
  const bal = await opsisAccount("balance", h.deps);
  assertEquals(bal.ok, true);
  assertEquals((bal.data as Record<string, unknown>).available_api_credits, 250);
  assertEquals(h.calls[0].url, "https://api.useopsis.com/v1/credits");
  const st = await opsisAccount("status", h.deps);
  assertEquals((st.data as Record<string, unknown>).api_access, true);
  assertEquals("user_id" in (st.data as Record<string, unknown>), false);
  assertEquals(h.calls[1].url, "https://api.useopsis.com/v1/me");
});

Deno.test("checks.opsis detail names the state without touching the network", () => {
  assertStringIncludes(opsisHealthDetail(false, false).detail, "not configured");
  assertStringIncludes(opsisHealthDetail(true, true).detail, "disabled via OPSIS_DISABLED");
  assertStringIncludes(opsisHealthDetail(true, false).detail, "opsis_results");
  assertEquals(opsisHealthDetail(true, false).ok, true);
});
