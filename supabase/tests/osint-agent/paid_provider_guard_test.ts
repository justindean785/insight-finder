// paid_provider_guard_test.ts — the free-first guard for paid web-data providers.
//
// Two layers: the pure decision (lib/paid-provider-guard.ts), and the REAL wrap path
// (cache.ts wrapToolsWithCache) with a fake tool_usage_log, because the property that
// matters is "the paid tool never runs until a free tool tried the same selector",
// not the predicate in isolation. All selectors are reserved-domain / synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { isIntentionalSkip, wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { classifyToolOutcome } from "../../functions/osint-agent/tool-outcome.ts";
import {
  type PaidGuardPolicy,
  PAID_GUARD_ERROR_PREFIX,
  PAID_GUARD_POLICIES,
  PAID_GUARD_REFUSAL_MARKER,
  decidePaidCall,
  paidGuardRefusal,
  paidProviderGuardSelfTest,
  registerPaidGuardPolicy,
} from "../../functions/osint-agent/lib/paid-provider-guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const URL_A = "https://example.com/protected";
const URL_B = "https://example.org/other";
const PAID = "test_paid_scrape";
const FREE = "jina_reader_scrape";

const POLICY: PaidGuardPolicy = {
  provider: "testprovider",
  rules: [{ tools: [FREE], outcomes: ["failed", "empty"], label: "free_reader_blocked" }],
  tryFirst: [FREE],
};

// ---- Pure decision ---------------------------------------------------------------

const SEL = "url:https://example.com/a";

Deno.test("decide: no attempt on the selector ⇒ refused free_first", () => {
  assertEquals(decidePaidCall({ policy: POLICY, selector: SEL, attempts: [] }), { allow: false, reason: "free_first" });
});

Deno.test("decide: a free attempt that SUCCEEDED does not clear a paid call", () => {
  const d = decidePaidCall({ policy: POLICY, selector: SEL, attempts: [{ tool: FREE, selector: SEL, outcome: "ok" }] });
  assertEquals(d.allow, false);
});

Deno.test("decide: a failed or empty free attempt on the SAME selector clears it", () => {
  for (const outcome of ["failed", "empty"]) {
    const d = decidePaidCall({ policy: POLICY, selector: SEL, attempts: [{ tool: FREE, selector: SEL, outcome }] });
    assertEquals(d, { allow: true, admitted_by: "free_attempt", rule: "free_reader_blocked", cleared_by: FREE });
  }
});

Deno.test("decide: a failure on another selector, or by a tool outside the rule, does not clear it", () => {
  assertEquals(decidePaidCall({
    policy: POLICY, selector: SEL, attempts: [{ tool: FREE, selector: "url:https://example.com/b", outcome: "failed" }],
  }).allow, false);
  assertEquals(decidePaidCall({
    policy: POLICY, selector: SEL, attempts: [{ tool: "some_other_tool", selector: SEL, outcome: "failed" }],
  }).allow, false);
  // A skipped free call is not an attempt: the free tool never answered either way.
  assertEquals(decidePaidCall({
    policy: POLICY, selector: SEL, attempts: [{ tool: FREE, selector: SEL, outcome: "skipped" }],
  }).allow, false);
});

Deno.test("decide: force_second_source needs a real justification, which is trimmed and capped", () => {
  assertEquals(decidePaidCall({ policy: POLICY, selector: SEL, attempts: [], forceSecondSource: true }),
    { allow: false, reason: "justification_required" });
  assertEquals(decidePaidCall({ policy: POLICY, selector: SEL, attempts: [], forceSecondSource: true, justification: "  because  " }),
    { allow: false, reason: "justification_required" });
  // A string "true" is not consent.
  assertEquals(decidePaidCall({ policy: POLICY, selector: SEL, attempts: [], forceSecondSource: "true", justification: "corroborating a lead" }).allow, false);
  const long = "x".repeat(500);
  const d = decidePaidCall({ policy: POLICY, selector: SEL, attempts: [], forceSecondSource: true, justification: long });
  assert(d.allow && d.admitted_by === "force_second_source" && d.justification.length === 200);
});

