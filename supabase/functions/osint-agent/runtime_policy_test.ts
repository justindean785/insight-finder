import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clearRuntime, startCall } from "./runtime-policy.ts";

const noWeakLead = { weak: false, reasons: [] as string[], autoPivotBlocked: false };

function baseInput(overrides: Partial<Parameters<typeof startCall>[0]> = {}) {
  return {
    threadId: "t-policy-test",
    toolName: "exa_search",
    selector: "alice@example.com",
    selectorType: "email",
    costTier: "expensive" as const,
    expectedValue: 37,
    familyKey: "exa_search::email::alice@example.com",
    weakLead: noWeakLead,
    staleCache: false,
    manualOverride: false,
    now: 1_000_000,
    ...overrides,
  };
}

// ── Regression: orchestration tools must bypass the expected-value gate ──────
// The planner (minimax_plan_pivots, "expensive" tier → threshold 70) scores far
// below 70 on a bare seed. If the EV gate blocks it, planRequired never clears,
// every pivot is blocked by "execution plan required", and the investigation
// deadlocks into a retry loop → FAILED. These tools are orchestration/bookkeeping,
// not external data-source spend, and carry their own rate limits.

Deno.test("minimax_plan_pivots bypasses the expected-value gate on a bare seed", () => {
  clearRuntime("t-policy-test");
  const decision = startCall(baseInput({
    toolName: "minimax_plan_pivots",
    expectedValue: 37, // below the expensive threshold of 70
    familyKey: "minimax_plan_pivots::email::alice@example.com",
  }));
  assertEquals(decision.allow, true);
});

Deno.test("running the planner clears planRequired so the next pivot can proceed", () => {
  clearRuntime("t-policy-test");
  // 1. Planner runs despite low EV → clears the plan-required latch.
  const plan = startCall(baseInput({
    toolName: "minimax_plan_pivots",
    expectedValue: 30,
    familyKey: "minimax_plan_pivots::email::alice@example.com",
  }));
  assertEquals(plan.allow, true);
  // 2. A high-value external pivot is now permitted (plan gate cleared).
  const pivot = startCall(baseInput({
    toolName: "exa_search",
    expectedValue: 85,
    familyKey: "exa_search::email::alice@example.com",
  }));
  assertEquals(pivot.allow, true);
});

Deno.test("memory_recall bypasses the expected-value gate (regression: '43 below 50')", () => {
  clearRuntime("t-policy-test");
  const decision = startCall(baseInput({
    toolName: "memory_recall",
    costTier: "low",
    expectedValue: 43, // the exact value seen failing in production
    familyKey: "memory_recall::value::alice@example.com",
  }));
  assertEquals(decision.allow, true);
});

Deno.test("external pivots are still EV-gated (the gate is not globally disabled)", () => {
  clearRuntime("t-policy-test");
  // Clear the plan latch first so we isolate the EV gate, not the plan gate.
  startCall(baseInput({
    toolName: "minimax_plan_pivots",
    expectedValue: 30,
    familyKey: "minimax_plan_pivots::email::alice@example.com",
  }));
  const decision = startCall(baseInput({
    toolName: "exa_search",
    costTier: "expensive",
    expectedValue: 37, // below 70 → must still be blocked for a real data source
    familyKey: "exa_search::email::alice@example.com",
  }));
  assertEquals(decision.allow, false);
  if (!decision.allow) {
    assertEquals(decision.reason, "expected value 37 below 70");
  }
});
