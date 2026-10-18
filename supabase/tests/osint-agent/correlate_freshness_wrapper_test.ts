// correlate_freshness_wrapper_test.ts — the correlation freshness gate driven
// through the REAL wrap path (wrapToolsWithCache), not the predicate in isolation.
// Mirrors quarantine_dispatch_test.ts's harness: the property that matters is
// "a redundant re-run never reaches the tool and never spends budget", and only
// the wrapper can demonstrate that.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { guard, MIN_NEW_ARTIFACTS_FOR_RECORRELATE, resetCorrelateRun } from "../../functions/osint-agent/guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.range = () => ({ then: (r: (x: unknown) => void) => r(resolveValue) });
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  node.insert = () => Promise.resolve({ error: null });
  node.upsert = () => Promise.resolve({ error: null });
  return node;
}

function fakeSupabase(): SupabaseClient {
  const inert = makeChain({ data: [], error: null });
  return {
    from: (_t: string) => inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => {
      calls.n += 1;
      return Promise.resolve({ ok: true, analysis: { clusters: [] } });
    },
  } as unknown as Tool;
}

let threadSeq = 0;
function freshThread(): string {
  threadSeq += 1;
  return `22222222-3333-4444-8888-${String(threadSeq).padStart(12, "0")}`;
}

function wrap(calls: { n: number }, extra?: { toolCallBudget?: { genuine: number; reserved: number; capped: boolean } }) {
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache({ minimax_correlate: countingTool(calls) }, {
    investigationId,
    userId: "u1",
    supabase: fakeSupabase(),
    ...(extra ?? {}),
  });
}

/**
 * Start each case from a clean request, via the SHIPPED reset.
 *
 * This used to hand-roll `artifactsSinceCorrelate = 0; lastCorrelateOutcome =
 * null`, which was a second copy of `resetCorrelateRun`'s body. When the
 * per-run correlate budget was added to `guard`, the copy did not clear it and
 * these cases silently starved each other — the third live dispatch in the file
 * was refused as over-budget and the failure read as a freshness-gate bug.
 * Call the real thing so a future field added to the run reset cannot drift
 * away from the tests that depend on it.
 */
function resetGuardState() {
  resetCorrelateRun();
}

const CORRELATE_INPUT = { seed: "example.com", artifacts: [{ kind: "domain", value: "example.com" }] };

Deno.test("the run's FIRST correlate call reaches the tool (no prior outcome to gate on)", async () => {
  resetGuardState();
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.minimax_correlate as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute(CORRELATE_INPUT, {}) as Record<string, unknown>;
  assertEquals(calls.n, 1, "the tool body must run on the first call");
  assertEquals(out.correlate_not_fresh, undefined);
});

Deno.test("a re-run after a successful correlate with too little new evidence never reaches the tool", async () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = 0;
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.minimax_correlate as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute(CORRELATE_INPUT, {}) as Record<string, unknown>;
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals(out.ok, false);
  assertEquals(out.correlate_not_fresh, true);
  assert(typeof out.error === "string" && (out.error as string).includes("redundant correlate"));
});

Deno.test("a gated re-run spends NO tool-call budget", async () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = 1;
  const calls = { n: 0 };
  const budget = { genuine: 0, reserved: 0, capped: false };
  const tools = wrap(calls, { toolCallBudget: budget });
  await (tools.minimax_correlate as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute(CORRELATE_INPUT, {});
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals(budget.reserved, 0, "a gated call must not reserve a tool-call slot");
  assertEquals(budget.genuine, 0, "a gated call must not count as a genuine live execution");
});

Deno.test("a retry after a FAILED correlate reaches the tool even with zero new evidence", async () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "failed";
  guard.artifactsSinceCorrelate = 0;
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.minimax_correlate as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute(CORRELATE_INPUT, {}) as Record<string, unknown>;
  assertEquals(calls.n, 1, "a failed pass delivered nothing — its retry must not be gated");
  assertEquals(out.correlate_not_fresh, undefined);
});

Deno.test("once enough new evidence has accrued since a success, the next call reaches the tool", async () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE;
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.minimax_correlate as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute(CORRELATE_INPUT, {}) as Record<string, unknown>;
  assertEquals(calls.n, 1);
  assertEquals(out.correlate_not_fresh, undefined);
});
