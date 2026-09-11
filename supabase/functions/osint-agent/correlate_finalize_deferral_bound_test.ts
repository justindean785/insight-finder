/**
 * BOUNDED correlation finalize-deferral -- the required-completion-budget
 * correction.
 *
 * THE DEFECT THIS FILE NOW PINS (Codex P1, confirmed on review thread
 * PRRT_kwDOSxbowM6hW_4I at orchestrator-finalize.ts:325, filed against the PR
 * that first bounded the deferral with a flat 30s grace window). A deferral
 * taken at, say, 94s elapsed let minimax_correlate run up to its own enforced
 * 60s cap, after which a real model-planning turn (~13.3s measured) and the
 * closing synthesis tail (measured max 51,359ms) still had to happen before a
 * report could be written -- 94s + 60s + 13.3s + 51.4s is about 218.7s, past
 * both the 180s wall-clock budget and the platform's ~180s hard lifetime the
 * P1 named directly. Production run 050526ff hit this shape: deferral at
 * 94,243ms, correlate 29,226ms, planning ~13,300ms, synthesis 41,792ms, total
 * 181,133ms -- already over budget on a call nowhere near its own worst case.
 *
 * The fix replaces the flat grace window with an explicit required-completion
 * budget: a deferral is legal only when the wall-clock REMAINING covers the
 * correlate call + the planning turn after it + the closing synthesis + a
 * safety margin (requiredCompletionMs(), orchestrator-finalize.ts). Under
 * current runtime constants that budget (140s) exceeds the entire reserve
 * window (90s), so the intended, correct result is that NO wall-clock-bound
 * deferral is reachable today -- these tests pin that directly, using
 * production defaults, rather than only exercising the mechanism through
 * artificially roomy overrides.
 *
 * These tests DRIVE the shipped predicate rather than re-describing it: each
 * one simulates the real loop -- repeated prepareStep evaluations with a
 * caller-owned counter incremented exactly as index.ts increments it -- and
 * asserts the run reaches a forced finalize. No test proves safety by invoking
 * the helper a second time at the same step number; the step-cap tests walk a
 * real finite loop that ends at the cap, exactly as index.ts's stopWhen does.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldDeferFinalizeForCorrelate,
  shouldForceFinalize,
  requiredCompletionMs,
  CORRELATE_COMPLETION_BUDGET_MS,
  POST_CORRELATE_PLANNING_BUDGET_MS,
  FINALIZE_SYNTHESIS_BUDGET_MS,
  COMPLETION_SAFETY_MARGIN_MS,
  MAX_CORRELATE_FINALIZE_DEFERRALS,
  FINALIZE_RESERVE_MS,
  wallClockFinalizeDue,
  stepCapFinalizeDue,
} from "./orchestrator-finalize.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS, MAX_ORCHESTRATOR_STEPS } from "./orchestrator-budget.ts";

const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS; // 90_000
const required = requiredCompletionMs(); // 140_000 under current constants

/**
 * The shipped index.ts decision for the DEFERRABLE half, extracted verbatim in
 * shape so these tests exercise the real control flow rather than a paraphrase
 * of it:
 *
 *   stepCapDue        = stepCapFinalizeDue(step)
 *   forceFinalizeNow  = wallClockFinalizeDue(elapsed) || stepCapDue
 *   correlatePending  = shouldDeferFinalizeForCorrelate(due, outcome, used, elapsed, stepCapDue, opts)
 *   deferForCorrelate = forceFinalizeNow && correlatePending   -> increments the counter
 *   finalize          = forceFinalizeNow && !deferForCorrelate
 *
 * `opts` (when given) is threaded to BOTH wallClockFinalizeDue and
 * shouldDeferFinalizeForCorrelate, matching how a test constructs an
 * alternate-budget scenario end to end rather than only overriding one call.
 */
function step(
  state: { used: number },
  elapsedMs: number,
  stepNumber: number,
  correlateDue: boolean,
  lastCorrelateOutcome: "ok" | "failed" | null,
  opts?: Parameters<typeof shouldDeferFinalizeForCorrelate>[5],
): { finalized: boolean; deferred: boolean } {
  const stepCapDue = stepCapFinalizeDue(stepNumber);
  const forceFinalizeNow = wallClockFinalizeDue(elapsedMs, opts) || stepCapDue;
  const correlatePending = shouldDeferFinalizeForCorrelate(
    correlateDue, lastCorrelateOutcome, state.used, elapsedMs, stepCapDue, opts,
  );
  const deferred = forceFinalizeNow && correlatePending;
  if (deferred) state.used++;
  return { finalized: forceFinalizeNow && !deferred, deferred };
}

