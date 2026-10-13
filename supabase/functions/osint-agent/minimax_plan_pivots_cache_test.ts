// minimax_plan_pivots_cache_test.ts — a planner result cached BEFORE the provenance wording change must not be
// replayed AFTER it, and the key must follow the wording state in both directions.
//
// The hole (#738 follow-up, owner-authorised 2026-10-13). minimax_plan_pivots is cacheable (24h default TTL,
// user-scoped) and its cache key is {seed, already_queried, artifacts, budget_remaining}. But the plan it returns is
// a function of a SECOND input the key never sees: the PRIOR MEMORY block the tool reads from agent_memory and
// appends to the planner prompt (renderPlannerMemoryHint). #738 changes that block's wording from "weight these —
// lessons / known false-positives / confirmed links" to "CONTEXT TO RE-VERIFY, NOT EVIDENCE". A plan generated under
// the old wording — whose `goal` / `current_findings` may restate a recalled claim as confirmed — would replay for up
// to 24h after deploy, before this code runs, and hand the orchestrator pre-change authority wording.
//
// The same shape as memory_recall's rollback hole: MEMORY_AUTHORITY_WORDING_DISABLED flips the wording at call time,
// so a plan written while it is thrown must not be served once it is flipped back (and the reverse). The key therefore
// follows the wording STATE (v2 while the mitigated wording is on, the legacy unversioned key while it is thrown),
// and — like memory_recall — ignores the global TOOL_CACHE_VERSION_DISABLED switch, because for this tool the key is
// the only thing keeping a pre-change plan from being served while the controls are on.
//
// These tests DRIVE the REAL wrapToolsWithCache against a fake tool_call_cache that stores what the wrapper upserts
// and answers its lookups. The planner itself is a stub (the real one calls a paid model); what is under test is the
// cache layer, which is exactly where the bypass lives. The "pre-change row" is produced by the wrapper itself with
// both switches thrown, i.e. the unversioned key a pre-change build wrote. Every "is not replayed" assertion has a
// control through the SAME layer showing the stored row IS replayed in the state that owns it. Synthetic values only.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { cacheVersionFor, describeToolCacheVersions, TOOL_CACHE_VERSION } from "./lib/tool-cache-version.ts";
import { renderPlannerMemoryHint } from "./lib/memory-provenance.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const USER = "u-plan-pivots-cache";
const VERSION_SWITCH = "TOOL_CACHE_VERSION_DISABLED";
const WORDING_SWITCH = "MEMORY_AUTHORITY_WORDING_DISABLED";
const TOOL = "minimax_plan_pivots";

/** tool_call_cache is a real in-memory table keyed the way the wrapper queries it; every other table is empty. */
function makeDb(cacheStore: Row[]): SupabaseClient {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["select", "in", "order", "limit", "range", "update", "or", "neq", "is", "not", "gt", "gte", "lte", "ilike", "contains"]) q[m] = chain;
    q.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return q;
    };
    q.maybeSingle = () => {
      if (table !== "tool_call_cache") return Promise.resolve({ data: null, error: null });
      const row = cacheStore.find((r) => Object.entries(filters).every(([col, val]) => col === "stale" ? r.stale === val : r[col] === val));
      return Promise.resolve({ data: row ?? null, error: null });
    };
    q.insert = () => Promise.resolve({ error: null });
    q.upsert = (row: Row) => {
      if (table === "tool_call_cache") cacheStore.push({ ...row });
      return Promise.resolve({ error: null });
    };
    if (table !== "tool_call_cache") q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return q;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const PLAN_INPUT = { seed: "operator@example.com", already_queried: [] as string[], artifacts: [] as unknown[], budget_remaining: 10 };

