/**
 * BOUNDED correlation finalize-deferral — closes the unbounded-deferral P0.
 *
 * THE DEFECT. `shouldDeferFinalizeForCorrelate` was
 * `correlateDue && lastCorrelateOutcome === null`, with a doc comment claiming
 * finalize "may defer once". There was no once. `lastCorrelateOutcome` only becomes
 * non-null when a correlate call actually DISPATCHES, and `correlateDue()` is
 * `artifactsSinceCorrelate >= CORRELATE_ARTIFACT_THRESHOLD` — a counter that
 * `bumpAutoPersistedArtifacts` advances from auto-persist alone, with no model
 * involvement. So on a run where the model never issued a correlate call, BOTH
 * stayed true for the whole run, and at index.ts the expression
 * `shouldForceFinalize(...) && !correlatePending` negated the wall-clock forced
 * finalize on EVERY step. The only surviving route to a report was the hard
 * tool-call cap; a run that instead exhausted wall clock died with no report.
 *
 * These tests DRIVE the shipped predicate rather than re-describing it: each one
 * simulates the real loop — repeated prepareStep evaluations with a caller-owned
 * counter incremented exactly as index.ts increments it — and asserts the run
 * reaches a forced finalize. Under the old two-argument predicate the "second
 * attempt" and "never-correlates" cases below loop forever without finalizing.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldDeferFinalizeForCorrelate,
  shouldForceFinalize,
  correlateDeferralFloorMs,
  MAX_CORRELATE_FINALIZE_DEFERRALS,
  CORRELATE_DEFERRAL_GRACE_MS,
  FINALIZE_RESERVE_MS,
  wallClockFinalizeDue,
  stepCapFinalizeDue,
} from "./orchestrator-finalize.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS, MAX_ORCHESTRATOR_STEPS } from "./orchestrator-budget.ts";

const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
const floorAt = correlateDeferralFloorMs();

/**
 * The shipped index.ts decision, extracted verbatim in shape so these tests
 * exercise the real control flow rather than a paraphrase of it:
 *
 *   stepCapDue        = stepCapFinalizeDue(step)
 *   forceFinalizeNow  = wallClockFinalizeDue(elapsed) || stepCapDue
 *   correlatePending  = shouldDeferFinalizeForCorrelate(due, outcome, used, elapsed, stepCapDue)
 *   deferForCorrelate = forceFinalizeNow && correlatePending   → increments the counter
 *   finalize          = forceFinalizeNow && !deferForCorrelate
 */
function step(
  state: { used: number },
  elapsedMs: number,
  stepNumber: number,
  correlateDue: boolean,
  lastCorrelateOutcome: "ok" | "failed" | null,
): { finalized: boolean; deferred: boolean } {
  const stepCapDue = stepCapFinalizeDue(stepNumber);
  const forceFinalizeNow = wallClockFinalizeDue(elapsedMs) || stepCapDue;
  const correlatePending = shouldDeferFinalizeForCorrelate(
    correlateDue, lastCorrelateOutcome, state.used, elapsedMs, stepCapDue,
  );
  const deferred = forceFinalizeNow && correlatePending;
  if (deferred) state.used++;
  return { finalized: forceFinalizeNow && !deferred, deferred };
}

Deno.test("bound: correlation due and never run — FIRST forced finalize may defer", () => {
  const state = { used: 0 };
  const r = step(state, openAt + 1_000, 3, true, null);
  assertEquals(r.deferred, true, "the first attempt is allowed one deferral");
  assertEquals(r.finalized, false);
  assertEquals(state.used, 1, "the deferral is counted");
});

Deno.test("bound: SAME condition again — the SECOND attempt MUST finalize", () => {
  const state = { used: 0 };
  const first = step(state, openAt + 1_000, 3, true, null);
  assertEquals(first.deferred, true);

  // Identical inputs: correlation still due, still never dispatched. Under the old
  // predicate this deferred again, forever.
  const second = step(state, openAt + 2_000, 4, true, null);
  assertEquals(second.deferred, false, "the single deferral is spent");
  assertEquals(second.finalized, true, "finalize is forced on the second attempt");
});