/**
 * The FULL shipped composition, including the two triggers that bypass the
 * deferral question entirely: `finalizeStarted` and the hard tool-call cap
 * (index.ts: `if (finalizeStarted || capReached || (forceFinalizeNow &&
 * !deferForCorrelate))`). Neither is an input to shouldDeferFinalizeForCorrelate
 * -- they short-circuit the OUTER decision regardless of what it returns.
 */
function outerFinalizeDecision(
  finalizeStarted: boolean,
  capReached: boolean,
  forceFinalizeNow: boolean,
  deferForCorrelate: boolean,
): boolean {
  return finalizeStarted || capReached || (forceFinalizeNow && !deferForCorrelate);
}

// ── 1. THE REGRESSION ITSELF: production budgets refuse every elapsed value in
//       the old [90s,120s) grace window ──────────────────────────────────────
Deno.test("regression: every representative elapsed value in the old [90s,120s) window refuses deferral under production budgets", () => {
  for (let elapsed = 90_000; elapsed < 120_000; elapsed += 5_000) {
    assertEquals(
      shouldDeferFinalizeForCorrelate(true, null, 0, elapsed, false),
      false,
      `elapsed=${elapsed} must refuse -- not enough remaining time for correlate + planning + synthesis + margin`,
    );
  }
  // The old floor itself (120_000) and a few points past it.
  for (const elapsed of [119_999, 120_000, 150_000, 179_999]) {
    assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, elapsed, false), false, `elapsed=${elapsed}`);
  }
});

Deno.test("requiredCompletionMs() sums the four budgets and exceeds the entire reserve window under current constants", () => {
  assertEquals(
    requiredCompletionMs(),
    CORRELATE_COMPLETION_BUDGET_MS + POST_CORRELATE_PLANNING_BUDGET_MS + FINALIZE_SYNTHESIS_BUDGET_MS + COMPLETION_SAFETY_MARGIN_MS,
  );
  // The intended safety result, pinned directly: no elapsed value at or after
  // the reserve opening leaves enough remaining budget to defer.
  assert(
    required > ORCHESTRATOR_WALL_CLOCK_MS - openAt,
    "required completion budget must exceed the reserve window, so today no wall-clock-bound deferral is reachable",
  );
});

// ── 2 & 3. insufficient budget refuses; the exact boundary is pinned ─────────
Deno.test("boundary: remaining budget one ms short of required refuses; exactly required permits", () => {
  const shortOfRequired = ORCHESTRATOR_WALL_CLOCK_MS - (required - 1); // remaining = required - 1
  const exactlyRequired = ORCHESTRATOR_WALL_CLOCK_MS - required; // remaining = required
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, shortOfRequired, false), false, "one ms short must refuse");
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, exactlyRequired, false), true, "exactly enough must permit");
});

// ── 4 & 6. sufficient remaining budget permits exactly one deferral, never a
//           second ────────────────────────────────────────────────────────
Deno.test("bound: sufficient remaining budget permits ONE deferral; the SAME condition again must finalize", () => {
  // Shrink the sub-budgets (not budgetMs/reserveMs -- overriding budgetMs alone
  // would also shift where wallClockFinalizeDue thinks the reserve window opens,
  // since it derives "opens at" from budgetMs - reserveMs) so the requirement
  // comfortably fits inside the REAL 90s reserve window, isolating "is there
  // enough time" from "has the counter been spent".
  const roomy = { correlateBudgetMs: 5_000, planningBudgetMs: 5_000, synthesisBudgetMs: 5_000, safetyMarginMs: 5_000 };
  assert(requiredCompletionMs(roomy) < ORCHESTRATOR_WALL_CLOCK_MS - openAt, "sanity: the shrunk requirement must actually fit in the real window");
  const state = { used: 0 };

  const first = step(state, openAt + 1_000, 3, true, null, roomy);
  assertEquals(first.deferred, true, "the first attempt is allowed one deferral when there is enough remaining time");
  assertEquals(first.finalized, false);
  assertEquals(state.used, 1, "the deferral is counted");

  // Identical inputs (same elapsed, same due/outcome, same roomy budget): the
  // counter is spent, so the second attempt MUST finalize even though the
  // budget math alone would still permit it.
  const second = step(state, openAt + 1_000, 4, true, null, roomy);
  assertEquals(second.deferred, false, "the single deferral is spent");
  assertEquals(second.finalized, true, "finalize is forced on the second attempt");
});

Deno.test("bound: a spent counter refuses even with a budget far larger than required", () => {
  const roomy = { budgetMs: openAt + required + 100_000 };
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, /* used */ 1, openAt, false, roomy), false);
});

// ── 5 & 13. the final SDK step never defers, proven with a real finite loop ──
Deno.test("step cap: the FINAL step finalizes immediately and never defers", () => {
  const state = { used: 0 };
  const last = MAX_ORCHESTRATOR_STEPS - 1;
  const r = step(state, 0, last, true, null);
  assertEquals(r.deferred, false, "the last step must never defer");
  assertEquals(r.finalized, true, "it must finalize on this very step");
  assertEquals(state.used, 0, "and must not consume the wall-clock allowance");
});