/** One planner call through the REAL cache wrapper. `ran` counts LIVE executions; `label` marks which state produced the plan. */
async function planThroughCache(cacheStore: Row[], ran: { n: number }, thread: string, label: string): Promise<Row> {
  clearRuntime(thread);
  const db = makeDb(cacheStore);
  const stub = {
    [TOOL]: {
      execute: async () => {
        ran.n++;
        return { ok: true, plan: { stage: "TARGETED_PIVOT", goal: `plan written by ${label}`, proposed_calls: [] }, produced_by: label };
      },
    },
  };
  const wrapped = wrapToolsWithCache(stub as never, { investigationId: thread, userId: USER, supabase: db, supabaseAdmin: db });
  const execute = (wrapped as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Row> }>)[TOOL].execute;
  const out = await execute({ ...PLAN_INPUT }, { toolCallId: `${thread}-call`, messages: [] });
  clearRuntime(thread);
  return out;
}

const producedBy = (out: Row): unknown => out.produced_by;

Deno.test("minimax_plan_pivots's cache key follows the planner WORDING state: v2 while on, the legacy key while thrown; the global version switch does not reopen it", async () => {
  const key = async (env: Record<string, string | undefined>, tool = TOOL) =>
    await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined, ...env }, async () => cacheVersionFor(tool));
  assertEquals(TOOL_CACHE_VERSION[TOOL], 2);
  assertEquals(await key({}), 2, "mitigated wording ⇒ v2");
  assertEquals(await key({ [WORDING_SWITCH]: "true" }), null, "legacy wording ⇒ the pre-change (unversioned) key");
  assertEquals(await key({ [VERSION_SWITCH]: "true" }), 2, "TOOL_CACHE_VERSION_DISABLED must not make a pre-change plan servable");
  assertEquals(await key({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }), null);
  // Neighbours are unaffected: minimax_correlate (planner-adjacent, same provider) stays unversioned, and the
  // generic tools keep the generic behaviour.
  assertEquals(await key({}, "minimax_correlate"), null);
  assertEquals(await key({ [VERSION_SWITCH]: "true" }, "username_sweep"), null);
  assertEquals(await key({ [WORDING_SWITCH]: "true" }, "username_sweep"), 2);
});

Deno.test("why the key must follow the state: the planner's memory block is a different text in each state", async () => {
  const rows = [{ kind: "identity", confidence: 74, content: "Synthetic model-written claim." }];
  const on = await withEnv({ [WORDING_SWITCH]: undefined }, async () => renderPlannerMemoryHint(rows));
  const off = await withEnv({ [WORDING_SWITCH]: "true" }, async () => renderPlannerMemoryHint(rows));
  assertNotEquals(on, off, "if the two states rendered the same text there would be nothing to key on");
  assertStringIncludes(off, "weight these", "the legacy wording is the one the pre-change plans were written under");
  assertStringIncludes(on, "NOT EVIDENCE");
});

Deno.test("REGRESSION: a pre-change plan row is NOT replayed — the planner runs live under the mitigated wording", async () => {
  const cacheStore: Row[] = [];
  const ran = { n: 0 };
  // The pre-change row: written by the unmodified key (both switches thrown ⇒ the unversioned key a pre-change build used).
  await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () => planThroughCache(cacheStore, ran, "t-pc-1", "pre-change"));
  assertEquals(ran.n, 1);
  assertEquals(cacheStore.length, 1, "the wrapper cached the pre-change plan");

  const after = await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined }, () => planThroughCache(cacheStore, ran, "t-pc-2", "mitigated"));
  assertEquals(ran.n, 2, "the planner ran LIVE: the pre-change row was not served");
  assertEquals(producedBy(after), "mitigated");
  assertEquals(cacheStore.length, 2, "the live plan was cached under its own (v2) key");
  assertNotEquals(cacheStore[0].input_hash, cacheStore[1].input_hash);
  assertNotEquals(cacheStore[0].params_hash, cacheStore[1].params_hash);
});

