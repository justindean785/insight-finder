import { beforeEach, describe, expect, it } from "vitest";
import {
  analyzeWeakLead,
  beginCycle,
  clearRuntime,
  currentStage,
  finishCall,
  noteRejectedCall,
  scoreExpectedValue,
  startCall,
  MAX_CONCURRENT_CALLS,
  MAX_PAID_CALLS,
  MAX_SAME_TOOL_CALLS,
  MAX_TOTAL_CALLS,
  MIN_START_GAP_MS,
  type RuntimeDecisionInput,
} from "../../supabase/functions/osint-agent/runtime-policy.ts";
import { SYSTEM_PROMPT } from "../../supabase/functions/osint-agent/system-prompt.ts";

const THREAD = "runtime-policy-test";
const noWeakLead = { weak: false, reasons: [], autoPivotBlocked: false };

function base(overrides: Partial<RuntimeDecisionInput> = {}): RuntimeDecisionInput {
  return {
    threadId: THREAD,
    toolName: "minimax_web_search",
    selector: "foo@example.com",
    selectorType: "email",
    costTier: "low",
    expectedValue: 70,
    familyKey: "minimax_web_search::email::foo@example.com",
    weakLead: noWeakLead,
    staleCache: false,
    ...overrides,
  };
}

beforeEach(() => {
  clearRuntime(THREAD);
});

// ---- Fail-open execution: the agent always gets to run the best tool ----------
describe("runtime-policy: fail-open execution", () => {
  it("runs a tool with no planner cycle (no execution-plan deadlock)", () => {
    // No beginCycle() / plan object — must still fall back to executing.
    const decision = startCall(base({ toolName: "breach_check", costTier: "expensive" }));
    expect(decision.allow).toBe(true);
  });

  it("treats low expected value as advisory, never a block", () => {
    const decision = startCall(base({
      toolName: "leakcheck_lookup",
      costTier: "expensive",
      expectedValue: 1,
      familyKey: "leakcheck_lookup::email::foo@example.com",
    }));
    expect(decision.allow).toBe(true);
  });

  it("still executes a weak lead (labeled, not auto-rejected)", () => {
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
    expect(weakLead.weak).toBe(true); // it IS classified weak (for labeling)
    const decision = startCall(base({
      toolName: "socialfetch_lookup",
      selector: "richbrat444",
      selectorType: "username",
      familyKey: "socialfetch_lookup::username::richbrat444",
      weakLead, // weak + autoPivotBlocked, yet still allowed
    }));
    expect(decision.allow).toBe(true);
  });

  it("never blocks a scan on confirmation/source/EV signals (weakest lead still runs)", () => {
    const fullyWeak = analyzeWeakLead({
      selector: "domrovai",
      selectorType: "username",
      confidence: 20,
      sourceCount: 1,
      sourceNames: ["github_code_search"],
      artifactKinds: ["weak_lead"],
      statuses: ["new"],
      relatedProfile: false,
      aiSummaryOnly: true,
      usernameCollision: true,
      noHit: true,
      emptyProfile: true,
      sameNameWithoutOverlap: true,
      displayNameOnly: true,
    });
    expect(fullyWeak.weak).toBe(true);
    expect(fullyWeak.autoPivotBlocked).toBe(true);
    // Weakest possible lead (every weak signal set) + lowest EV + stale cache +
    // NO manual override → a PAID breach scan is still allowed. Confirmation
    // status, source category, and EV never gate execution.
    const decision = startCall(base({
      toolName: "breach_check",
      costTier: "expensive",
      selector: "domrovai",
      selectorType: "username",
      familyKey: "breach_check::username::domrovai",
      expectedValue: 1,
      weakLead: fullyWeak,
      staleCache: true,
      manualOverride: false,
    }));
    expect(decision.allow).toBe(true);
  });
});

