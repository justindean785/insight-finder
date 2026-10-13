// memory_recall_cache_test.ts — a memory_recall result cached BEFORE the provenance change must
// not be replayed AFTER it.
//
// The hole (#738 independent review, 2026-10-13). #738 changes memory_recall's OUTPUT SHAPE: every
// row now carries a `provenance` tag, and the payload carries `provenance_legend` and
// `authority_note`. But memory_recall is cacheable (24h, user-scoped; it is in neither
// NO_CACHE_TOOLS nor TOOL_CACHE_VERSION), and the cache key says nothing about which build wrote
// the row. So for up to 24h after deploy the wrapper would serve the PRE-change row — rows with no
// provenance tag, no legend, no authority note — BEFORE this code runs. The very controls the PR
// adds would be bypassed for every subject recalled in the last day, and the post-deploy scan
// would read as "the fix did not work".
//
// These tests DRIVE the REAL memory_recall tool (buildTools) through the REAL wrapToolsWithCache
// against a fake tool_call_cache that stores what the wrapper upserts and answers its lookups.
// The "pre-change row" is not hand-written: it is produced by the unmodified code path with both
// kill switches thrown, which is exactly what a pre-change build wrote (legacy shape, unversioned
// key). Each "is not replayed" assertion has a control through the SAME layer: with the cache
// version kill switch thrown the same stored row IS replayed, so a miss can never be an artifact
// of a fake that fails to serve rows. Synthetic values only.
//
// SECOND ROUND (owner-authorised, 2026-10-13): the version bump alone left a rollback hole. Throwing the
// MEMORY_AUTHORITY_WORDING_DISABLED kill switch makes memory_recall return the LEGACY shape, and that shape was
// cached under the SAME v2 key — so after the switch was flipped back, untagged rows replayed for up to 24h (and
// tagged rows kept replaying after a rollback). The key now follows the output SHAPE, not just the build: v2 while
// the provenance wording is on, the legacy (pre-change) key while it is off. The TTL is unchanged.
import { assert, assertEquals, assertFalse, assertNotEquals } from "jsr:@std/assert@^1";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { routingGuard } from "./guard.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { cacheVersionFor, TOOL_CACHE_VERSION } from "./lib/tool-cache-version.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const USER = "u-memory-recall-cache";
const VERSION_SWITCH = "TOOL_CACHE_VERSION_DISABLED";
const WORDING_SWITCH = "MEMORY_AUTHORITY_WORDING_DISABLED";

const memoryRow = (id: string, subject: string): Row => ({
  id, kind: "identity", subject, subject_kind: "email", related_values: ["site.example"],
  content: `Synthetic model-written identity about ${subject}.`, confidence: 74,
});

/** tool_call_cache is a real in-memory table keyed the way the wrapper queries it; agent_memory serves fixed rows and counts reads. */
function makeDb(cacheStore: Row[], memoryRows: Row[], counters: { memoryReads: number }): SupabaseClient {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["select", "in", "order", "limit", "range", "update", "or", "neq", "is", "not", "gt", "gte", "lte", "ilike", "contains"]) q[m] = chain;
    q.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return q;
    };
    if (table === "agent_memory") {
      q.select = () => {
        counters.memoryReads++;
        return q;
      };
    }
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
    if (table !== "tool_call_cache") {
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "agent_memory" ? memoryRows : [], error: null }).then(resolve);
    }
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

