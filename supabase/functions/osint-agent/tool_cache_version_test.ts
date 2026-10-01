// tool_cache_version_test.ts — a result cached under an OLD interpretation must not replay.
//
// Production, 2026-09-14: the #594 sweep fix deployed ~16:30Z, and a re-scan at 17:19Z
// replayed a username_sweep row written at 13:44Z (`tool_usage_log.cached = true`) that still
// counted HackerRank/Mixcloud/Telegram as registrations. The cache key had no version, so the
// fix was invisible for the row's 6h TTL.
//
// These tests DRIVE wrapToolsWithCache against a fake tool_call_cache that stores what the
// wrapper upserts and answers the wrapper's own lookups — the user-scoped input_hash layer AND
// the thread-scoped params_hash reuse layer. Each "stale row is not replayed" assertion has a
// control through the SAME layer: the same stored row IS replayed once the kill switch
// restores legacy keys, so a miss can never be an artifact of a fake that fails to serve rows.
//
// "Legacy" is not taken on trust from the kill switch: GOLDEN_* are the exact hashes the
// pre-PR cache.ts (origin/main at b59a1aa) wrote for these inputs, measured by running this
// harness against that file. An unversioned tool, and a versioned tool under the kill switch,
// must still produce them byte-for-byte.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { describeToolCacheVersions, TOOL_CACHE_VERSION } from "./lib/tool-cache-version.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type CacheRow = Record<string, unknown>;

const USER = "u-tool-cache-version";
const SWITCH = "TOOL_CACHE_VERSION_DISABLED";

// Measured against origin/main's cache.ts (b59a1aa). See the header.
const GOLDEN_DNS_INPUT_HASH = "a06b750d7705e71e1e8a44bea5201711c1169cdd73af65db55f61f28d104f84e";
const GOLDEN_SWEEP_INPUT_HASH = "4f185e31aa418f8458620406e8be3dbe296587963f300c97ef12e253f2117426";
/** params_hash of an input whose only keys are the selector — identical for both tools on main. */
const GOLDEN_SELECTOR_ONLY_PARAMS_HASH = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

/** A fake whose tool_call_cache is a real in-memory table keyed the way the wrapper queries it. */
function cacheDb(store: CacheRow[]): SupabaseClient {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = chain;
    q.in = chain;
    q.order = chain;
    q.limit = chain;
    q.range = chain;
    q.update = chain;
    q.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return q;
    };
    q.maybeSingle = () => {
      if (table !== "tool_call_cache") return Promise.resolve({ data: null, error: null });
      const row = store.find((r) =>
        Object.entries(filters).every(([col, val]) => col === "stale" ? r.stale === val : r[col] === val)
      );
      return Promise.resolve({ data: row ?? null, error: null });
    };
    q.insert = () => Promise.resolve({ error: null });
    q.upsert = (row: CacheRow) => {
      if (table === "tool_call_cache") store.push({ ...row });
      return Promise.resolve({ error: null });
    };
    return q;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

function sweepTool(counter: { n: number }): Tool {
  return {
    description: "username sweep",
    execute: async () => {
      counter.n++;
      return { username: "fixture_handle", total: 3, hits: 0, found: [], unverified: [{ site: "Telegram", found: false, outcome: "unverified", unverified: true, status: 200 }] };
    },
  } as unknown as Tool;
}

function dnsTool(counter: { n: number }): Tool {
  return {
    description: "dns records",
    execute: async () => {
      counter.n++;
      return { ok: true, records: [{ type: "A", value: "192.0.2.10" }] };
    },
  } as unknown as Tool;
}

async function call(
  tools: Record<string, Tool>,
  name: string,
  input: Record<string, unknown>,
  store: CacheRow[],
  investigationId: string,
): Promise<Record<string, unknown>> {
  clearRuntime(investigationId);
  const db = cacheDb(store);
  const wrapped = wrapToolsWithCache(tools, { investigationId, userId: USER, supabase: db, supabaseAdmin: db });
  const execute = wrapped[name].execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
  const out = await execute(input, { toolCallId: `${investigationId}-call`, messages: [] });
  clearRuntime(investigationId);
  return out;
}

async function withSwitch<T>(disabled: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = Deno.env.get(SWITCH);
  if (disabled) Deno.env.set(SWITCH, "true");
  else Deno.env.delete(SWITCH);
  try {
    return await fn();
  } finally {
    if (prior === undefined) Deno.env.delete(SWITCH);
    else Deno.env.set(SWITCH, prior);
  }
}

Deno.test("username_sweep: a row cached under the legacy key is NOT replayed once versioned — and IS replayed under the kill switch", async () => {
  const store: CacheRow[] = [];
  const runs = { n: 0 };
  const tools = { username_sweep: sweepTool(runs) };
  const input = { username: "fixture_handle" };

  // 1. Pre-change behaviour (kill switch on): live call, row written under the legacy key.
  const first = await withSwitch(true, () => call(tools, "username_sweep", input, store, "tcv-legacy-write"));
  assertEquals(runs.n, 1);
  assertEquals(store.length, 1, "the legacy call must persist a cache row");
  assertEquals(first._cached, undefined);
  const legacy = store[0];

  // 2. Versioned (default): the stored legacy row matches neither lookup, so the tool runs live.
  const second = await withSwitch(false, () => call(tools, "username_sweep", input, store, "tcv-versioned"));
  assertEquals(runs.n, 2, "a row written under the old interpretation must not be replayed");
  assertEquals(second._cached, undefined);
  assertEquals(store.length, 2, "the fresh result is persisted under its own key");
  assertNotEquals(store[1].input_hash, legacy.input_hash, "exact-match key must change");
  assertNotEquals(store[1].params_hash, legacy.params_hash, "thread-reuse key must change too");

  // 3. Control: restoring legacy keys serves the ORIGINAL row — the fake does serve rows.
  const third = await withSwitch(true, () => call(tools, "username_sweep", input, store, "tcv-kill-switch"));
  assertEquals(runs.n, 2, "under the kill switch the legacy row replays instead of calling live");
  assertEquals(third._cached, true);
});

