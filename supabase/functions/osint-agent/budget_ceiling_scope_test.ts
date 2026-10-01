// budget_ceiling_scope_test.ts — `budget_exhausted` belongs to the INVOCATION
// that observed the refusal (Codex P2 on #611).
//
// Overlapping invocations share one thread's runtime state, and index.ts calls
// clearRuntime(threadId) at the start of every request. A thread-keyed "ceiling
// fired" flag could therefore be erased by a newer invocation, or leak one
// invocation's refusal into its sibling's telemetry row. The flag now lives in
// request-owned state (index.ts `budgetCeiling`), set by the cache wrapper from
// startCall's decision. These tests drive the real wrapToolsWithCache path.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime, runtimeLimits } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };

const DEFAULT_LIMITS = { ...runtimeLimits };

function chain(v: { data: unknown; error: unknown }): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range", "gte", "lte", "neq", "is"]) n[m] = () => n;
  n.maybeSingle = () => Promise.resolve(v);
  n.single = () => Promise.resolve(v);
  n.then = (r: (x: { data: unknown; error: unknown }) => void) => r(v);
  n.insert = () => Promise.resolve({ error: null });
  n.upsert = () => Promise.resolve({ error: null });
  return n;
}

function db(): SupabaseClient {
  const inert = chain({ data: [], error: null });
  return {
    from: () => inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

// A PAID tool (costs.ts) so the paid-call cap governs it.
const TOOL = "urlscanner_scan";

function invocation(threadId: string, calls: { n: number }) {
  const budgetCeiling = { fired: false };
  const stub = {
    description: "paid stand-in",
    execute: () => { calls.n += 1; return Promise.resolve({ ok: true, data: { verdict: "clean" } }); },
  } as unknown as Tool;
  const tools = wrapToolsWithCache({ [TOOL]: stub }, {
    investigationId: threadId,
    userId: "u-ceiling",
    supabase: db(),
    budgetCeiling,
  });
  const exec = (tools[TOOL] as unknown as Exec).execute;
  return { budgetCeiling, run: (url: string, id: string) => exec({ url }, { toolCallId: id, messages: [] }) };
}

Deno.test("overlap: the refusal is attributed to the invocation that hit it, not its sibling", async () => {
  const threadId = "budget-ceiling-overlap-thread";
  clearRuntime(threadId);
  circuit.clearThread(threadId);
  try {
    runtimeLimits.stopOnBudgetExhausted = true;
    runtimeLimits.maxPaidCallsPerRun = 1;
    const calls = { n: 0 };
    const a = invocation(threadId, calls);
    const b = invocation(threadId, calls);

    await a.run("https://one.example.test/", "a1");
    assertEquals(calls.n, 1, "the first paid call is admitted");
    assertEquals(a.budgetCeiling.fired, false, "an admitted call is not a ceiling");

    const refused = await b.run("https://two.example.test/", "b1");
    assertEquals(calls.n, 1, "the paid cap refused the second call before it ran");
    assert(refused.ok === false || refused.skipped === true, JSON.stringify(refused));
    assertEquals(b.budgetCeiling.fired, true, "B observed the refusal, so B's row says budget_exhausted");
    assertEquals(a.budgetCeiling.fired, false, "A's row must NOT inherit B's refusal");

    // A newer request starting on the same thread clears runtime state; it must
    // not erase what B already observed.
    clearRuntime(threadId);
    assertEquals(b.budgetCeiling.fired, true, "clearRuntime cannot reach request-owned state");
  } finally {
    Object.assign(runtimeLimits, DEFAULT_LIMITS);
    clearRuntime(threadId);
    circuit.clearThread(threadId);
  }
});

Deno.test("with the budget caps off, nothing can set the latch", async () => {
  const threadId = "budget-ceiling-clean-thread";
  clearRuntime(threadId);
  circuit.clearThread(threadId);
  try {
    runtimeLimits.stopOnBudgetExhausted = false; // caps off: nothing can be a ceiling
    const calls = { n: 0 };
    const a = invocation(threadId, calls);
    await a.run("https://three.example.test/", "c1");
    await a.run("https://four.example.test/", "c2");
    assertEquals(a.budgetCeiling.fired, false);
  } finally {
    Object.assign(runtimeLimits, DEFAULT_LIMITS);
    clearRuntime(threadId);
    circuit.clearThread(threadId);
  }
});

Deno.test("wiring: index.ts owns the latch per request and both telemetry rows read it", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("const budgetCeiling = { fired: false };"), "a per-request latch");
  assert(/toolCallBudget,\s*budgetCeiling,/.test(src), "passed to wrapToolsWithCache");
  assertEquals(src.split("budgetExhausted: budgetCeiling.fired,").length - 1, 2, "both finish() call sites");
  assert(!src.includes("budgetCeilingFired("), "no thread-keyed read remains");
});