/** One memory_recall through the REAL tool inside the REAL cache wrapper. */
async function recallThroughCache(
  cacheStore: Row[],
  memoryRows: Row[],
  counters: { memoryReads: number },
  thread: string,
  input: Row = { subject: "operator@example.com", kind: "any", limit: 20 },
): Promise<Row> {
  routingGuard.memoryRecallTimestamps = [];
  routingGuard.memoryRecallSubjectsThisStep.clear();
  clearRuntime(thread);
  const db = makeDb(cacheStore, memoryRows, counters);
  const { tools } = buildTools({
    supabase: db, supabaseAdmin: db, userId: USER, threadId: thread, archiveEnabled: false,
    detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext);
  const wrapped = wrapToolsWithCache(tools as never, { investigationId: thread, userId: USER, supabase: db, supabaseAdmin: db });
  const execute = (wrapped as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Row> }>).memory_recall.execute;
  const out = await execute(input, { toolCallId: `${thread}-call`, messages: [] });
  clearRuntime(thread);
  return out;
}

const firstMemory = (out: Row): Row => (out.memories as Row[])[0];

Deno.test("memory_recall's cache key follows its OUTPUT SHAPE: v2 while the provenance wording is on, the legacy key while it is thrown", async () => {
  const key = async (env: Record<string, string | undefined>, tool = "memory_recall") =>
    await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined, ...env }, async () => cacheVersionFor(tool));
  assertEquals(TOOL_CACHE_VERSION.memory_recall, 2);
  assertEquals(await key({}), 2, "mitigated shape ⇒ v2");
  assertEquals(await key({ [WORDING_SWITCH]: "true" }), null, "legacy shape ⇒ the pre-change (unversioned) key");
  // The GLOBAL version switch must not reopen the bypass for this tool: its key IS its shape.
  assertEquals(await key({ [VERSION_SWITCH]: "true" }), 2);
  assertEquals(await key({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }), null);
  // Everything else keeps the generic behaviour: the version switch restores legacy keys, the wording switch is memory-only.
  assertEquals(await key({ [VERSION_SWITCH]: "true" }, "username_sweep"), null);
  assertEquals(await key({ [WORDING_SWITCH]: "true" }, "username_sweep"), 2);
});

Deno.test("REGRESSION: a pre-change memory_recall row is NOT replayed — the tool runs live and the result carries provenance", async () => {
  const cacheStore: Row[] = [];
  const memoryRows = [memoryRow("m1", "operator@example.com")];
  const counters = { memoryReads: 0 };

  // 1. The world BEFORE the change: legacy wording, unversioned key. This is the row a pre-change build wrote.
  const before = await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-pre-change-write"));
  assertEquals(counters.memoryReads, 1, "the pre-change call must run live once");
  assertEquals(cacheStore.length, 1, "the pre-change call must persist a cache row");
  assertFalse("provenance" in firstMemory(before), "fixture: the pre-change row has NO provenance tag");
  assertFalse("provenance_legend" in before);
  assertFalse("authority_note" in before);
  const legacyRow = cacheStore[0];
  assertFalse("provenance" in ((legacyRow.output_json as Row).memories as Row[])[0], "fixture: the STORED row is untagged");

  // 2. After deploy (defaults): the stored pre-change row must not be served; the tool runs live.
  const after = await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-post-deploy"));
  assertEquals(counters.memoryReads, 2, "a row written under the old interpretation must not be replayed — the tool must run live");
  assertNotEquals(after._cached, true);
  assertEquals(firstMemory(after).provenance, "unreviewed", "the live result carries the provenance tag");
  assert("provenance_legend" in after && "authority_note" in after, "and the legend and authority note");
  assertEquals(cacheStore.length, 2, "the fresh result is persisted under its own key");
  assertNotEquals(cacheStore[1].input_hash, legacyRow.input_hash, "exact-match key must change");
  assertNotEquals(cacheStore[1].params_hash, legacyRow.params_hash, "thread-reuse key must change too");

  // 3. A second post-deploy call is served from the NEW row, and that row is the tagged one.
  const replay = await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-post-deploy-replay"));
  assertEquals(counters.memoryReads, 2, "the v2 row replays on the next call");
  assertEquals(replay._cached, true);
  assertEquals(firstMemory(replay).provenance, "unreviewed", "a replay can only ever be the tagged shape");
});