// ---- Hard stops: real runaway backstops, per run, NOT refreshed by recording --
describe("runtime-policy: per-run hard stops", () => {
  it("does NOT refresh the paid-call budget when artifacts are recorded (beginCycle)", () => {
    // Exhaust the per-run paid budget with distinct paid tools.
    for (let i = 0; i < MAX_PAID_CALLS; i++) {
      const d = startCall(base({
        toolName: `paid_${i}`,
        costTier: "expensive",
        familyKey: `paid_${i}::email::foo`,
        now: i * MIN_START_GAP_MS,
      }));
      expect(d.allow).toBe(true);
      finishCall(THREAD, `paid_${i}`);
    }
    const blocked = startCall(base({
      toolName: "paid_overflow",
      costTier: "expensive",
      familyKey: "paid_overflow::email::foo",
      now: MAX_PAID_CALLS * MIN_START_GAP_MS,
    }));
    expect(blocked.allow).toBe(false);
    // #16 reworded internal caps as "internal ... cap reached ... internal
    // throttle, not a provider limit" (never narrate an internal cap as a
    // provider rate limit). The block behavior is unchanged.
    if ("reason" in blocked) expect(blocked.reason).toMatch(/internal paid-call cap reached/i);

    // Simulate record_artifacts → beginCycle (this used to reset the counter).
    beginCycle(THREAD);

    // Paid budget must STILL be exhausted — free recording cannot buy paid calls.
    const stillBlocked = startCall(base({
      toolName: "paid_after_record",
      costTier: "expensive",
      familyKey: "paid_after_record::email::foo",
      now: 1_000_000,
    }));
    expect(stillBlocked.allow).toBe(false);
    if ("reason" in stillBlocked) expect(stillBlocked.reason).toMatch(/internal paid-call cap reached/i);

    // ...but FREE tools still run, proving this is the paid budget, not total exhaustion.
    const free = startCall(base({
      toolName: "free_after_record",
      costTier: "free",
      familyKey: "free_after_record::email::foo",
      now: 1_000_001,
    }));
    expect(free.allow).toBe(true);
  });

  it("hard-stops same-tool repeats per run, and recording does not reset it", () => {
    for (let i = 0; i < MAX_SAME_TOOL_CALLS; i++) {
      const d = startCall(base({
        toolName: "google_dorks",
        costTier: "free",
        selector: `s${i}`,
        familyKey: `google_dorks::email::s${i}`,
        now: i * MIN_START_GAP_MS,
      }));
      expect(d.allow).toBe(true);
      finishCall(THREAD, "google_dorks");
    }
    const blocked = startCall(base({
      toolName: "google_dorks",
      costTier: "free",
      familyKey: "google_dorks::email::overflow",
      now: MAX_SAME_TOOL_CALLS * MIN_START_GAP_MS,
    }));
    expect(blocked.allow).toBe(false);
    if ("reason" in blocked) expect(blocked.reason).toMatch(/internal per-tool cap reached/i);

    beginCycle(THREAD); // record_artifacts must not refresh it
    const stillBlocked = startCall(base({
      toolName: "google_dorks",
      costTier: "free",
      familyKey: "google_dorks::email::overflow2",
      now: 1_000_000,
    }));
    expect(stillBlocked.allow).toBe(false);
  });

  it("hard-stops the total call budget", () => {
    for (let i = 0; i < MAX_TOTAL_CALLS; i++) {
      const d = startCall(base({
        toolName: `t_${i}`,
        costTier: "free",
        familyKey: `t_${i}::v`,
        force: true,
        now: i * MIN_START_GAP_MS,
      }));
      expect(d.allow).toBe(true);
      finishCall(THREAD, `t_${i}`);
    }
    const exhausted = startCall(base({
      toolName: "overflow",
      costTier: "free",
      familyKey: "overflow::v",
      force: true,
      now: 10_000_000,
    }));
    expect(exhausted.allow).toBe(false);
    if ("reason" in exhausted) expect(exhausted.reason).toMatch(/internal run cap reached/i);
  });

  it("hard-stops concurrency and releases capacity on finish", () => {
    for (let i = 0; i < MAX_CONCURRENT_CALLS; i++) {
      expect(startCall(base({
        toolName: `c_${i}`,
        costTier: "free",
        familyKey: `c_${i}::v`,
        now: 1_000,
      })).allow).toBe(true);
    }
    const over = startCall(base({ toolName: "c_over", costTier: "free", familyKey: "c_over::v", now: 1_000 }));
    expect(over.allow).toBe(false);
    if ("reason" in over) expect(over.reason).toMatch(/concurrency/i);

    finishCall(THREAD, "c_0");
    expect(startCall(base({ toolName: "c_repl", costTier: "free", familyKey: "c_repl::v", now: 4_000 })).allow).toBe(true);
  });

  it("preserves the minimum pacing gap between starts", () => {
    const first = startCall(base({ toolName: "google_dorks", costTier: "free", familyKey: "gd::v", now: 1_000 }));
    const second = startCall(base({ toolName: "dork_harvest", costTier: "free", familyKey: "dh::v", now: 1_000 }));
    expect(first.allow && first.waitMs).toBe(0);
    expect(second.allow && second.waitMs).toBe(MIN_START_GAP_MS);
  });
});

// ---- Advisory ranking + bookkeeping ------------------------------------------
describe("runtime-policy: advisory scoring & bookkeeping", () => {
  it("scores expected value for ranking (advisory only)", () => {
    expect(scoreExpectedValue({
      selectorConfidence: 70,
      sourceIndependenceBonus: 18,
      corroborationPotential: 12,
      costPenalty: 20,
      duplicatePenalty: 10,
      weakLeadPenalty: 15,
    })).toBe(55);
  });

  it("tracks stage progression and logs rejected calls without throwing", () => {
    beginCycle(THREAD, "test");
    expect(currentStage(THREAD)).toBe("TRIAGE");
    const decision = startCall(base({
      toolName: "triage_seed",
      costTier: "free",
      familyKey: "triage_seed::email::foo@example.com",
    }));
    expect(decision.allow).toBe(true);
    finishCall(THREAD, "triage_seed");
    expect(currentStage(THREAD)).toBe("REVIEW");

    expect(() => noteRejectedCall(THREAD, {
      tool_name: "socialfetch_lookup",
      selector: "foo",
      selector_type: "username",
      expected_value: 12,
      reason: "circuit breaker open",
      cost_tier: "low",
      weak_lead: true,
      stale_cache: false,
      manual_override: false,
    })).not.toThrow();
  });
});

// ---- Prompt/constant consistency (no drift) ----------------------------------
describe("runtime-policy: system prompt advertises real caps", () => {
  it("interpolates the actual runtime constants and drops the stale numbers", () => {
    expect(SYSTEM_PROMPT).toContain(String(MAX_TOTAL_CALLS));
    expect(SYSTEM_PROMPT).toContain(String(MAX_PAID_CALLS));
    expect(SYSTEM_PROMPT).toContain(String(MAX_SAME_TOOL_CALLS));
    expect(SYSTEM_PROMPT).toContain(String(MAX_CONCURRENT_CALLS));
    expect(SYSTEM_PROMPT).toContain(`${MIN_START_GAP_MS}ms`);
    // The pre-fix prompt advertised these; they must be gone.
    expect(SYSTEM_PROMPT).not.toMatch(/35 calls total/);
    expect(SYSTEM_PROMPT).not.toMatch(/750ms/);
    expect(SYSTEM_PROMPT).not.toMatch(/2 paid calls per cycle/);
    expect(SYSTEM_PROMPT).not.toMatch(/1 same-tool call per cycle/);
  });
});