Deno.test("same thread: a legacy row is NOT served through thread reuse — and IS, through the same layer, under the kill switch", async () => {
  // Only `purpose` varies, so every call has a DIFFERENT input_hash and the user layer cannot
  // match: anything served here came through the thread-scoped params_hash layer.
  const store: CacheRow[] = [];
  const runs = { n: 0 };
  const tools = { username_sweep: sweepTool(runs) };
  const thread = "tcv-same-thread";
  const input = (purpose: string) => ({ username: "fixture_handle", purpose, force: true });

  await withSwitch(true, () => call(tools, "username_sweep", input("first look"), store, thread));
  assertEquals(runs.n, 1);
  assertEquals(store[0].params_hash, GOLDEN_SELECTOR_ONLY_PARAMS_HASH, "legacy row carries main's params_hash");

  const versioned = await withSwitch(false, () => call(tools, "username_sweep", input("second look"), store, thread));
  assertEquals(runs.n, 2, "a legacy row must not be replayed by thread reuse in the same thread");
  assertEquals(versioned._cached, undefined);

  const control = await withSwitch(true, () => call(tools, "username_sweep", input("third look"), store, thread));
  assertEquals(runs.n, 2, "under the kill switch thread reuse serves the legacy row");
  assertEquals(control._cached, true);
  assertEquals((control._runtime as Record<string, unknown> | undefined)?.selector_reuse, true, "served by the thread layer, not the user layer");
});

Deno.test("keys are byte-identical to main for unversioned tools and under the kill switch; versioned keys differ", async () => {
  const dnsStore: CacheRow[] = [];
  await withSwitch(false, () => call({ dns_records: dnsTool({ n: 0 }) }, "dns_records", { domain: "cache-version.example" }, dnsStore, "tcv-golden-dns"));
  assertEquals(dnsStore[0].input_hash, GOLDEN_DNS_INPUT_HASH, "unversioned exact-match key unchanged");
  assertEquals(dnsStore[0].params_hash, GOLDEN_SELECTOR_ONLY_PARAMS_HASH, "unversioned thread-reuse key unchanged");

  const legacyStore: CacheRow[] = [];
  await withSwitch(true, () => call({ username_sweep: sweepTool({ n: 0 }) }, "username_sweep", { username: "fixture_handle" }, legacyStore, "tcv-golden-legacy"));
  assertEquals(legacyStore[0].input_hash, GOLDEN_SWEEP_INPUT_HASH, "kill switch restores main's exact-match key");
  assertEquals(legacyStore[0].params_hash, GOLDEN_SELECTOR_ONLY_PARAMS_HASH, "kill switch restores main's thread-reuse key");

  const versionedStore: CacheRow[] = [];
  await withSwitch(false, () => call({ username_sweep: sweepTool({ n: 0 }) }, "username_sweep", { username: "fixture_handle" }, versionedStore, "tcv-golden-versioned"));
  assertNotEquals(versionedStore[0].input_hash, GOLDEN_SWEEP_INPUT_HASH);
  assertNotEquals(versionedStore[0].params_hash, GOLDEN_SELECTOR_ONLY_PARAMS_HASH);
});

Deno.test("an unversioned tool keeps a byte-identical key — versioning invalidates nothing else", async () => {
  assert(!("dns_records" in TOOL_CACHE_VERSION), "fixture assumes dns_records is unversioned");
  const store: CacheRow[] = [];
  const runs = { n: 0 };
  const tools = { dns_records: dnsTool(runs) };
  const input = { domain: "cache-version.example" };

  await withSwitch(true, () => call(tools, "dns_records", input, store, "tcv-dns-legacy"));
  assertEquals(runs.n, 1);
  const replay = await withSwitch(false, () => call(tools, "dns_records", input, store, "tcv-dns-versioned"));
  assertEquals(runs.n, 1, "a legacy row for an unversioned tool must still replay after this ships");
  assertEquals(replay._cached, true);
});

Deno.test("the served interpretation is recorded in runtime meta for versioned tools only", async () => {
  const sweep = await withSwitch(false, () =>
    call({ username_sweep: sweepTool({ n: 0 }) }, "username_sweep", { username: "meta_handle" }, [], "tcv-meta-sweep"));
  const sweepRuntime = sweep._runtime as Record<string, unknown> | undefined;
  assertEquals(sweepRuntime?.cache_version, TOOL_CACHE_VERSION.username_sweep);

  const dns = await withSwitch(false, () =>
    call({ dns_records: dnsTool({ n: 0 }) }, "dns_records", { domain: "meta.example" }, [], "tcv-meta-dns"));
  const dnsRuntime = dns._runtime as Record<string, unknown> | undefined;
  assert(dnsRuntime !== undefined, "runtime meta is attached");
  assertEquals("cache_version" in dnsRuntime, false);
});

Deno.test("/health: checks.tool_cache_version names the versions, and says when the switch is thrown", async () => {
  const on = await withSwitch(false, async () => describeToolCacheVersions());
  assertEquals(on.ok, true);
  assert(on.detail.includes("username_sweep=v2"), on.detail);
  assert(on.detail.includes("username_search=v2"), on.detail);
  const off = await withSwitch(true, async () => describeToolCacheVersions());
  assert(off.detail.startsWith("disabled"), off.detail);

  const health = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.tool_cache_version = describeToolCacheVersions()"), "health probe must report the check");
});