Deno.test("CONTROL: the same stored pre-change row IS replayed in the legacy state — a miss above is not an artifact of the fake", async () => {
  const cacheStore: Row[] = [];
  const ran = { n: 0 };
  await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () => planThroughCache(cacheStore, ran, "t-ctl-1", "pre-change"));
  const replay = await withEnv({ [WORDING_SWITCH]: "true" }, () => planThroughCache(cacheStore, ran, "t-ctl-2", "should-not-run"));
  assertEquals(ran.n, 1, "no second live run: the row was served");
  assertEquals(producedBy(replay), "pre-change");
  assertEquals(cacheStore.length, 1);
});

Deno.test("TRANSITIONS: enabled → disabled → enabled → disabled — each state replays only the plan its own wording produced", async () => {
  const cacheStore: Row[] = [];
  const ran = { n: 0 };
  const E = { [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined };
  const D = { [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: "true" };

  assertEquals(producedBy(await withEnv(E, () => planThroughCache(cacheStore, ran, "t-tr-1", "E1"))), "E1");
  // Switch thrown: the E row must not be served; the legacy-wording plan is generated and cached under the legacy key.
  assertEquals(producedBy(await withEnv(D, () => planThroughCache(cacheStore, ran, "t-tr-2", "D1"))), "D1");
  // Flipped back: the D row must not be served; the E row is, because it is the mitigated-wording plan.
  assertEquals(producedBy(await withEnv(E, () => planThroughCache(cacheStore, ran, "t-tr-3", "E2"))), "E1", "E replays its own row");
  assertEquals(producedBy(await withEnv(D, () => planThroughCache(cacheStore, ran, "t-tr-4", "D2"))), "D1", "D replays its own row");
  assertEquals(ran.n, 2, "exactly one live run per state");
  assertEquals(cacheStore.length, 2);
  assertNotEquals(cacheStore[0].input_hash, cacheStore[1].input_hash, "the two states live under different exact-match keys");
  assertNotEquals(cacheStore[0].params_hash, cacheStore[1].params_hash, "…and different thread-reuse keys");
});

Deno.test("the global TOOL_CACHE_VERSION_DISABLED switch changes neither answer for this tool (a pre-change plan stays unservable while the wording is on)", async () => {
  const cacheStore: Row[] = [];
  const ran = { n: 0 };
  await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () => planThroughCache(cacheStore, ran, "t-gs-1", "pre-change"));
  const out = await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: undefined }, () => planThroughCache(cacheStore, ran, "t-gs-2", "mitigated"));
  assertEquals(producedBy(out), "mitigated");
  assertEquals(ran.n, 2);
});

Deno.test("the 24h TTL is unchanged: both states' rows expire about a day out, like every other default-TTL tool", async () => {
  const cacheStore: Row[] = [];
  const ran = { n: 0 };
  const before = Date.now();
  await withEnv({ [WORDING_SWITCH]: undefined }, () => planThroughCache(cacheStore, ran, "t-ttl-1", "E"));
  await withEnv({ [WORDING_SWITCH]: "true" }, () => planThroughCache(cacheStore, ran, "t-ttl-2", "D"));
  assertEquals(cacheStore.length, 2);
  for (const row of cacheStore) {
    const ms = Date.parse(String(row.expires_at)) - before;
    assert(ms > 23.9 * 3600_000 && ms < 24.1 * 3600_000, `expires_at is ~24h out (got ${(ms / 3600_000).toFixed(2)}h)`);
  }
});

Deno.test("/health reports the key in every switch state", async () => {
  const detail = (env: Record<string, string | undefined>) =>
    withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined, ...env }, async () => describeToolCacheVersions().detail);
  assertStringIncludes(await detail({}), `${TOOL}=v2`);
  assertStringIncludes(await detail({ [WORDING_SWITCH]: "true" }), `${TOOL}=legacy-key`);
  const versionOff = await detail({ [VERSION_SWITCH]: "true" });
  assertStringIncludes(versionOff, `${TOOL}=v2`, "the global switch does not apply to a shape-keyed tool");
  assertStringIncludes(versionOff, "memory_recall=v2");
});