Deno.test("bound: a run whose model NEVER correlates still finalizes — the P0 itself", () => {
  const state = { used: 0 };
  let finalized = false;
  let deferrals = 0;
  // Walk the reserve window in 1s steps with correlation permanently due and never
  // dispatched — the exact production shape. Under the old predicate this loop ends
  // with finalized === false.
  for (let elapsed = openAt; elapsed <= ORCHESTRATOR_WALL_CLOCK_MS; elapsed += 1_000) {
    const r = step(state, elapsed, 2, true, null);
    if (r.deferred) deferrals++;
    if (r.finalized) { finalized = true; break; }
  }
  assert(finalized, "the run MUST reach a forced finalize");
  assertEquals(deferrals, MAX_CORRELATE_FINALIZE_DEFERRALS, "and take at most one deferral");
});

Deno.test("floor: past the hard wall-clock floor, NO deferral is taken even unspent", () => {
  const state = { used: 0 };
  const r = step(state, floorAt, 3, true, null);
  assertEquals(r.deferred, false, "the floor binds independently of the counter");
  assertEquals(r.finalized, true);
  assertEquals(state.used, 0, "an unspent deferral is not consumed by the floor");
});

Deno.test("floor: sits between the reserve opening and the hard deadline", () => {
  assertEquals(floorAt, openAt + CORRELATE_DEFERRAL_GRACE_MS);
  assert(floorAt > openAt, "a deferral must be possible at all");
  assert(
    floorAt < ORCHESTRATOR_WALL_CLOCK_MS,
    "and must leave wall clock for the closing synthesis step",
  );
  assert(
    ORCHESTRATOR_WALL_CLOCK_MS - floorAt >= 55_000,
    "at least ~55s for the 43-51s synthesis tail measured on d4873abc",
  );
});

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

Deno.test("unchanged: before the reserve window nothing is forced, so nothing is deferred", () => {
  const state = { used: 0 };
  const r = step(state, openAt - 10_000, 2, true, null);
  assertEquals(r.finalized, false, "finalize was not due yet");
  assertEquals(r.deferred, false, "so the deferral must NOT be spent");
  assertEquals(state.used, 0, "the single deferral is reserved for a real finalize");
});

Deno.test("fails closed: non-finite counter or elapsed never defers", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, NaN, openAt, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, Infinity, openAt, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, NaN, false), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, Infinity, false), false);
});

/**
 * THE STEP-CAP TRIGGER IS NOT DEFERRABLE — and this is modelled on the REAL loop.
 *
 * An earlier version of this test asserted the final step could defer, then proved
 * safety by invoking the helper a second time at the same step number. Production
 * makes no such call. `stopWhen` includes
 * `stepLimitReached = !finalizeStarted && stepCountIs(MAX_ORCHESTRATOR_STEPS)`
 * (index.ts), and `stepNumber` is 0-indexed for the step about to run, so
 * `MAX_ORCHESTRATOR_STEPS - 1` IS the last step. Deferring there leaves
 * `finalizeStarted` false, the step limit fires, and the run ends with no report —
 * the exact class of failure this PR closes.
 */
Deno.test("step cap: the FINAL step finalizes immediately and never defers", () => {
  const state = { used: 0 };
  const last = MAX_ORCHESTRATOR_STEPS - 1;
  const r = step(state, 0, last, true, null);
  assertEquals(r.deferred, false, "the last step must never defer");
  assertEquals(r.finalized, true, "it must finalize on this very step");
  assertEquals(state.used, 0, "and must not consume the wall-clock allowance");
});

Deno.test("step cap: not deferrable even with the allowance unspent and below the floor", () => {
  // Every other condition favours a deferral: correlation due, never run, counter
  // at 0, elapsed at 0. Only stepCapDue blocks it — proving that guard is load-bearing.
  assertEquals(
    shouldDeferFinalizeForCorrelate(true, null, 0, 0, /* stepCapDue */ true),
    false,
  );
  assertEquals(
    shouldDeferFinalizeForCorrelate(true, null, 0, 0, /* stepCapDue */ false),
    true,
  );
});

/**
 * The real finite-step execution: the loop ENDS at the step cap, with no synthetic
 * extra invocation. Under the pre-fix patch this run ends with finalized === false.
 */
Deno.test("step cap: a run that reaches the cap with correlation due still reports", () => {
  const state = { used: 0 };
  let finalized = false;
  for (let s = 0; s <= MAX_ORCHESTRATOR_STEPS - 1; s++) {
    // Elapsed stays below the reserve opening so ONLY the step cap can force
    // finalize — isolating the trigger under test.
    const r = step(state, 0, s, true, null);
    if (r.finalized) { finalized = true; break; }
  }
  assert(finalized, "the run MUST finalize on or before the final permitted step");
  assertEquals(state.used, 0, "and the step-cap path consumes no deferral");
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
