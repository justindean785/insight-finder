// correlate_autofire_test.ts — Audit F1 (2026-07-08): the correlation engine
// (minimax_correlate) never fired in the audited run, leaving 73/73 artifacts with
// cluster_id:null. The `artifactsSinceCorrelate` counter existed but was never READ.
// These tests pin the trigger that turns the dead counter into an active nudge.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  createRequestState,
  bumpArtifacts,
  correlateDue,
  correlateNudge,
  CORRELATE_ARTIFACT_THRESHOLD,
} from "./guard.ts";

Deno.test("F1: not due below the threshold — no hint surfaced", () => {
  const state = createRequestState();
  bumpArtifacts(state, CORRELATE_ARTIFACT_THRESHOLD - 1);
  assertEquals(correlateDue(state.guard), false);
  assertEquals(correlateNudge(state.guard), {}, "below threshold must spread nothing into the result");
});

Deno.test("F1: due once accrued artifacts reach the threshold", () => {
  const state = createRequestState();
  bumpArtifacts(state, CORRELATE_ARTIFACT_THRESHOLD);
  assert(correlateDue(state.guard), "reaching the threshold must make a correlate pass due");
  const nudge = correlateNudge(state.guard) as { correlate_hint?: string };
  assert(typeof nudge.correlate_hint === "string", "a due pass must surface correlate_hint");
  assert(
    nudge.correlate_hint!.includes("minimax_correlate"),
    "the hint must name the tool to run",
  );
});

Deno.test("F1: a successful correlate (counter reset to 0) clears the nudge", () => {
  const state = createRequestState();
  bumpArtifacts(state, CORRELATE_ARTIFACT_THRESHOLD + 5);
  assert(correlateDue(state.guard));
  // minimax_correlate resets the counter on a successful pass (tool-registry.ts).
  state.guard.artifactsSinceCorrelate = 0;
  assertEquals(correlateDue(state.guard), false);
  assertEquals(correlateNudge(state.guard), {});
});

Deno.test("F1: bumpArtifacts(0) never advances the counter", () => {
  const state = createRequestState();
  bumpArtifacts(state, 0);
  assertEquals(state.guard.artifactsSinceCorrelate, 0);
  assertEquals(correlateDue(state.guard), false);
});

Deno.test("F1: two independent request states never observe each other's counter (finding #8)", () => {
  const a = createRequestState();
  const b = createRequestState();
  bumpArtifacts(a, CORRELATE_ARTIFACT_THRESHOLD);
  assert(correlateDue(a.guard), "request A's own state reflects its bump");
  assertEquals(correlateDue(b.guard), false, "request B's independent state must be untouched by A's bump");
});
