// jina_target_403_test.ts — a raw HTTP 403 from r.jina.ai is ONE page refusing the
// reader, not a dead Jina credential.
//
// Measured 2026-10-18 (tool_usage_log, 30 days): 11 `jina 403` failures. In every
// thread where Jina ran again within 15 minutes, it succeeded on other URLs before
// and after the 403, so the key was fine. But the tool returned `{status:403}`,
// `circuit.classifyResult` filed it as `http_403`, and the breaker suppressed the
// whole provider as "401/403 unauthorized": 4 later reads were refused, the newest
// on 2026-10-18 05:13Z.
//
// These tests drive the REAL tool (stubbed `fetch`) through the REAL cache wrapper
// and the REAL circuit breaker. Kill switch JINA_TARGET_403_DISABLED restores the
// old shape; the kill-switch test is the negative control, because it must
// reproduce the measured chain.
//
// Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import {
  jinaTarget403SelfTest,
  shapeJinaHttpError,
} from "../../functions/osint-agent/lib/jina-http-error.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;
type Exec = (i: unknown, o: unknown) => Promise<Record<string, unknown>>;

const SWITCH = "JINA_TARGET_403_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
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
    archiveEnabled: false, detectedSeedType: "url", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

/** The real jina tool behind the real wrapper, on a fresh thread. */
function harness(thread: string) {
  circuit.clearThread(thread);
  clearRuntime(thread);
  const h = makeDb();
  const real = buildTools(stubCtx(thread)).tools as Record<string, unknown>;
  const wrapped = wrapToolsWithCache(
    { jina_reader_scrape: real.jina_reader_scrape } as never,
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  ) as unknown as Record<string, { execute: Exec }>;
  const call = async (input: Record<string, unknown>) => {
    const out = await wrapped.jina_reader_scrape.execute(
      { ...input, force: true },
      { toolCallId: `${thread}-${Math.random()}`, messages: [] },
    );
    await new Promise((r) => setTimeout(r, 40)); // logUsage is fire-and-forget on the live path
    return out;
  };
  return { h, call };
}

/** fetch stub: r.jina.ai answers each target URL with the given HTTP status (200 = a real page). */
function stubJina(statusByTarget: Record<string, number>) {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const u = String(input);
    if (u.includes("r.jina.ai/")) {
      const target = u.split("r.jina.ai/")[1] ?? "";
      seen.push(target);
      const status = statusByTarget[target] ?? 200;
      const body = status === 200
        ? `Title: Page\n\nURL Source: ${target}\n\nMarkdown Content:\nhello from ${target}`
        : `{"code":${status},"name":"Error","message":"refused"}`;
      return Promise.resolve(new Response(body, { status }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

const BLOCKED = "https://blocked.example.test/profile";
const OTHER = "https://other.example.test/article";

Deno.test("jina: a raw 403 for one page does NOT suppress Jina — the next URL is still read", async () => {
  const f = stubJina({ [BLOCKED]: 403 });
  try {
    const { h, call } = harness("j403-a");
    const a = await call({ url: BLOCKED });
    assertEquals(a.ok, false);
    assertEquals(a.origin_error, true);
    assertEquals(a.target_status, 403);
    assertEquals(a.error, "jina 403");
    assert(!("status" in a), "the page's 403 must not travel as `status`: the breaker reads that as a dead key");

    const b = await call({ url: OTHER });
    assertEquals(b.ok, true, JSON.stringify(b));
    assert(String(b.markdown).includes(`hello from ${OTHER}`), "the second page is returned verbatim");
    assertEquals(f.seen, [BLOCKED, OTHER], "both reads reached r.jina.ai");

    const rows = h.usage.filter((u) => u.tool_name === "jina_reader_scrape");
    assertEquals(rows.map((r) => r.outcome), ["failed", "ok"], "the blocked page is still a failed read");
    assertEquals(h.cacheUpserts.length, 1, "only the page that was read is cached; a refused read never replays");
    assert(JSON.stringify(h.cacheUpserts[0]).includes(`hello from ${OTHER}`), "the cached row is the real page");
  } finally { f.restore(); }
});

Deno.test("jina: three blocked pages in a row still leave the reader available", async () => {
  const blocked = ["https://a.example.test/1", "https://b.example.test/2", "https://c.example.test/3"];
  const f = stubJina(Object.fromEntries(blocked.map((u) => [u, 403])));
  try {
    const { call } = harness("j403-b");
    for (const u of blocked) assertEquals((await call({ url: u })).origin_error, true, u);
    const ok = await call({ url: OTHER });
    assertEquals(ok.ok, true, JSON.stringify(ok));
    assertEquals(f.seen.length, 4, "no read was refused by the breaker");
  } finally { f.restore(); }
});

Deno.test("jina: a raw 401 is still a dead credential and still suppresses the provider (scope is 403 only)", async () => {
  const f = stubJina({ [BLOCKED]: 401 });
  try {
    const { call } = harness("j403-c");
    const a = await call({ url: BLOCKED });
    assertEquals(a.status, 401);
    assert(!("origin_error" in a), "a 401 is about the key, not the page");
    const b = await call({ url: OTHER });
    assertEquals(b.skipped, true, JSON.stringify(b));
    assert(String(b.error).includes("401 unauthorized"), String(b.error));
    assertEquals(f.seen, [BLOCKED], "the second read never reached r.jina.ai");
  } finally { f.restore(); }
});

Deno.test("NEGATIVE CONTROL — kill switch restores the old shape and reproduces the measured chain", async () => {
  await withEnv(SWITCH, "true", async () => {
    const f = stubJina({ [BLOCKED]: 403 });
    try {
      const { h, call } = harness("j403-ctl");
      const a = await call({ url: BLOCKED });
      assertEquals(a.status, 403);
      assert(!("origin_error" in a));
      const b = await call({ url: OTHER });
      assertEquals(b.skipped, true, JSON.stringify(b));
      assert(String(b.error).includes("provider 'jina_reader_scrape' suppressed"), String(b.error));
      assertEquals(f.seen, [BLOCKED], "the healthy page was refused, as in production");
      const rows = h.usage.filter((u) => u.tool_name === "jina_reader_scrape");
      assertEquals(rows.map((r) => r.outcome), ["failed", "skipped"]);
    } finally { f.restore(); }
  });
});

Deno.test("shape: only 403 becomes an origin error; other non-ok statuses keep the provider shape", () => {
  const s403 = shapeJinaHttpError("https://x.example.test/", 403);
  assertEquals([s403.ok, s403.origin_error, s403.target_status, s403.error], [false, true, 403, "jina 403"]);
  assert(!("status" in s403));
  for (const code of [401, 402, 422, 429, 451, 500, 502]) {
    const s = shapeJinaHttpError("https://x.example.test/", code);
    assertEquals(s.status, code, String(code));
    assertEquals(s.error, `jina ${code}`);
    assert(!("origin_error" in s), String(code));
  }
});

Deno.test("/health: checks.jina_target_403 is wired, passes, and says when the switch is thrown", async () => {
  const on = jinaTarget403SelfTest();
  assertEquals(on.ok, true, on.detail);
  assert(!on.detail.includes("LEGACY"), on.detail);
  await withEnv(SWITCH, "true", () => {
    const off = jinaTarget403SelfTest();
    assertEquals(off.ok, true);
    assert(off.detail.includes("LEGACY"), off.detail);
  });
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(
    health.includes("r.checks.jina_target_403 = jinaTarget403SelfTest()"),
    "the health probe must report the check: its presence is the proof-of-deploy key",
  );
});
