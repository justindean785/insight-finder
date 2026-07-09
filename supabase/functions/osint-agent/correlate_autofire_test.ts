// correlate_autofire_test.ts — Audit F1 (2026-07-08): the correlation engine
// (minimax_correlate) never fired in the audited run, leaving 73/73 artifacts with
// cluster_id:null. The `artifactsSinceCorrelate` counter existed but was never READ.
// These tests pin the trigger that turns the dead counter into an active nudge.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  guard,
  bumpArtifacts,
  correlateDue,
  correlateNudge,
  CORRELATE_ARTIFACT_THRESHOLD,
} from "./guard.ts";

function resetCounter() {
  guard.artifactsSinceCorrelate = 0;
}

Deno.test("F1: not due below the threshold — no hint surfaced", () => {
  resetCounter();
  bumpArtifacts(CORRELATE_ARTIFACT_THRESHOLD - 1);
  assertEquals(correlateDue(), false);
  assertEquals(correlateNudge(), {}, "below threshold must spread nothing into the result");
});

Deno.test("F1: due once accrued artifacts reach the threshold", () => {
  resetCounter();
  bumpArtifacts(CORRELATE_ARTIFACT_THRESHOLD);
  assert(correlateDue(), "reaching the threshold must make a correlate pass due");
  const nudge = correlateNudge() as { correlate_hint?: string };
  assert(typeof nudge.correlate_hint === "string", "a due pass must surface correlate_hint");
  assert(
    nudge.correlate_hint!.includes("minimax_correlate"),
    "the hint must name the tool to run",
  );
});

Deno.test("F1: a successful correlate (counter reset to 0) clears the nudge", () => {
  resetCounter();
  bumpArtifacts(CORRELATE_ARTIFACT_THRESHOLD + 5);
  assert(correlateDue());
  // minimax_correlate resets the counter on a successful pass (tool-registry.ts).
  guard.artifactsSinceCorrelate = 0;
  assertEquals(correlateDue(), false);
  assertEquals(correlateNudge(), {});
});

Deno.test("F1: bumpArtifacts(0) never advances the counter", () => {
  resetCounter();
  bumpArtifacts(0);
  assertEquals(guard.artifactsSinceCorrelate, 0);
  assertEquals(correlateDue(), false);
});
