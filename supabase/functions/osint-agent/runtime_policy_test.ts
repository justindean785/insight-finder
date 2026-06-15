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

// Runtime policy is fail-open for investigative choice. Expected value,
// planning, and weak-lead analysis are advisory metadata, not hard blockers.

Deno.test("minimax_plan_pivots bypasses the expected-value gate on a bare seed", () => {
  clearRuntime("t-policy-test");
  const decision = startCall(baseInput({
    toolName: "minimax_plan_pivots",
    expectedValue: 37, // below the expensive threshold of 70
    familyKey: "minimax_plan_pivots::email::alice@example.com",
  }));
  assertEquals(decision.allow, true);
});

Deno.test("external pivots do not require a planner call", () => {
  clearRuntime("t-policy-test");
  const pivot = startCall(baseInput({
    toolName: "exa_search",
    expectedValue: 20,
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

Deno.test("low expected value does not block an external pivot", () => {
  clearRuntime("t-policy-test");
  const decision = startCall(baseInput({
    toolName: "exa_search",
    costTier: "expensive",
    expectedValue: 0,
    familyKey: "exa_search::email::alice@example.com",
  }));
  assertEquals(decision.allow, true);
});

Deno.test("weak-lead analysis does not hard-block a pivot", () => {
  clearRuntime("t-policy-test");
  const decision = startCall(baseInput({
    toolName: "exa_search",
    weakLead: {
      weak: true,
      reasons: ["single-source lead"],
      autoPivotBlocked: true,
    },
  }));
  assertEquals(decision.allow, true);
});
