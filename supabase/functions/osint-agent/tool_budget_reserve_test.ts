// tool_budget_reserve_test.ts — unit coverage for the atomic tool-call budget
// reservation primitive. cache_budget_race_test.ts proves the primitive works
// through the real wrapper under concurrent dispatch; these tests pin the
// primitive's own boundary behavior (zero slots, one slot, exact cap, the
// ALWAYS_ALLOW exemption) without the wrapper's DB/circuit machinery.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import {
  MAX_TOOL_CALLS_PER_RUN,
  reserveToolCall,
  toolCapExceeded,
  type ToolCallBudget,
} from "./orchestrator-budget.ts";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function budgetAt(reserved: number): ToolCallBudget {
  return { genuine: reserved, reserved, capped: false };
}

Deno.test("reserve: zero remaining slots — every ordinary caller is rejected, count never moves", () => {
  const b = budgetAt(MAX_TOOL_CALLS_PER_RUN);
  const admitted = [1, 2, 3, 4].filter(() => reserveToolCall(b, false)).length;
  assertEquals(admitted, 0, "a fully exhausted budget admits nothing");
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN, "reserved must never move past the cap");
  assertEquals(b.capped, true, "a rejection must flip the capped flag for the finalize path");
});

Deno.test("reserve: exactly one remaining slot — first of many concurrent callers wins, rest are capped", () => {
  const b = budgetAt(MAX_TOOL_CALLS_PER_RUN - 1);
  // Interleaved synchronously: this is precisely the shape a Promise.all batch
  // collapses to once each call reaches the (await-free) gate.
  const outcomes = Array.from({ length: 6 }, () => reserveToolCall(b, false));
  assertEquals(outcomes.filter(Boolean).length, 1, "exactly one caller may take the last slot");
  assertEquals(outcomes[0], true, "the first arrival is the one admitted");
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN, "lands exactly on the cap, never past it");
});

Deno.test("reserve: exact-cap boundary — the call that lands ON the cap is admitted, the next is not", () => {
  const b = budgetAt(MAX_TOOL_CALLS_PER_RUN - 2);
  assertEquals(reserveToolCall(b, false), true, "cap-2 → admitted");
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN - 1);
  assertEquals(reserveToolCall(b, false), true, "cap-1 → admitted (fills the cap)");
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN);
  assertEquals(b.capped, false, "filling the cap is not itself a rejection");
  assertEquals(reserveToolCall(b, false), false, "at cap → rejected");
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN, "a rejection must not increment");
});

Deno.test("reserve: ALWAYS_ALLOW recording tools are admitted at and far past the cap, consuming no slot", () => {
  const b = budgetAt(MAX_TOOL_CALLS_PER_RUN);
  for (let i = 0; i < 10; i++) {
    assertEquals(reserveToolCall(b, true), true, "a recording tool is never capped");
  }
  assertEquals(b.reserved, MAX_TOOL_CALLS_PER_RUN, "recording tools must not consume budget");
  assertEquals(b.capped, false, "a recording tool must never flip the capped flag");
});

Deno.test("toolCapExceeded: one rule shared by the admission gate and the finalize trigger", () => {
  assertEquals(toolCapExceeded(MAX_TOOL_CALLS_PER_RUN, false), true);
  assertEquals(toolCapExceeded(MAX_TOOL_CALLS_PER_RUN - 1, false), false);
  assertEquals(toolCapExceeded(MAX_TOOL_CALLS_PER_RUN + 99, true), false, "recording tools exempt");
});

// ---- Wrapper-level: a capped call must not run the underlying tool body ------

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

Deno.test("reserve: a budget-rejected call NEVER invokes the wrapped tool body", async () => {
  const threadId = "budget-no-invoke";
  clearRuntime(threadId);
  let invocations = 0;
  const tool = {
    description: "test tool",
    execute: async () => {
      invocations++;
      await Promise.resolve();
      return { ok: true };
    },
  } as unknown as Tool;

  const toolCallBudget: ToolCallBudget = {
    genuine: MAX_TOOL_CALLS_PER_RUN,
    reserved: MAX_TOOL_CALLS_PER_RUN,
    capped: false,
  };
  const supabase = fakeSupabase();
  const wrapped = wrapToolsWithCache({ dns_records: tool }, {
    investigationId: threadId,
    userId: "u-no-invoke",
    supabase,
    supabaseAdmin: supabase,
    toolCallBudget,
  });
  const execute = wrapped.dns_records.execute as (i: unknown, o: unknown) => Promise<unknown>;
  const out = await execute(
    { domain: "capped.example", force: true },
    { toolCallId: `${threadId}-1`, messages: [] },
  ) as { run_capped?: boolean; skipped?: boolean };

  assertEquals(out.run_capped, true, "an exhausted budget must return the capped result shape");
  assertEquals(out.skipped, true, "capped calls stay schema-safe skips, preserving telemetry shape");
  assertEquals(invocations, 0, "the underlying tool body must never execute for a capped call");
  assertEquals(toolCallBudget.reserved, MAX_TOOL_CALLS_PER_RUN, "a rejected call must not consume a slot");
  clearRuntime(threadId);
});