Deno.test("decide: an empty selector is refused no_selector", () => {
  assertEquals(decidePaidCall({ policy: POLICY, selector: "", attempts: [] }), { allow: false, reason: "no_selector" });
});

Deno.test("refusal: constant error, logs as skipped, never echoes caller text", () => {
  const r = paidGuardRefusal(PAID, POLICY, "free_first");
  assert(r.error.startsWith(PAID_GUARD_ERROR_PREFIX));
  assertEquals(classifyToolOutcome(r.error, null), "skipped");
  assertEquals(r.provider_attempted, false);
  assertEquals(r.ok, false);
  assertEquals(r.refused_by, PAID_GUARD_REFUSAL_MARKER);
  assertEquals(r.try_first, [FREE]);
});

Deno.test("self-test: passes, reports mode and the registered-policy count", () => {
  const h = paidProviderGuardSelfTest(false, false);
  assertEquals(h.ok, true, h.detail);
  assertEquals(h.mode, "enforcing");
  assertEquals(paidProviderGuardSelfTest(true, false).mode, "disabled");
  assertEquals(paidProviderGuardSelfTest(false, true).mode, "dry_run");
});

Deno.test("the guarded set is exactly the static policy list (lib/paid-guard-policies.ts)", async () => {
  await import("../../functions/osint-agent/lib/paid-guard-policies.ts");
  const { GUARDED_PAID_TOOLS } = await import("../../functions/osint-agent/lib/paid-guard-policies.ts");
  const registered = [...PAID_GUARD_POLICIES.keys()].filter((k) => k !== PAID).sort();
  assertEquals(registered, [...GUARDED_PAID_TOOLS].sort());
});

// ---- The real wrap path ------------------------------------------------------------

type UsageRow = { tool_name: string; outcome: string; input_json: Record<string, unknown>; created_at?: string; cached?: boolean };

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

function fakeSupabase(opts: {
  rows?: readonly UsageRow[];
  logError?: boolean;
  cacheRow?: { output_json: unknown; created_at: string } | null;
  inserted?: Array<Record<string, unknown>>;
}): SupabaseClient {
  const rows = opts.rows ?? [];
  const usage: Record<string, unknown> = {};
  let from = 0;
  let to = rows.length - 1;
  for (const m of ["select", "eq", "in", "order", "limit", "update"]) usage[m] = () => usage;
  usage.range = (a: number, b: number) => { from = a; to = b; return usage; };
  usage.insert = (row: Record<string, unknown>) => { opts.inserted?.push(row); return Promise.resolve({ error: null }); };
  usage.maybeSingle = () => Promise.resolve({ data: null, error: null });
  usage.then = (r: (v: { data: unknown; error: unknown }) => void) =>
    r(opts.logError ? { data: null, error: { message: "boom" } } : { data: rows.slice(from, to + 1), error: null });
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const cache = makeChain({ data: opts.cacheRow ?? null, error: null });
  cache.insert = () => Promise.resolve({ error: null });
  cache.upsert = () => Promise.resolve({ error: null });
  return {
    from: (t: string) => t === "tool_usage_log" ? usage : t === "tool_call_cache" ? cache : inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function tool(calls: { n: number }, result: Record<string, unknown>): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve(result); },
  } as unknown as Tool;
}

let seq = 0;
function wrap(db: SupabaseClient, paid: { n: number }, free: { n: number } = { n: 0 }, freeResult: Record<string, unknown> = { ok: true, text: "page" }) {
  seq += 1;
  const investigationId = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache({
    [PAID]: tool(paid, { ok: true, text: "paid page" }),
    [FREE]: tool(free, freeResult),
  }, { investigationId, userId: "u1", supabase: db });
}
type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };
const run = (w: Record<string, Tool>, name: string, input: Record<string, unknown>) =>
  (w[name] as unknown as Exec).execute(input, {}) as Promise<Record<string, unknown>>;

async function withPolicy(fn: () => Promise<void>) {
  registerPaidGuardPolicy(PAID, POLICY);
  try { await fn(); } finally { PAID_GUARD_POLICIES.delete(PAID); }
}