Deno.test("CONTROL: the SAME stored pre-change row IS replayed in the matching (legacy-wording) state — and the global version switch alone no longer reopens the bypass", async () => {
  const cacheStore: Row[] = [];
  const memoryRows = [memoryRow("m1", "operator@example.com")];
  const counters = { memoryReads: 0 };
  await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-control-write"));
  assertEquals(counters.memoryReads, 1);

  // Legacy wording ⇒ legacy key ⇒ the pre-change row is the CORRECT row to serve (it is legacy-shaped). This also shows the fake serves rows.
  const legacyReplay = await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: "true" }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-control-legacy-read"));
  assertEquals(counters.memoryReads, 1, "the legacy row replays in the legacy state");
  assertEquals(legacyReplay._cached, true);
  assertFalse("provenance" in firstMemory(legacyReplay));

  // Provenance wording ON with the GLOBAL version switch thrown: before this round the wrapper served the untagged row here.
  const mitigated = await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: undefined }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-control-mitigated-read"));
  assertEquals(counters.memoryReads, 2, "the untagged row must NOT replay while the provenance wording is on, whatever the version switch says");
  assertNotEquals(mitigated._cached, true);
  assertEquals(firstMemory(mitigated).provenance, "unreviewed");
});

Deno.test("TRANSITIONS: enabled → disabled → enabled → disabled never reuse a row written in the other state; each state replays its own", async () => {
  const cacheStore: Row[] = [];
  const memoryRows = [memoryRow("m1", "operator@example.com")];
  const counters = { memoryReads: 0 };
  const ENABLED = { [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined };
  const DISABLED = { [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: "true" };
  const run = (env: Record<string, string | undefined>, thread: string) =>
    withEnv(env, () => recallThroughCache(cacheStore, memoryRows, counters, thread));
  const tagged = (o: Row) => "provenance" in firstMemory(o) && "provenance_legend" in o && "authority_note" in o;
  const untagged = (o: Row) => !("provenance" in firstMemory(o)) && !("provenance_legend" in o) && !("authority_note" in o);

  // 1. ENABLED: live, tagged, stored under v2.
  const e1 = await run(ENABLED, "tr-1-enabled");
  assertEquals(counters.memoryReads, 1);
  assert(tagged(e1));
  assertEquals(cacheStore.length, 1);

  // 2. DISABLED (rollback): the tagged v2 row must NOT be served; the tool runs live and returns the LEGACY shape.
  const d1 = await run(DISABLED, "tr-2-disabled");
  assertEquals(counters.memoryReads, 2, "a tagged row written while enabled must not replay while disabled");
  assertNotEquals(d1._cached, true);
  assert(untagged(d1), "the live legacy result is legacy-shaped");
  assertEquals(cacheStore.length, 2);
  assertNotEquals(cacheStore[0].input_hash, cacheStore[1].input_hash, "the two shapes must live under different exact-match keys");
  assertNotEquals(cacheStore[0].params_hash, cacheStore[1].params_hash, "…and different thread-reuse keys");

  // 3. ENABLED again (re-enable): the UNTAGGED row written while disabled must NOT be served — the reported hole.
  const e2 = await run(ENABLED, "tr-3-enabled-again");
  assertEquals(counters.memoryReads, 2, "no live read: it is served from the ENABLED-state row…");
  assertEquals(e2._cached, true);
  assert(tagged(e2), "…and that row is the TAGGED one, never the untagged row from the disabled period");

  // 4. DISABLED again: served from its own (legacy) row.
  const d2 = await run(DISABLED, "tr-4-disabled-again");
  assertEquals(counters.memoryReads, 2);
  assertEquals(d2._cached, true);
  assert(untagged(d2));

  // 5. The GLOBAL version switch changes neither answer.
  const e3 = await run({ ...ENABLED, [VERSION_SWITCH]: "true" }, "tr-5-enabled-version-off");
  assertEquals(counters.memoryReads, 2);
  assert(tagged(e3) && e3._cached === true);
  const d3 = await run({ ...DISABLED, [VERSION_SWITCH]: "true" }, "tr-6-disabled-version-off");
  assertEquals(counters.memoryReads, 2);
  assert(untagged(d3) && d3._cached === true);

  // 6. The TTL is unchanged: both rows expire 24h out.
  for (const row of cacheStore) {
    const ms = Date.parse(String(row.expires_at)) - Date.now();
    assert(Math.abs(ms - 24 * 3600_000) < 5 * 60_000, `row expires in ${ms / 3600_000}h, expected ~24h`);
  }
});

Deno.test("REVERSE rollback: a tagged row written while enabled is not served after the switch is thrown, and the legacy result is exactly the pre-change shape", async () => {
  const cacheStore: Row[] = [];
  const memoryRows = [memoryRow("m1", "operator@example.com")];
  const counters = { memoryReads: 0 };
  await withEnv({ [WORDING_SWITCH]: undefined }, () => recallThroughCache(cacheStore, memoryRows, counters, "rr-enabled"));
  const rolledBack = await withEnv({ [WORDING_SWITCH]: "true" }, () => recallThroughCache(cacheStore, memoryRows, counters, "rr-disabled"));
  assertEquals(counters.memoryReads, 2);
  // (the cache wrapper adds its own `_runtime` / `_cached` bookkeeping; those are not part of the tool's shape)
  assertEquals(Object.keys(rolledBack).filter((k) => !k.startsWith("_")).sort(), ["count", "memories", "ok"], "legacy payload keys only");
  assertEquals(Object.keys(firstMemory(rolledBack)).sort(), Object.keys(memoryRows[0]).sort(), "legacy rows carry no extra fields");
});

Deno.test("the served interpretation is recorded in runtime meta, and /health names memory_recall=v2", async () => {
  const live = await withEnv({ [VERSION_SWITCH]: undefined }, () =>
    recallThroughCache([], [memoryRow("m1", "operator@example.com")], { memoryReads: 0 }, "mrc-meta"));
  assertEquals((live._runtime as Row | undefined)?.cache_version, 2);
  const { describeToolCacheVersions } = await import("./lib/tool-cache-version.ts");
  const detail = await withEnv({ [VERSION_SWITCH]: undefined }, async () => describeToolCacheVersions().detail);
  assert(detail.includes("memory_recall=v2"), detail);
});

Deno.test("prototype property names are not tools: cacheVersionFor never throws and never returns a non-version (review finding 6)", async () => {
  for (const name of ["hasOwnProperty", "toString", "constructor", "__proto__", "valueOf"]) {
    const v = await withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined }, async () => cacheVersionFor(name));
    assertEquals(v, null, name);
  }
});

Deno.test("/health detail names the ACTIVE memory_recall key in every switch state (review mutant S7)", async () => {
  const { describeToolCacheVersions } = await import("./lib/tool-cache-version.ts");
  const detail = (env: Record<string, string | undefined>) =>
    withEnv({ [VERSION_SWITCH]: undefined, [WORDING_SWITCH]: undefined, ...env }, async () => describeToolCacheVersions().detail);
  const on = await detail({});
  assert(on.includes("memory_recall=v2") && !on.includes("legacy-key"), on);
  const wordingOff = await detail({ [WORDING_SWITCH]: "true" });
  assert(wordingOff.includes("memory_recall=legacy-key (wording switch thrown)") && !wordingOff.includes("memory_recall=v2"), wordingOff);
  const versionOff = await detail({ [VERSION_SWITCH]: "true" });
  assert(versionOff.startsWith("disabled") && versionOff.includes("memory_recall=v2 (keyed by output shape, unaffected)"), versionOff);
  const bothOff = await detail({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" });
  assert(bothOff.startsWith("disabled") && bothOff.includes("memory_recall=legacy-key"), bothOff);
});
