import { beforeEach, describe, expect, it } from "vitest";
import {
  analyzeWeakLead,
  beginCycle,
  clearRuntime,
  completePlan,
  currentStage,
  noteRejectedCall,
  requiredThreshold,
  scoreExpectedValue,
  startCall,
  finishCall,
  MAX_CONCURRENT_CALLS,
  MAX_TOTAL_CALLS,
  MAX_PAID_CALLS_PER_CYCLE,
  MAX_SAME_TOOL_CALLS_PER_CYCLE,
  MIN_START_GAP_MS,
} from "../../supabase/functions/osint-agent/runtime-policy.ts";

const THREAD = "runtime-policy-test";

beforeEach(() => {
  clearRuntime(THREAD);
});

describe("runtime-policy", () => {
  it("allows bounded execution without a planner object", () => {
    beginCycle(THREAD);
    const decision = startCall({
      threadId: THREAD,
      toolName: "breach_check",
      selector: "foo@example.com",
      selectorType: "email",
      costTier: "expensive",
      expectedValue: 90,
      familyKey: "breach_check::email::foo@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
    });
    expect(decision.allow).toBe(true);
    finishCall(THREAD, "breach_check");
  });

  it("allows execution after the planner completes", () => {
    beginCycle(THREAD);
    completePlan(THREAD);
    const decision = startCall({
      threadId: THREAD,
      toolName: "minimax_web_search",
      selector: "foo@example.com",
      selectorType: "email",
      costTier: "low",
      expectedValue: 72,
      familyKey: "minimax_web_search::email::foo@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
    });
    expect(decision.allow).toBe(true);
    finishCall(THREAD, "minimax_web_search");
  });

  it("allows targeted weak-lead verification while preserving the weak label", () => {
    const weakLead = analyzeWeakLead({
      selector: "richbrat444",
      selectorType: "username",
      confidence: 40,
      sourceCount: 1,
      sourceNames: ["username_sweep"],
      artifactKinds: ["username"],
      statuses: ["needs_review"],
      relatedProfile: false,
      aiSummaryOnly: false,
      usernameCollision: true,
      noHit: false,
      emptyProfile: false,
      sameNameWithoutOverlap: false,
      displayNameOnly: false,
    });
    beginCycle(THREAD);
    completePlan(THREAD);
    expect(weakLead.weak).toBe(true);
    expect(weakLead.reasons).toContain("username collision");
    const decision = startCall({
      threadId: THREAD,
      toolName: "socialfetch_lookup",
      selector: "richbrat444",
      selectorType: "username",
      costTier: "low",
      expectedValue: 68,
      familyKey: "socialfetch_lookup::username::richbrat444",
      weakLead,
      staleCache: false,
    });
    expect(decision.allow).toBe(true);
    finishCall(THREAD, "socialfetch_lookup");
  });

  it("enforces per-cycle same-tool and paid-call limits", () => {
    beginCycle(THREAD);
    completePlan(THREAD);

    // Up to MAX_PAID_CALLS_PER_CYCLE distinct paid tools are allowed; one beyond
    // is blocked. (Each finishes immediately so concurrency never gates here.)
    for (let i = 0; i < MAX_PAID_CALLS_PER_CYCLE; i++) {
      expect(startCall({
        threadId: THREAD,
        toolName: `paid_tool_${i}`,
        selector: "foo@example.com",
        selectorType: "email",
        costTier: "expensive",
        expectedValue: 90,
        familyKey: `paid_tool_${i}::email::foo@example.com`,
        weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
        staleCache: false,
        now: 1_000 + i * MIN_START_GAP_MS,
      }).allow).toBe(true);
      finishCall(THREAD, `paid_tool_${i}`);
    }

    const overPaid = startCall({
      threadId: THREAD,
      toolName: "paid_tool_over",
      selector: "foo@example.com",
      selectorType: "email",
      costTier: "expensive",
      expectedValue: 90,
      familyKey: "paid_tool_over::email::foo@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000 + (MAX_PAID_CALLS_PER_CYCLE + 1) * MIN_START_GAP_MS,
    });
    expect(overPaid.allow).toBe(false);
  });

  it("enforces the per-cycle same-tool cap", () => {
    beginCycle(THREAD);
    completePlan(THREAD);

    // The same tool may run up to MAX_SAME_TOOL_CALLS_PER_CYCLE times per cycle
    // (free tier so the paid cap never interferes); one beyond is blocked.
    for (let i = 0; i < MAX_SAME_TOOL_CALLS_PER_CYCLE; i++) {
      expect(startCall({
        threadId: THREAD,
        toolName: "google_dorks",
        selector: `selector-${i}@example.com`,
        selectorType: "email",
        costTier: "free",
        expectedValue: 90,
        familyKey: `google_dorks::email::selector-${i}@example.com`,
        weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
        staleCache: false,
        now: 1_000 + i * MIN_START_GAP_MS,
      }).allow).toBe(true);
      finishCall(THREAD, "google_dorks");
    }

    const overSameTool = startCall({
      threadId: THREAD,
      toolName: "google_dorks",
      selector: "selector-over@example.com",
      selectorType: "email",
      costTier: "free",
      expectedValue: 90,
      familyKey: "google_dorks::email::selector-over@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000 + (MAX_SAME_TOOL_CALLS_PER_CYCLE + 1) * MIN_START_GAP_MS,
    });
    expect(overSameTool.allow).toBe(false);
  });

  it("tracks active concurrency separately from completed calls", () => {
    beginCycle(THREAD);
    completePlan(THREAD);
    const first = startCall({
      threadId: THREAD,
      toolName: "google_dorks",
      selector: "one@example.com",
      selectorType: "email",
      costTier: "free",
      expectedValue: 80,
      familyKey: "google_dorks::email::one@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000,
    });
    expect(first.allow).toBe(true);
    finishCall(THREAD, "google_dorks");

    const second = startCall({
      threadId: THREAD,
      toolName: "dork_harvest",
      selector: "two@example.com",
      selectorType: "email",
      costTier: "free",
      expectedValue: 80,
      familyKey: "dork_harvest::email::two@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 2_000,
    });
    expect(second.allow).toBe(true);
  });

  it("blocks a fourth active call and releases capacity after finish", () => {
    beginCycle(THREAD);
    completePlan(THREAD);
    for (let index = 0; index < MAX_CONCURRENT_CALLS; index++) {
      expect(startCall({
        threadId: THREAD,
        toolName: `free_tool_${index}`,
        selector: `selector-${index}`,
        selectorType: "value",
        costTier: "free",
        expectedValue: 90,
        familyKey: `free_tool_${index}::selector-${index}`,
        weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
        staleCache: false,
        now: 1_000,
      }).allow).toBe(true);
    }
    expect(startCall({
      threadId: THREAD,
      toolName: "fourth_tool",
      selector: "selector-four",
      selectorType: "value",
      costTier: "free",
      expectedValue: 90,
      familyKey: "fourth_tool::selector-four",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000,
    }).allow).toBe(false);

    finishCall(THREAD, "free_tool_0");
    expect(startCall({
      threadId: THREAD,
      toolName: "replacement_tool",
      selector: "replacement",
      selectorType: "value",
      costTier: "free",
      expectedValue: 90,
      familyKey: "replacement_tool::replacement",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 4_000,
    }).allow).toBe(true);
  });

  it("enforces the total call budget even when force is requested", () => {
    beginCycle(THREAD);
    completePlan(THREAD);
    for (let index = 0; index < MAX_TOTAL_CALLS; index++) {
      const decision = startCall({
        threadId: THREAD,
        toolName: `budget_tool_${index}`,
        selector: `selector-${index}`,
        selectorType: "value",
        costTier: "free",
        expectedValue: 90,
        familyKey: `budget_tool_${index}::selector-${index}`,
        weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
        staleCache: false,
        force: true,
        now: 1_000 + index * MIN_START_GAP_MS,
      });
      expect(decision.allow).toBe(true);
      finishCall(THREAD, `budget_tool_${index}`);
    }
    const exhausted = startCall({
      threadId: THREAD,
      toolName: "budget_tool_overflow",
      selector: "overflow",
      selectorType: "value",
      costTier: "free",
      expectedValue: 100,
      familyKey: "budget_tool_overflow::overflow",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      force: true,
      now: 100_000,
    });
    expect(exhausted.allow).toBe(false);
    if ("reason" in exhausted) expect(exhausted.reason).toMatch(/budget exhausted/i);
  });

  it("queues provider starts to preserve the minimum pacing gap", () => {
    beginCycle(THREAD);
    completePlan(THREAD);
    const first = startCall({
      threadId: THREAD,
      toolName: "google_dorks",
      selector: "one",
      selectorType: "username",
      costTier: "free",
      expectedValue: 80,
      familyKey: "google_dorks::username::one",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000,
    });
    const second = startCall({
      threadId: THREAD,
      toolName: "dork_harvest",
      selector: "two",
      selectorType: "username",
      costTier: "free",
      expectedValue: 80,
      familyKey: "dork_harvest::username::two",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
      now: 1_000,
    });
    expect(first.allow && first.waitMs).toBe(0);
    expect(second.allow && second.waitMs).toBe(MIN_START_GAP_MS);
  });

  it("scores expected value and thresholds predictably", () => {
    expect(scoreExpectedValue({
      selectorConfidence: 70,
      sourceIndependenceBonus: 18,
      corroborationPotential: 12,
      costPenalty: 20,
      duplicatePenalty: 10,
      weakLeadPenalty: 15,
    })).toBe(55);
    expect(requiredThreshold("free")).toBe(35);
    expect(requiredThreshold("low")).toBe(50);
    expect(requiredThreshold("expensive")).toBe(70);
    expect(requiredThreshold("low", true)).toBe(80);
  });

  it("keeps track of stage progression and rejected calls", () => {
    beginCycle(THREAD, "test");
    completePlan(THREAD);
    expect(currentStage(THREAD)).toBe("TRIAGE");
    const decision = startCall({
      threadId: THREAD,
      toolName: "triage_seed",
      selector: "foo@example.com",
      selectorType: "email",
      costTier: "free",
      expectedValue: 85,
      familyKey: "triage_seed::email::foo@example.com",
      weakLead: { weak: false, reasons: [], autoPivotBlocked: false },
      staleCache: false,
    });
    expect(decision.allow).toBe(true);
    finishCall(THREAD, "triage_seed");
    expect(currentStage(THREAD)).toBe("REVIEW");

    expect(() => noteRejectedCall(THREAD, {
      tool_name: "socialfetch_lookup",
      selector: "foo",
      selector_type: "username",
      expected_value: 12,
      reason: "weak lead blocked",
      cost_tier: "low",
      weak_lead: true,
      stale_cache: false,
      manual_override: false,
    })).not.toThrow();
  });
});
