// cache_selector_reuse_test.ts
//
// Cross-turn cache reuse (Fix 1): the durable tool_call_cache lookup keyed on
// input_hash folds in the planner's per-call `purpose`, so the SAME selector
// re-queried in a later turn of the SAME thread missed (0/18 live reuse). The fix
// adds a thread-scoped fallback keyed on the normalized selector + a params_hash
// computed WITHOUT pure annotation keys, so `purpose` no longer defeats reuse while
// result-shaping params (kind/depth/limit/…) still distinguish a different mode.
//
// This exercises the hashing mechanism that makes cross-turn reuse possible — the
// same selector + a different `purpose` must collapse to an IDENTICAL params set
// (→ identical params_hash → the fallback lookup matches on a later turn). The full
// DB-lookup replay is proven live post-deploy via tool_usage_log (cached=true /
// runtime.selector_reuse) — see the PR summary.
import { assertEquals } from "jsr:@std/assert@^1";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { isCacheableToolResult, semanticParams, wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function fakeSupabase(onUpsert: () => void): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.eq = chain;
  q.in = chain;
  q.order = chain;
  q.update = chain;
  q.limit = chain;
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = () => Promise.resolve({ error: null });
  q.upsert = () => {
    onUpsert();
    return Promise.resolve({ error: null });
  };
  return {
    from: () => q,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function makeTool(execute: (input: unknown, opts: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

Deno.test("semanticParams: drops pure annotation keys but keeps result-shaping params", () => {
  // purpose/reason/rationale/note/notes are planner annotations — never affect the result.
  assertEquals(semanticParams({ purpose: "find associates", limit: 5 }), { limit: 5 });
  assertEquals(semanticParams({ reason: "x", rationale: "y", note: "z", notes: "w", depth: 2 }), { depth: 2 });
  // A result-shaping param (kind) is preserved so a different mode is NEVER served a
  // wrong-mode cache hit.
  assertEquals(semanticParams({ kind: "videos" }), { kind: "videos" });
  assertEquals(semanticParams({}), {});
});

Deno.test("semanticParams: same selector, different purpose → identical params set (enables the cross-turn hit)", () => {
  const turn1 = semanticParams({ purpose: "initial sweep", country: "US" });
  const turn3 = semanticParams({ purpose: "verify identity", country: "US" });
  assertEquals(turn1, turn3, "a differing `purpose` must not change the reuse hash");
});

Deno.test("semanticParams: a genuinely different semantic param stays distinct (no false reuse)", () => {
  const a = semanticParams({ purpose: "verify", country: "US" });
  const b = semanticParams({ purpose: "verify", country: "GB" });
  assertEquals(a.country !== b.country, true, "result-shaping params still differentiate");
});

Deno.test("cache eligibility: provider skips are retryable, not successful cache entries", () => {
  assertEquals(isCacheableToolResult({ ok: false, skipped: true, provider_unavailable: true }), false);
  assertEquals(isCacheableToolResult({ error: "API_KEY not configured" }), false);
  assertEquals(isCacheableToolResult({ ok: false, status: 500 }), false);
  assertEquals(isCacheableToolResult({ ok: true, answer: "usable result" }), true);
});

Deno.test("cache wrapper: a skipped provider result executes live again instead of poisoning the LRU/DB cache", async () => {
  const threadId = "test-thread-skip-cache-poison";
  clearRuntime(threadId);
  let executions = 0;
  let cacheUpserts = 0;
  const supabase = fakeSupabase(() => cacheUpserts++);
  const wrapped = wrapToolsWithCache({
    dns_records: makeTool(async () => {
      executions++;
      return { ok: false, skipped: true, provider_unavailable: true, records: [] };
    }),
  }, {
    investigationId: threadId,
    userId: "u-skip-cache",
    supabase,
    supabaseAdmin: supabase,
  });
  const execute = wrapped.dns_records.execute as (input: unknown, opts: unknown) => Promise<unknown>;
  const input = { domain: "cache-poison.example", purpose: "retry provider", force: true };

  await execute(input, { toolCallId: "skip-1", messages: [] });
  clearRuntime(threadId);
  await execute(input, { toolCallId: "skip-2", messages: [] });

  assertEquals(executions, 2, "the second call must retry the provider instead of replaying a skip");
  assertEquals(cacheUpserts, 0, "retryable skips must never be persisted to tool_call_cache");
  clearRuntime(threadId);
});
