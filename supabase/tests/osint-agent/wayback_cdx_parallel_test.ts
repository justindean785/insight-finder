// wayback_cdx_parallel_test.ts — wayback_cdx_search must answer inside its wrapper cap,
// keep what it learned when one archive.org query is slow, and never turn a failed
// read into "not archived".
//
// Measured 2026-10-18 (tool_usage_log, 30 days): 49 calls, 1 ok, 19 empty, 21 failed.
// 15 of the failures are timeouts at 22-26 s, 5 are archive.org 503s. The tool ran
// its queries one after another: the 25-row sample (12 s per attempt, plus a retry),
// THEN the two bookend queries (12 s, plus a retry). Worst case is about 48 s
// against the 25 s wrapper cap (cache.ts), so a slow archive lost the whole result.
//
// These tests drive the real module against a stubbed `fetch`, with small budgets so
// a "slow" archive takes milliseconds. Kill switch WAYBACK_CDX_PARALLEL_DISABLED
// restores the old sequential tool; its test is the negative control.
//
// Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toolTimeoutMs } from "../../functions/osint-agent/cache.ts";
import { cacheVersionFor, TOOL_CACHE_VERSION } from "../../functions/osint-agent/lib/tool-cache-version.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import {
  WAYBACK_AVAILABILITY_TIMEOUT_MS,
  WAYBACK_CDX_QUERY_TIMEOUT_MS,
  waybackCdxBudgetSelfTest,
  waybackCdxSearch,
} from "../../functions/osint-agent/lib/wayback-cdx.ts";

const SWITCH = "WAYBACK_CDX_PARALLEL_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

type Kind = "sample" | "earliest" | "latest" | "availability";
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean; delayMs?: number };

function kindOf(u: string): Kind | null {
  if (u.includes("archive.org/wayback/available")) return "availability";
  if (!u.includes("/cdx/search/cdx")) return null;
  if (u.includes("limit=-1")) return "latest";
  if (u.includes("limit=1&") || u.endsWith("limit=1")) return "earliest";
  return "sample";
}

/** fetch stub: answer each archive.org query kind as told; a `hang` waits for the abort. */
function stubArchive(replies: Partial<Record<Kind, Reply>>) {
  const orig = globalThis.fetch;
  const started: Array<{ kind: Kind; at: number }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    const kind = kindOf(u);
    if (!kind) return Promise.resolve(new Response("{}", { status: 200 }));
    started.push({ kind, at: Date.now() });
    const reply = replies[kind] ?? { status: 200, body: [] };
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (reply.hang) return;
      setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(new Response(reply.raw ?? JSON.stringify(reply.body ?? []), { status: reply.status ?? 200 }));
      }, reply.delayMs ?? 0);
    });
  }) as typeof fetch;
  return { started, restore: () => { globalThis.fetch = orig; } };
}

const SAMPLE = [
  ["timestamp", "original", "statuscode"],
  ["20150101000000", "http://example.test/", "200"],
  ["20200101000000", "http://example.test/about", "200"],
];
const BOOKEND = (ts: string) => [["timestamp"], [ts]];
const AVAIL = (ts: string) => ({
  url: "example.test",
  archived_snapshots: { closest: { available: true, status: "200", timestamp: ts, url: `http://web.archive.org/web/${ts}/http://example.test/` } },
});
const AVAIL_NONE = { url: "example.test", archived_snapshots: {} };
const FAST = { cdxMs: 60, availabilityMs: 60 };

Deno.test("parallel: every archive.org query starts at once, not one after another", async () => {
  const f = stubArchive({
    sample: { body: SAMPLE, delayMs: 20 },
    earliest: { body: BOOKEND("20100101000000"), delayMs: 20 },
    latest: { body: BOOKEND("20251231000000"), delayMs: 20 },
    availability: { body: AVAIL("20251230000000"), delayMs: 20 },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, true);
    assertEquals(f.started.map((s) => s.kind).sort(), ["availability", "earliest", "latest", "sample"]);
    const spread = Math.max(...f.started.map((s) => s.at)) - Math.min(...f.started.map((s) => s.at));
    assert(spread < 15, `all four queries must start together (spread ${spread} ms)`);
  } finally { f.restore(); }
});

Deno.test("a full answer keeps the old fields, with the CDX bookends as the source", async () => {
  const f = stubArchive({
    sample: { body: SAMPLE },
    earliest: { body: BOOKEND("20100101000000") },
    latest: { body: BOOKEND("20251231000000") },
    availability: { body: AVAIL("20251230000000") },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, true);
    assertEquals(r.archived, true);
    assertEquals(r.earliest, "20100101000000");
    assertEquals(r.latest, "20251231000000");
    assertEquals([r.earliest_source, r.latest_source], ["cdx", "cdx"]);
    assertEquals(r.sampled_count, 2);
    assertEquals(r.capped, false);
    assertEquals((r.captures as unknown[]).length, 2);
    assert(!("partial" in r));
  } finally { f.restore(); }
});

Deno.test("a slow CDX index no longer loses everything: the availability API still proves a capture", async () => {
  const f = stubArchive({
    sample: { hang: true },
    earliest: { hang: true },
    latest: { hang: true },
    availability: { body: AVAIL("20251230000000") },
  });
  try {
    const t0 = Date.now();
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    const took = Date.now() - t0;
    assert(took < 300, `answered inside the budget (${took} ms)`);
    assertEquals(r.ok, true);
    assertEquals(r.archived, true);
    assertEquals(r.partial, true);
    assertEquals(r.latest, "20251230000000");
    assertEquals(r.latest_source, "availability");
    assertEquals(r.earliest, null);
    assertEquals(r.captures, []);
    assert(String(r.note).includes("CDX"), String(r.note));
  } finally { f.restore(); }
});

