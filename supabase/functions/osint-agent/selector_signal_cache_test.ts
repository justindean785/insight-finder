// SELECTOR_SIGNAL_CACHE must be bounded AND invalidated.
//
// It was a bare module-level Map with neither. Two consequences:
//
//  1. Unbounded growth — the Map is module-scoped, so it accumulated an entry
//     per (thread, selectorType, selector) for the life of the isolate, across
//     every thread that isolate served.
//  2. Stale routing — the signal is DERIVED from the `artifacts` table. Any
//     artifact written mid-run left the cached signal describing the evidence as
//     it looked BEFORE the run's own findings, and the rest of the run routed on
//     that.
//
// (2) is the one that matters for evidence integrity, and it is what these tests
// pin: a thread that writes artifacts must drop its cached signals.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, invalidateSelectorSignals } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { clearThread } from "./circuit.ts";
import { LRU } from "./safety.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue);
  return node;
}

// Returns artifact rows, so loadSelectorEvidence actually reaches its cache
// write. With an empty result it early-returns without caching, and a test built
// on that would assert 0 === 0 whether or not invalidation is wired at all.
function fakeSupabase(rows: unknown[] = []): SupabaseClient {
  const chain = makeChain({ data: rows, error: null });
  chain.insert = () => Promise.resolve({ error: null });
  chain.upsert = () => Promise.resolve({ error: null });
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

const ARTIFACT_ROWS = [
  { kind: "username", value: "aliceh", confidence: 70, source: "socialfetch", metadata: {} },
];

function makeTool(): Tool {
  return {
    description: "test tool",
    execute: async () => { await Promise.resolve(); return { ok: true }; },
  } as unknown as Tool;
}

Deno.test("selector signals: a lookup really does populate the cache (control)", async () => {
  // Guards the test below from passing vacuously. If this ever returns 0, the
  // invalidation test proves nothing and must be re-anchored.
  const threadId = "sel-cache-control";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase(ARTIFACT_ROWS);
  const wrapped = wrapToolsWithCache(
    { socialfetch_username: makeTool() },
    { investigationId: threadId, userId: "u-sel", supabase, supabaseAdmin: supabase },
  );
  const lookup = wrapped.socialfetch_username.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await lookup({ username: "aliceh", force: true }, { toolCallId: `${threadId}-1`, messages: [] });

  assertEquals(invalidateSelectorSignals(threadId), 1, "a selector lookup must cache exactly one signal");
});

Deno.test("selector signals: a thread's entries are dropped when it writes artifacts", async () => {
  const threadId = "sel-cache-1";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase(ARTIFACT_ROWS);

  const wrapped = wrapToolsWithCache(
    { socialfetch_username: makeTool(), record_artifacts: makeTool() },
    { investigationId: threadId, userId: "u-sel", supabase, supabaseAdmin: supabase },
  );

  // Populate: a selector lookup caches this thread's signal.
  const lookup = wrapped.socialfetch_username.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await lookup({ username: "aliceh", force: true }, { toolCallId: `${threadId}-1`, messages: [] });

  // Write artifacts. The cached signal is derived from that table, so it is now
  // stale and must be dropped.
  const record = wrapped.record_artifacts.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await record({ artifacts: [] }, { toolCallId: `${threadId}-2`, messages: [] });

  // Nothing left to drop — record_artifacts already did it. Paired with the
  // control above (which proves the entry existed), a 0 here means invalidated,
  // not never-cached.
  assertEquals(
    invalidateSelectorSignals(threadId),
    0,
    "record_artifacts must invalidate this thread's selector signals",
  );
});

Deno.test("selector signals: a NON-writing tool must not invalidate", async () => {
  // memory_save is ALWAYS_ALLOW but touches no artifacts — forcing a re-read
  // after it would be pure waste.
  const threadId = "sel-cache-nonwriter";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase(ARTIFACT_ROWS);
  const wrapped = wrapToolsWithCache(
    { socialfetch_username: makeTool(), memory_save: makeTool() },
    { investigationId: threadId, userId: "u-sel", supabase, supabaseAdmin: supabase },
  );
  const lookup = wrapped.socialfetch_username.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await lookup({ username: "aliceh", force: true }, { toolCallId: `${threadId}-1`, messages: [] });

  const save = wrapped.memory_save.execute as (i: unknown, o: unknown) => Promise<unknown>;
  await save({ note: "x" }, { toolCallId: `${threadId}-2`, messages: [] });

  assertEquals(invalidateSelectorSignals(threadId), 1, "memory_save writes no artifacts — the signal should survive");
});

Deno.test("selector signals: invalidation is scoped to ONE thread", () => {
  // A prefix sweep must not take neighbouring threads' entries with it —
  // `${threadId}:` is the guard against `sel-cache-2` matching `sel-cache-20`.
  const lru = new LRU<string>(500);
  lru.set("t1:username:alice", "a");
  lru.set("t1:email:alice@x.com", "b");
  lru.set("t10:username:bob", "c");   // shares the "t1" prefix, NOT the "t1:" one
  lru.set("t2:username:carol", "d");

  assertEquals(lru.deletePrefix("t1:"), 2, "only t1's two entries");
  assertEquals(lru.get("t1:username:alice"), undefined);
  assertEquals(lru.get("t10:username:bob"), "c", "t10 must survive a t1 sweep");
  assertEquals(lru.get("t2:username:carol"), "d");
});

Deno.test("selector signals: the cache is bounded, not unbounded", () => {
  // The old Map grew for the life of the isolate. The LRU evicts oldest-first.
  const lru = new LRU<number>(500);
  for (let i = 0; i < 1200; i++) lru.set(`t:sel:${i}`, i);
  assertEquals(lru.size, 500, "must cap at its configured max");
  assertEquals(lru.get("t:sel:0"), undefined, "oldest entries evicted");
  assertEquals(lru.get("t:sel:1199"), 1199, "newest retained");
});

Deno.test("selector signals: deletePrefix on an absent thread is a no-op", () => {
  const lru = new LRU<string>(10);
  lru.set("keep:a", "1");
  assertEquals(lru.deletePrefix("gone:"), 0);
  assertEquals(lru.get("keep:a"), "1");
  assert(lru.size === 1);
});
