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

Deno.test("memory_recall is versioned: the pre-provenance interpretation is the unversioned legacy key, so this starts at 2", async () => {
  await withEnv({ [VERSION_SWITCH]: undefined }, async () => {
    assertEquals(TOOL_CACHE_VERSION.memory_recall, 2);
    assertEquals(cacheVersionFor("memory_recall"), 2);
  });
  // The kill switch still restores the legacy key for every tool, this one included.
  await withEnv({ [VERSION_SWITCH]: "true" }, async () => assertEquals(cacheVersionFor("memory_recall"), null));
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

Deno.test("CONTROL: with the cache-version kill switch thrown the SAME stored pre-change row IS replayed, untagged — this is the bypass the version closes", async () => {
  const cacheStore: Row[] = [];
  const memoryRows = [memoryRow("m1", "operator@example.com")];
  const counters = { memoryReads: 0 };
  await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: "true" }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-control-write"));
  assertEquals(counters.memoryReads, 1);

  // Provenance wording ON, version keys OFF: the wrapper serves the pre-change row before the tool runs.
  const replayed = await withEnv({ [VERSION_SWITCH]: "true", [WORDING_SWITCH]: undefined }, () =>
    recallThroughCache(cacheStore, memoryRows, counters, "mrc-control-read"));
  assertEquals(counters.memoryReads, 1, "the fake does serve rows: the legacy row replays instead of calling live");
  assertEquals(replayed._cached, true);
  assertFalse("provenance" in firstMemory(replayed), "…and it is the UNTAGGED row — provenance bypassed");
});

Deno.test("the served interpretation is recorded in runtime meta, and /health names memory_recall=v2", async () => {
  const live = await withEnv({ [VERSION_SWITCH]: undefined }, () =>
    recallThroughCache([], [memoryRow("m1", "operator@example.com")], { memoryReads: 0 }, "mrc-meta"));
  assertEquals((live._runtime as Row | undefined)?.cache_version, 2);
  const { describeToolCacheVersions } = await import("./lib/tool-cache-version.ts");
  const detail = await withEnv({ [VERSION_SWITCH]: undefined }, async () => describeToolCacheVersions().detail);
  assert(detail.includes("memory_recall=v2"), detail);
});
