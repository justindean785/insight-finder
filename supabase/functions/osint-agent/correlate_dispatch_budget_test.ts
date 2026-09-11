// correlate_dispatch_budget_test.ts -- the LIVE-CALL ADMISSION half of the
// required-completion-budget fix (Codex P1 on #571's own review thread).
//
// THE DEFECT. The finalize-window live-call guard in cache.ts exempts
// minimax_correlate from the "finalize window open; live lookup skipped" skip
// (FINALIZE_WINDOW_LIVE_EXEMPT / isFinalizeWindowLiveLookupExempt) so the
// 73-100% correlate-orphan-rate regression (2026-09-01) doesn't recur. That
// exemption was UNCONDITIONAL: a model that calls minimax_correlate mid-step,
// not at a prepareStep boundary, was admitted at ANY elapsed time -- including
// right up against the platform's hard deadline -- with zero check on whether
// enough wall-clock remained for the call to actually finish. That is the same
// "no report" overrun orchestrator-finalize.ts's requiredCompletionMs() closes
// at the prepareStep-boundary deferral decision, reachable through this second,
// unrelated gate.
//
// THE FIX. The exemption is now CONDITIONAL on ctx.hasCorrelateDispatchBudget()
// -- wired by index.ts from the same requiredCompletionMs() used by the
// deferral predicate. These tests drive the REAL wrap path (wrapToolsWithCache),
// not a restated predicate, because the property under test -- "the live call
// is admitted or refused" -- only the wrapper can demonstrate.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { resetCorrelateRun } from "./guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

// No quarantine, no rejections, no reviews -- the only thing that can refuse
// the call in these tests is the finalize-window admission guard under test.
function fakeSupabase(): SupabaseClient {
  const empty = makeChain({ data: [], error: null });
  empty.insert = () => Promise.resolve({ error: null });
  empty.upsert = () => Promise.resolve({ error: null });
  return {
    from: () => empty,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve({ ok: true, correlated: true }); },
  } as unknown as Tool;
}

let threadSeq = 0;
function freshThread(): string {
  threadSeq += 1;
  return `33333333-4444-5555-8666-${String(threadSeq).padStart(12, "0")}`;
}

type ExecuteFn = (i: unknown, o: unknown) => Promise<Record<string, unknown>>;

function wrapCorrelate(
  calls: { n: number },
  opts: { shouldStopLiveLookups?: () => boolean; hasCorrelateDispatchBudget?: () => boolean },
): ExecuteFn {
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  // guard.ts's correlate-freshness state is a module-level singleton, not
  // scoped by investigationId -- reset it so an earlier test's successful
  // correlate call doesn't make THIS call look redundant before it ever
  // reaches the admission guard under test.
  resetCorrelateRun();
  const wrapped = wrapToolsWithCache({ minimax_correlate: countingTool(calls) }, {
    investigationId,
    userId: "u1",
    supabase: fakeSupabase(),
    ...opts,
  });
  return wrapped.minimax_correlate.execute as unknown as ExecuteFn;
}

function wrapOtherLiveTool(
  calls: { n: number },
  opts: { shouldStopLiveLookups?: () => boolean; hasCorrelateDispatchBudget?: () => boolean },
): ExecuteFn {
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const wrapped = wrapToolsWithCache({ jina_reader_scrape: countingTool(calls) }, {
    investigationId,
    userId: "u1",
    supabase: fakeSupabase(),
    ...opts,
  });
  return wrapped.jina_reader_scrape.execute as unknown as ExecuteFn;
}

const input = { domain: "example.test", purpose: "probe", force: true };
const runOpts = { toolCallId: "t1", messages: [] };

Deno.test("admission: budget confirmed -> the exempt call actually dispatches", async () => {
  const calls = { n: 0 };
  const execute = wrapCorrelate(calls, {
    shouldStopLiveLookups: () => true,
    hasCorrelateDispatchBudget: () => true,
  });
  const r = await execute(input, runOpts) as Record<string, unknown>;
  assertEquals(calls.n, 1, "the tool must actually run");
  assertEquals(r.ok, true);
  assertEquals(r.correlated, true);
});

Deno.test("admission: budget NOT confirmed -> the exempt call is refused, same as any other live lookup", async () => {
  const calls = { n: 0 };
  const execute = wrapCorrelate(calls, {
    shouldStopLiveLookups: () => true,
    hasCorrelateDispatchBudget: () => false,
  });
  const r = await execute(input, runOpts) as Record<string, unknown>;
  assertEquals(calls.n, 0, "the tool must NOT run -- this is the P1 this file closes");
  assertEquals(r.ok, false);
  assertEquals(r.skipped, true);
  assertEquals(r.finalizing, true);
  assert(String(r.error).includes("finalize window open"));
});

Deno.test("admission: budget callback not wired at all -> FAILS CLOSED, refused", () => {
  const calls = { n: 0 };
  const execute = wrapCorrelate(calls, { shouldStopLiveLookups: () => true });
  return execute(input, runOpts).then((r) => {
    const result = r as Record<string, unknown>;
    assertEquals(calls.n, 0, "an unwired budget check must not silently grant the exemption");
    assertEquals(result.ok, false);
    assertEquals(result.skipped, true);
  });
});

Deno.test("admission: finalize window not open at all -> dispatches regardless of the budget callback", async () => {
  const calls = { n: 0 };
  const execute = wrapCorrelate(calls, {
    shouldStopLiveLookups: () => false,
    hasCorrelateDispatchBudget: () => false,
  });
  const r = await execute(input, runOpts) as Record<string, unknown>;
  assertEquals(calls.n, 1, "the guard never activates when the window isn't open");
  assertEquals(r.ok, true);
});

Deno.test("admission: a NON-exempt live tool is refused in the window even when the budget callback says true", async () => {
  const calls = { n: 0 };
  const execute = wrapOtherLiveTool(calls, {
    shouldStopLiveLookups: () => true,
    hasCorrelateDispatchBudget: () => true,
  });
  const r = await execute(input, runOpts) as Record<string, unknown>;
  assertEquals(calls.n, 0, "hasCorrelateDispatchBudget must only exempt minimax_correlate, never other tools");
  assertEquals(r.ok, false);
  assertEquals(r.skipped, true);
});
