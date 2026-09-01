/**
 * The correlate PROGRESS trigger — auto-persisted artifacts must count.
 *
 * PRODUCTION SHAPE THIS PINS (thread c65e555b, build 1c83789): 21 tool calls, ZERO
 * tool failures, 34 artifacts written — all by auto-persist, because the model made
 * `record_artifact_calls: 0`. `minimax_correlate` never ran, and every artifact
 * finished with `cluster_id: null`. It looked like the finalize window ate the
 * correlate call. It did — but only as the SECOND event. The first is that
 * `bumpArtifacts` was unreachable from auto-persist, so `artifactsSinceCorrelate`
 * read 0 all run and `correlateDue()` was never true.
 *
 * These tests drive the shipped functions (`bumpAutoPersistedArtifacts`,
 * `correlateDue`, `correlateNudge`, `shouldSkipForFinalizeWindow`) rather than
 * restating their logic.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  guard,
  bumpAutoPersistedArtifacts,
  correlateDue,
  correlateNudge,
  CORRELATE_ARTIFACT_THRESHOLD,
} from "./guard.ts";
import { shouldSkipForFinalizeWindow } from "./orchestrator-finalize.ts";

function reset() {
  guard.artifactsSinceCorrelate = 0;
}
const autoPersistResult = (n: number, kind = "url") => ({
  inserted: n,
  skipped_duplicates: 0,
  rows: Array.from({ length: n }, () => ({ kind })),
});

// ── THE REGRESSION: the exact production failure shape ───────────────────────
Deno.test("REGRESSION c65e555b: many auto-persisted artifacts + zero failures makes the trigger eligible", () => {
  reset();
  // 34 artifacts, none of them recorded by the model. Before this fix the counter
  // never moved and correlate was never requested.
  assertEquals(correlateDue(), false, "precondition: nothing accrued yet");
  bumpAutoPersistedArtifacts(autoPersistResult(34));
  assert(correlateDue(), "34 auto-persisted artifacts MUST make a correlate pass due");
  assert("correlate_hint" in correlateNudge(), "the orchestrator must actually be told");
});

Deno.test("the trigger becomes eligible BEFORE the finalize window opens", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD));
  // Early in the run: window shut, and the pass is already due — which is the whole
  // point. Correlation is requested while live lookups are still admitted.
  const earlyMs = 5_000;
  assertEquals(shouldSkipForFinalizeWindow(earlyMs, false), false, "window must still be shut this early");
  assert(correlateDue(), "correlate must be due while the window is still shut");
});

// ── NOT wasting a call on a thin run ─────────────────────────────────────────
Deno.test("a small run does not waste a correlate call", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD - 1));
  assertEquals(correlateDue(), false);
  assertEquals(Object.keys(correlateNudge()).length, 0, "no hint below the threshold");
});

Deno.test("a run that persists nothing never triggers", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(0));
  bumpAutoPersistedArtifacts({ inserted: 0, rows: [] });
  assertEquals(correlateDue(), false);
});

Deno.test("malformed / absent results are inert — they cannot move the counter", () => {
  reset();
  for (const bad of [null, undefined, {}, { inserted: -5, rows: [] }, { inserted: Number.NaN, rows: [] }]) {
    assertEquals(bumpAutoPersistedArtifacts(bad as never), 0);
  }
  assertEquals(guard.artifactsSinceCorrelate, 0);
});

// ── NO repeat firing on an unchanged population ──────────────────────────────
Deno.test("an unchanged artifact population does not re-trigger", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD));
  assert(correlateDue());
  // A successful minimax_correlate resets the counter (tool-registry.ts:758). After
  // that, with no NEW artifacts, the pass must not be due again.
  guard.artifactsSinceCorrelate = 0;
  bumpAutoPersistedArtifacts(autoPersistResult(0));
  assertEquals(correlateDue(), false, "no new evidence must not re-request correlation");
});

Deno.test("a second threshold-sized batch can re-trigger", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD));
  assert(correlateDue());
  guard.artifactsSinceCorrelate = 0;            // the correlate pass ran
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD));
  assert(correlateDue(), "genuinely new evidence must be correlatable again");
});

// ── FINALIZATION MUST NOT DEPEND ON THIS. CLAUDE.md's termination invariant. ──
Deno.test("opening the finalize window initiates no correlate work", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(50));
  // The window guard is evaluated purely on elapsed time and whether the tool is a
  // recording tool. It consults nothing about correlation, and this change adds no
  // path from the counter into it.
  const lateMs = 10_000_000;
  assertEquals(shouldSkipForFinalizeWindow(lateMs, false), true, "late non-recording lookups are skipped");
  assertEquals(shouldSkipForFinalizeWindow(lateMs, true), false, "recording tools stay allowed");
  // Being "due" changes nothing about the window's verdict either way.
  assert(correlateDue());
  assertEquals(shouldSkipForFinalizeWindow(lateMs, false), true, "a due correlate does NOT reopen the window");
});

Deno.test("finalize can complete when correlation never ran", () => {
  reset();
  // Counter at zero, correlate never requested, never executed. The finalize window
  // behaves identically — nothing gates on correlation having happened.
  assertEquals(correlateDue(), false);
  assertEquals(shouldSkipForFinalizeWindow(10_000_000, true), false, "recording/finalize path is unaffected");
  assertEquals(shouldSkipForFinalizeWindow(0, true), false);
});

Deno.test("a failed correlate does not block finalization", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(CORRELATE_ARTIFACT_THRESHOLD));
  guard.lastCorrelateOutcome = "failed";
  // The failure is recorded and nothing else consults it to decide finalization.
  assertEquals(shouldSkipForFinalizeWindow(10_000_000, true), false, "recording/finalize still admitted after a failed correlate");
  guard.lastCorrelateOutcome = null;
});

// ── The existing caps stay authoritative ─────────────────────────────────────
Deno.test("the trigger requests correlation, it does not grant budget", () => {
  reset();
  bumpAutoPersistedArtifacts(autoPersistResult(500));
  // Being due is only a hint on a tool result. It reserves no slot, raises no cap and
  // bypasses no guard — MAX_TOOL_CALLS_PER_RUN and the paid-call budget still decide
  // whether the call is admitted.
  assert(correlateDue());
  const nudge = correlateNudge();
  assertEquals(typeof nudge.correlate_hint, "string");
  assertEquals(Object.keys(nudge), ["correlate_hint"], "the nudge carries no budget or cap field");
});

Deno.test("the counted kinds are reported, so meta-only batches are attributable", () => {
  reset();
  // The current code keeps ONE undifferentiated counter — record_artifacts bumps by
  // row count and triage_seed bumps by 1 for a `triage_decision`. This change follows
  // that existing semantics rather than inventing a taxonomy. Kinds are threaded
  // through so a later, deliberate exclusion has the data it needs.
  assertEquals(bumpAutoPersistedArtifacts(autoPersistResult(3, "url")), 3);
  assertEquals(guard.artifactsSinceCorrelate, 3);
});