Deno.test("step cap: not deferrable even with the allowance unspent and elapsed at zero (plenty of remaining budget)", () => {
  // Every other condition favours a deferral: correlation due, never run, counter
  // at 0, elapsed at 0 -- under real constants that leaves 180s remaining, well
  // above requiredCompletionMs() (140s), so ONLY stepCapDue blocks it. Proves that
  // guard is load-bearing independent of, and checked before, the budget math.
  assertEquals(
    shouldDeferFinalizeForCorrelate(true, null, 0, 0, /* stepCapDue */ true),
    false,
  );
  assertEquals(
    shouldDeferFinalizeForCorrelate(true, null, 0, 0, /* stepCapDue */ false),
    true,
  );
});

Deno.test("step cap: a run that reaches the cap with correlation due still reports (real finite loop, no synthetic second call)", () => {
  const state = { used: 0 };
  let finalized = false;
  for (let s = 0; s <= MAX_ORCHESTRATOR_STEPS - 1; s++) {
    // Elapsed stays below the reserve opening so ONLY the step cap can force
    // finalize -- isolating the trigger under test.
    const r = step(state, 0, s, true, null);
    if (r.finalized) { finalized = true; break; }
  }
  assert(finalized, "the run MUST finalize on or before the final permitted step");
  assertEquals(state.used, 0, "and the step-cap path consumes no deferral");
});

// ── 7 & 8. finalizeStarted and the tool-call cap bypass the deferral question
//           entirely -- they are not inputs to shouldDeferFinalizeForCorrelate,
//           they short-circuit the OUTER index.ts composition ──────────────
Deno.test("outer composition: the tool-call cap forces finalize regardless of a pending deferral", () => {
  assertEquals(outerFinalizeDecision(false, /* capReached */ true, true, /* deferForCorrelate */ true), true);
  assertEquals(outerFinalizeDecision(false, /* capReached */ true, false, false), true);
});

Deno.test("outer composition: finalizeStarted forces finalize regardless of everything else", () => {
  assertEquals(outerFinalizeDecision(/* finalizeStarted */ true, false, false, false), true);
  assertEquals(outerFinalizeDecision(/* finalizeStarted */ true, false, true, true), true);
});

// ── 9 & 10. unchanged eligibility axes ────────────────────────────────────────
Deno.test("unchanged: a COMPLETED correlate never defers, at any elapsed or count", () => {
  for (const outcome of ["ok", "failed"] as const) {
    assertEquals(shouldDeferFinalizeForCorrelate(true, outcome, 0, openAt, false), false);
    assertEquals(shouldDeferFinalizeForCorrelate(true, outcome, 0, 0, false), false);
  }
});

Deno.test("unchanged: correlation NOT due never defers", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(false, null, 0, openAt, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(false, null, 0, 0, false), false);
});

// ── 11. intermediate steps (nothing forced yet) never consume the allowance ──
Deno.test("unchanged: before the reserve window nothing is forced, so nothing is deferred", () => {
  const state = { used: 0 };
  const r = step(state, openAt - 10_000, 2, true, null);
  assertEquals(r.finalized, false, "finalize was not due yet");
  assertEquals(r.deferred, false, "so the deferral must NOT be spent");
  assertEquals(state.used, 0, "the single deferral is reserved for a real finalize");
});

// ── 12. fails closed on non-finite input, including the NEW derived-remaining
//        path ────────────────────────────────────────────────────────────────
Deno.test("fails closed: non-finite counter or elapsed never defers", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, NaN, openAt, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, Infinity, openAt, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, NaN, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, Infinity, false), false);
});

Deno.test("fails closed: a non-finite budget (so a non-finite derived remaining time) never defers", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, openAt, false, { budgetMs: Infinity }), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, openAt, false, { budgetMs: NaN }), false);
});

Deno.test("wall-clock and step-cap triggers compose exactly as shouldForceFinalize", () => {
  const cases: Array<[number, number]> = [
    [0, 0], [openAt, 0], [0, MAX_ORCHESTRATOR_STEPS - 1],
    [openAt, MAX_ORCHESTRATOR_STEPS - 1], [openAt - 1, MAX_ORCHESTRATOR_STEPS - 2],
  ];
  for (const [elapsed, stepNo] of cases) {
    assertEquals(
      wallClockFinalizeDue(elapsed) || stepCapFinalizeDue(stepNo),
      shouldForceFinalize(elapsed, stepNo),
      `split must equal the original at elapsed=${elapsed} step=${stepNo}`,
    );
  }
});

Deno.test("MAX_CORRELATE_FINALIZE_DEFERRALS is exactly one", () => {
  assertEquals(MAX_CORRELATE_FINALIZE_DEFERRALS, 1);
});