Deno.test("a bookend that answers is kept when the sample query fails", async () => {
  const f = stubArchive({
    sample: { status: 503 },
    earliest: { body: BOOKEND("20100101000000") },
    latest: { hang: true },
    availability: { body: AVAIL_NONE },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals([r.ok, r.archived, r.partial], [true, true, true]);
    assertEquals([r.earliest, r.earliest_source], ["20100101000000", "cdx"]);
  } finally { f.restore(); }
});

Deno.test("a genuine empty answer is still a negative", async () => {
  const f = stubArchive({
    sample: { body: [] },
    earliest: { body: [] },
    latest: { body: [] },
    availability: { body: AVAIL_NONE },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, true);
    assertEquals(r.archived, false);
    assertEquals(r.captures, []);
    assertEquals(r.sampled_count, 0);
  } finally { f.restore(); }
});

Deno.test("a timed-out CDX read is never reported as 'not archived', even if the availability API is empty", async () => {
  const f = stubArchive({
    sample: { hang: true },
    earliest: { hang: true },
    latest: { hang: true },
    availability: { body: AVAIL_NONE },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, false);
    assert(!("archived" in r), "a failed read must not carry a negative");
    assertEquals(r._timeout, true);
  } finally { f.restore(); }
});

Deno.test("a malformed 200 body is a failed read, not 'not archived'", async () => {
  const f = stubArchive({
    sample: { raw: "<html>Wayback is down</html>" },
    earliest: { raw: "<html>Wayback is down</html>" },
    latest: { raw: "<html>Wayback is down</html>" },
    availability: { body: AVAIL_NONE },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, false);
    assert(!("archived" in r));
  } finally { f.restore(); }
});

Deno.test("all archive.org queries answering 503 is still a provider failure with that status", async () => {
  const f = stubArchive({
    sample: { status: 503 }, earliest: { status: 503 }, latest: { status: 503 }, availability: { status: 503 },
  });
  try {
    const r = await waybackCdxSearch("example.test", { timeouts: FAST });
    assertEquals(r.ok, false);
    assertEquals(r.status, 503);
    assertEquals(r.error, "wayback cdx 503");
  } finally { f.restore(); }
});

Deno.test("budget: the slowest single query fits well inside the wrapper cap", () => {
  const cap = toolTimeoutMs("wayback_cdx_search");
  assert(Math.max(WAYBACK_CDX_QUERY_TIMEOUT_MS, WAYBACK_AVAILABILITY_TIMEOUT_MS) + 2_000 <= cap,
    `parallel worst case ${WAYBACK_CDX_QUERY_TIMEOUT_MS} ms must clear the ${cap} ms wrapper with margin`);
  assertEquals(waybackCdxBudgetSelfTest(cap).ok, true);
  assertEquals(waybackCdxBudgetSelfTest(WAYBACK_CDX_QUERY_TIMEOUT_MS).ok, false, "the self-test must catch a cap it does not clear");
});

function stubCtx(thread: string): ToolContext {
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: thread,
    archiveEnabled: false, detectedSeedType: "domain", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

Deno.test("the real tool uses the parallel search (it asks the availability API)", async () => {
  const f = stubArchive({
    sample: { body: SAMPLE }, earliest: { body: BOOKEND("20100101000000") },
    latest: { body: BOOKEND("20251231000000") }, availability: { body: AVAIL("20251230000000") },
  });
  try {
    const tools = buildTools(stubCtx("wb-a")).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>;
    const r = await tools.wayback_cdx_search.execute({ url: "example.test" }, {});
    assertEquals(r.ok, true);
    assertEquals(r.latest_source, "cdx");
    assert(f.started.some((s) => s.kind === "availability"), "parallel mode queries the availability API");
  } finally { f.restore(); }
});

Deno.test("NEGATIVE CONTROL — kill switch restores the old sequential tool (sample first, no availability API)", async () => {
  await withEnv(SWITCH, "true", async () => {
    const f = stubArchive({
      sample: { body: SAMPLE, delayMs: 30 }, earliest: { body: BOOKEND("20100101000000") },
      latest: { body: BOOKEND("20251231000000") }, availability: { body: AVAIL("20251230000000") },
    });
    try {
      const tools = buildTools(stubCtx("wb-ctl")).tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>;
      const r = await tools.wayback_cdx_search.execute({ url: "example.test" }, {});
      assertEquals([r.ok, r.earliest, r.latest], [true, "20100101000000", "20251231000000"]);
      assert(!("latest_source" in r), "the legacy shape has no source fields");
      assert(!f.started.some((s) => s.kind === "availability"), "the legacy tool never asked the availability API");
      const sampleAt = f.started.find((s) => s.kind === "sample")!.at;
      const bookendAt = Math.min(...f.started.filter((s) => s.kind !== "sample").map((s) => s.at));
      assert(bookendAt - sampleAt >= 25, "legacy: the bookends wait for the sample");
    } finally { f.restore(); }
  });
});

Deno.test("/health: checks.wayback_cdx_budget is wired, and says when the switch is thrown", async () => {
  await withEnv(SWITCH, "true", () => {
    assert(waybackCdxBudgetSelfTest(25_000).detail.includes("LEGACY"));
  });
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(
    health.includes(`r.checks.wayback_cdx_budget = waybackCdxBudgetSelfTest(toolTimeoutMs("wayback_cdx_search"))`),
    "the health probe must report the check: its presence is the proof-of-deploy key",
  );
});

Deno.test("cache: wayback_cdx_search is versioned so a pre-fix row (a malformed body cached as 'not archived') never replays", () => {
  assertEquals(TOOL_CACHE_VERSION.wayback_cdx_search, 2);
  assertEquals(cacheVersionFor("wayback_cdx_search"), 2);
});