async function withEnv(key: string, value: string, fn: () => Promise<void>) {
  const prev = Deno.env.get(key);
  Deno.env.set(key, value);
  try { await fn(); } finally { if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev); }
}

Deno.test("wrap: a guarded paid tool with no free attempt is refused before it runs, uncharged, as a skip", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    const inserted: Array<Record<string, unknown>> = [];
    const w = wrap(fakeSupabase({ inserted }), paid);
    const r = await run(w, PAID, { url: URL_A });
    assertEquals(paid.n, 0, "the paid tool must not run");
    assertEquals(r.ok, false);
    assertEquals(r.refused_by, PAID_GUARD_REFUSAL_MARKER);
    assertEquals(r.paid_guard, "free_first");
    assertEquals(r.provider_attempted, false);
    assert(isIntentionalSkip(r));
    const row = inserted.find((x) => x.tool_name === PAID)!;
    assertEquals(row.outcome, "skipped");
    assertEquals(row.charged_micro_usd, 0);
    assertEquals(row.cost_micro_usd, 0);
  }));

Deno.test("wrap: a PRIOR-TURN free failure on the same URL admits the paid call, and the row says why", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    const inserted: Array<Record<string, unknown>> = [];
    const db = fakeSupabase({ inserted, rows: [{ tool_name: FREE, outcome: "failed", input_json: { input: { url: URL_A } } }] });
    const r = await run(wrap(db, paid), PAID, { url: URL_A });
    assertEquals(paid.n, 1);
    assertEquals(r.ok, true);
    const runtime = ((inserted.find((x) => x.tool_name === PAID)!.input_json as Record<string, unknown>).runtime) as Record<string, unknown>;
    assertEquals(runtime.paid_guard_admitted_by, "free_attempt");
    assertEquals(runtime.paid_guard_cleared_by, FREE);
  }));

Deno.test("wrap: a prior free SUCCESS, a failure on another URL, or a cached free row do not admit it", () =>
  withPolicy(async () => {
    for (const rows of [
      [{ tool_name: FREE, outcome: "ok", input_json: { input: { url: URL_A } } }],
      [{ tool_name: FREE, outcome: "failed", input_json: { input: { url: URL_B } } }],
      [{ tool_name: FREE, outcome: "failed", input_json: { input: { url: URL_A } }, cached: true }],
    ]) {
      const paid = { n: 0 };
      await run(wrap(fakeSupabase({ rows }), paid), PAID, { url: URL_A });
      assertEquals(paid.n, 0, JSON.stringify(rows));
    }
  }));

Deno.test("wrap: a free tool that fails EARLIER IN THIS RUN admits the paid call (history is read once per run)", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    const free = { n: 0 };
    const w = wrap(fakeSupabase({}), paid, free, { ok: false, error: "jina 403", origin_error: true, target_status: 403 });
    const refusedFirst = await run(w, PAID, { url: URL_A });
    assertEquals(refusedFirst.paid_guard, "free_first");
    await run(w, FREE, { url: URL_A });
    assertEquals(free.n, 1);
    const r = await run(w, PAID, { url: URL_A });
    assertEquals(paid.n, 1, "the in-run free failure must clear the paid call");
    assertEquals(r.ok, true);
  }));

Deno.test("wrap: force_second_source + justification admits and logs the justification; bare force is refused", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    const inserted: Array<Record<string, unknown>> = [];
    const w = wrap(fakeSupabase({ inserted }), paid);
    const bare = await run(w, PAID, { url: URL_A, force_second_source: true });
    assertEquals(bare.paid_guard, "justification_required");
    assertEquals(paid.n, 0);
    await run(w, PAID, { url: URL_A, force_second_source: true, second_source_justification: "corroborating an unverified lead" });
    assertEquals(paid.n, 1);
    const live = inserted.filter((x) => x.tool_name === PAID).at(-1)!;
    const runtime = (live.input_json as Record<string, unknown>).runtime as Record<string, unknown>;
    assertEquals(runtime.paid_guard_admitted_by, "force_second_source");
    assertEquals(runtime.paid_guard_justification, "corroborating an unverified lead");
  }));

