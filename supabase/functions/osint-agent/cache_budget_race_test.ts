// cache_budget_race_test.ts — the tool-call budget MUST be reserved atomically
// (synchronously, no await between check and increment) so a batch of tool
// calls dispatched in parallel by one model step cannot collectively overshoot
// MAX_TOOL_CALLS_PER_RUN.
//
// WHY: the old gate checked `ctx.toolCallBudget.genuine` and only incremented
// it AFTER the live call fully completed — separated by several awaits
// (circuit.shouldRun, startCall's rate-limit `waitMs` backoff). Under
// Promise.all-dispatched parallel tool calls (which this codebase explicitly
// supports — ORCHESTRATOR_PARALLEL_TOOL_CALLS), every call in the batch could
// read the same pre-increment `.genuine` value before any of them incremented
// it, letting the run overshoot the cap. The fix adds `.reserved`, incremented
// synchronously at the SAME point as the check — atomic relative to JS's
// single-threaded event loop even though the surrounding function is async.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// Chainable AND thenable — every filter method returns itself so chains of
// arbitrary length (.select().eq().eq()) work, and awaiting at any point
// resolves to `resolveValue` (matching supabase-js's own awaitable builders).
function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue);
  return node;
}

function fakeSupabase(): SupabaseClient {
  const chain = makeChain({ data: [], error: null });
  chain.insert = () => Promise.resolve({ error: null });
  chain.upsert = () => Promise.resolve({ error: null });
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

function makeTool(): Tool {
  // A tiny real async gap (microtask) between dispatch and completion — this
  // is where the OLD code's race window lived. The fix must hold regardless.
  return { description: "test tool", execute: async () => { await Promise.resolve(); return { ok: true }; } } as unknown as Tool;
}

Deno.test("budget race: N concurrent calls at the cap boundary — exactly the remaining slots are admitted, never more", async () => {
  const threadId = "budget-race-1";
  clearRuntime(threadId);
  const supabase = fakeSupabase();
  // Pre-seed so exactly 2 slots remain under the real MAX_TOOL_CALLS_PER_RUN.
  const remaining = 2;
  const toolCallBudget = { genuine: MAX_TOOL_CALLS_PER_RUN - remaining, reserved: MAX_TOOL_CALLS_PER_RUN - remaining, capped: false };
  const wrapped = wrapToolsWithCache({ dns_records: makeTool() }, {
    investigationId: threadId,
    userId: "u-budget-race",
    supabase,
    supabaseAdmin: supabase,
    toolCallBudget,
  });
  const execute = wrapped.dns_records.execute as (input: unknown, opts: unknown) => Promise<unknown>;

  // Dispatch 5 concurrent calls — more than the 2 remaining slots — exactly as
  // a model step requesting several parallel tool calls would. DISTINCT input
  // per call (unique domain) so none can be served from the in-memory cache —
  // an identical-input duplicate legitimately bypasses the budget gate (it's
  // a dedup, not a genuine live call), which would confound this test.
  const N = 5;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      execute({ domain: `race-${i}.example`, force: true }, { toolCallId: `${threadId}-${i}`, messages: [] })),
  );

  const admitted = results.filter((r) => !(r as { run_capped?: boolean }).run_capped).length;
  const capped = results.filter((r) => (r as { run_capped?: boolean }).run_capped === true).length;

  assertEquals(admitted, remaining, `exactly ${remaining} calls should be admitted, not ${admitted}`);
  assertEquals(capped, N - remaining, `the rest must be capped, not silently overshoot`);
  assertEquals(toolCallBudget.reserved, MAX_TOOL_CALLS_PER_RUN, "reserved count must land exactly at the cap, never past it");
});

Deno.test("budget race: recording tools (ALWAYS_ALLOW) are never capped even at/past the boundary", async () => {
  const threadId = "budget-race-2";
  clearRuntime(threadId);
  const supabase = fakeSupabase();
  const toolCallBudget = { genuine: MAX_TOOL_CALLS_PER_RUN, reserved: MAX_TOOL_CALLS_PER_RUN, capped: true };
  const wrapped = wrapToolsWithCache({ record_artifacts: makeTool() }, {
    investigationId: threadId,
    userId: "u-budget-race-2",
    supabase,
    supabaseAdmin: supabase,
    toolCallBudget,
  });
  const execute = wrapped.record_artifacts.execute as (input: unknown, opts: unknown) => Promise<unknown>;
  const out = await execute({ artifacts: [] }, { toolCallId: `${threadId}-1`, messages: [] }) as { run_capped?: boolean };
  assertEquals(out.run_capped, undefined, "a recording tool must never be rejected by the run cap, even fully exhausted");
});
