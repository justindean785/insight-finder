import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clearRuntime,
  runtimeLimits,
  startCall,
  MAX_TOTAL_CALLS,
  MAX_PAID_CALLS,
} from "./runtime-policy.ts";

const DEFAULT_LIMITS = { ...runtimeLimits };
function restoreLimits() {
  Object.assign(runtimeLimits, DEFAULT_LIMITS);
}

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

// ---- Configurable runtime limits (ENFORCED BY DEFAULT) -----------------------
// INVERTED 2026-07-27. This block previously asserted "paid cap is unlimited by
// default — many paid calls all allow:true", i.e. it pinned the defect as intended
// behavior and went green while production ran a 262-call, $3.05 investigation
// against a documented ceiling of 30 calls / 12 paid.
//
// The caps were off for TWO independent reasons: the enforcement block in startCall
// is gated on `stopOnBudgetExhausted` (defaulted false), and every check inside it
// is guarded by Number.isFinite() — which the Infinity defaults fail. MAX_TOTAL_CALLS
// and MAX_PAID_CALLS were exported constants that the enforcing code never read.

Deno.test("(1) run caps are ENFORCED by default — no env configuration required", () => {
  restoreLimits();
  clearRuntime("t-limits");
  // The defaults must equal the documented constants, not Infinity.
  assertEquals(runtimeLimits.maxTotalToolCallsPerRun, MAX_TOTAL_CALLS);
  assertEquals(runtimeLimits.maxPaidCallsPerRun, MAX_PAID_CALLS);
  assertEquals(runtimeLimits.stopOnBudgetExhausted, true);

  // A run that tries to burn 50 paid calls must be stopped at the paid ceiling.
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 50; i++) {
    const d = startCall(baseInput({
      threadId: "t-limits",
      toolName: `paid_${i}`,
      costTier: "expensive",
      familyKey: `paid_${i}::v`,
      now: i * 1000,
    }));
    if (d.allow) allowed++; else blocked++;
  }
  assertEquals(allowed, MAX_PAID_CALLS, "paid calls must stop at MAX_PAID_CALLS");
  assertEquals(blocked, 50 - MAX_PAID_CALLS, "the rest must be refused, not queued");
});

Deno.test("(1b) the documented total ceiling actually stops a runaway run", () => {
  restoreLimits();
  clearRuntime("t-total");
  // Free tools so the PAID cap is not what stops it — this pins the TOTAL ceiling.
  let allowed = 0;
  for (let i = 0; i < 120; i++) {
    const d = startCall(baseInput({
      threadId: "t-total",
      toolName: `free_${i}`,
      costTier: "free",
      familyKey: `free_${i}::v`,
      now: i * 1000,
    }));
    if (d.allow) allowed++;
  }
  assertEquals(allowed, MAX_TOTAL_CALLS, "a runaway run must stop at MAX_TOTAL_CALLS");
});

Deno.test("(2) cap enabled + paid exhausted, record_artifacts still allow:true (essential bypass)", () => {
  clearRuntime("t-limits");
  runtimeLimits.stopOnBudgetExhausted = true;
  runtimeLimits.maxPaidCallsPerRun = 2;
  try {
    for (let i = 0; i < 2; i++) {
      startCall(baseInput({ threadId: "t-limits", toolName: `p_${i}`, costTier: "expensive", familyKey: `p_${i}::v`, now: i * 1000 }));
    }
    const blocked = startCall(baseInput({ threadId: "t-limits", toolName: "p_over", costTier: "expensive", familyKey: "p_over::v", now: 9_000_000 }));
    assertEquals(blocked.allow, false);
    const rec = startCall(baseInput({ threadId: "t-limits", toolName: "record_artifacts", costTier: "free", familyKey: "record_artifacts::v", now: 9_000_001 }));
    assertEquals(rec.allow, true);
  } finally {
    restoreLimits();
  }
});

Deno.test("(3) cap enabled + total exhausted, record_report / record_finding still allow:true", () => {
  clearRuntime("t-limits");
  runtimeLimits.stopOnBudgetExhausted = true;
  runtimeLimits.maxTotalToolCallsPerRun = 3;
  try {
    for (let i = 0; i < 3; i++) {
      startCall(baseInput({ threadId: "t-limits", toolName: `x_${i}`, costTier: "expensive", familyKey: `x_${i}::v`, now: i * 1000 }));
    }
    assertEquals(startCall(baseInput({ threadId: "t-limits", toolName: "x_over", costTier: "expensive", familyKey: "x_over::v", now: 9_000_000 })).allow, false);
    assertEquals(startCall(baseInput({ threadId: "t-limits", toolName: "record_report", costTier: "free", familyKey: "record_report::v", now: 9_000_001 })).allow, true);
    assertEquals(startCall(baseInput({ threadId: "t-limits", toolName: "record_finding", costTier: "free", familyKey: "record_finding::v", now: 9_000_002 })).allow, true);
  } finally {
    restoreLimits();
  }
});

Deno.test("(4) over maxParallelTools → allow:true with waitMs>0 (queued, not failed)", () => {
  clearRuntime("t-limits");
  runtimeLimits.maxParallelTools = 2;
  try {
    startCall(baseInput({ threadId: "t-limits", toolName: "a", costTier: "free", familyKey: "a::v", now: 1000 }));
    startCall(baseInput({ threadId: "t-limits", toolName: "b", costTier: "free", familyKey: "b::v", now: 1000 }));
    const queued = startCall(baseInput({ threadId: "t-limits", toolName: "c", costTier: "free", familyKey: "c::v", now: 1000 }));
    assertEquals(queued.allow, true);
    if (queued.allow) assertEquals(queued.waitMs > 0, true);
  } finally {
    restoreLimits();
  }
});