Deno.test("wrap: a cache hit is served even when the guard would refuse", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    const db = fakeSupabase({ cacheRow: { output_json: { ok: true, text: "cached paid page" }, created_at: new Date().toISOString() } });
    const r = await run(wrap(db, paid), PAID, { url: URL_A });
    assertEquals(paid.n, 0);
    assertEquals(r.ok, true);
    assertEquals(r.refused_by, undefined);
  }));

Deno.test("wrap: an unreadable history fails open to this run's attempts only (still refuses with none)", () =>
  withPolicy(async () => {
    const paid = { n: 0 };
    await run(wrap(fakeSupabase({ logError: true }), paid), PAID, { url: URL_A });
    assertEquals(paid.n, 0);
  }));

Deno.test("wrap: PAID_PROVIDER_GUARD_DISABLED admits at call time; DRY_RUN admits and records the shadow reason", () =>
  withPolicy(async () => {
    await withEnv("PAID_PROVIDER_GUARD_DISABLED", "true", async () => {
      const paid = { n: 0 };
      await run(wrap(fakeSupabase({}), paid), PAID, { url: URL_A });
      assertEquals(paid.n, 1);
    });
    await withEnv("PAID_PROVIDER_GUARD_DRY_RUN", "true", async () => {
      const paid = { n: 0 };
      const inserted: Array<Record<string, unknown>> = [];
      await run(wrap(fakeSupabase({ inserted }), paid), PAID, { url: URL_A });
      assertEquals(paid.n, 1);
      const runtime = (inserted.find((x) => x.tool_name === PAID)!.input_json as Record<string, unknown>).runtime as Record<string, unknown>;
      assertEquals(runtime.paid_guard_admitted_by, "dry_run");
      assertEquals(runtime.paid_guard_shadow_reason, "free_first");
    });
  }));

Deno.test("wrap: a tool with no registered policy is never gated", async () => {
  const paid = { n: 0 };
  await run(wrap(fakeSupabase({}), paid), PAID, { url: URL_A });
  assertEquals(paid.n, 1);
});

Deno.test("wiring: /health reports checks.paid_provider_guard and SKIP_RE names the refusal head", async () => {
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("const paidGuardHealth = { ...paidProviderGuardSelfTest(), guarded: [...GUARDED_PAID_TOOLS] };"));
  assert(health.includes("r.checks.paid_provider_guard = paidGuardHealth;"));
  const outcome = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-outcome.ts", import.meta.url));
  assert(outcome.includes("paid guard:"));
});

Deno.test("wrap: selectors are keyed type:value — a free failure on a NAME does not clear a USERNAME with the same text", () =>
  withPolicy(async () => {
    registerPaidGuardPolicy("test_paid_profile", {
      provider: "testprovider",
      rules: [{ tools: ["free_profile"], outcomes: ["failed", "empty"], label: "free_profile_blocked" }],
      tryFirst: ["free_profile"],
    });
    try {
      const paid = { n: 0 };
      seq += 1;
      const investigationId = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
      clearRuntime(investigationId);
      circuit.clearThread(investigationId);
      const rows = [{ tool_name: "free_profile", outcome: "failed", input_json: { input: { name: "example handle" } } }];
      const w = wrapToolsWithCache({ test_paid_profile: tool(paid, { ok: true }) }, { investigationId, userId: "u1", supabase: fakeSupabase({ rows }) });
      await run(w, "test_paid_profile", { username: "Example Handle" });
      assertEquals(paid.n, 0, "a name-typed failure must not clear a username-typed paid call");
      const rows2 = [{ tool_name: "free_profile", outcome: "failed", input_json: { input: { handle: "@Example_Handle" } } }];
      seq += 1;
      const id2 = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
      clearRuntime(id2);
      circuit.clearThread(id2);
      const w2 = wrapToolsWithCache({ test_paid_profile: tool(paid, { ok: true }) }, { investigationId: id2, userId: "u1", supabase: fakeSupabase({ rows: rows2 }) });
      await run(w2, "test_paid_profile", { username: "example_handle" });
      assertEquals(paid.n, 1, "handle and username are both username-typed, and '@' and case are normalized away");
    } finally {
      PAID_GUARD_POLICIES.delete("test_paid_profile");
    }
  }));
