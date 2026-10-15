// correlate_freshness_test.ts — 2026-09-08 performance audit's correlation
// freshness gate. Production measured minimax_correlate re-run TWICE on the SAME
// 12 artifacts in one run (12 -> 12, zero new evidence, 22.8s spent) and 172.4s of
// pure duplicate re-runs across a 6-run sample — the single largest wasted-time
// bucket measured. These tests pin shouldSkipRedundantCorrelate(), the gate that
// closes it, and — just as importantly — the two cases it must NEVER block.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  guard,
  MIN_NEW_ARTIFACTS_FOR_RECORRELATE,
  shouldSkipRedundantCorrelate,
} from "../../functions/osint-agent/guard.ts";

function resetGuardState() {
  guard.artifactsSinceCorrelate = 0;
  guard.lastCorrelateOutcome = null;
}

Deno.test("never blocks the run's FIRST correlate call (no prior outcome)", () => {
  resetGuardState();
  guard.artifactsSinceCorrelate = 0;
  assertEquals(guard.lastCorrelateOutcome, null);
  const decision = shouldSkipRedundantCorrelate();
  assertEquals(decision.skip, false, "a run with no prior correlate must never be gated");
  assertEquals(decision.reason, undefined);
});

Deno.test("never blocks a retry after a FAILED correlate, even with zero new evidence", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "failed";
  guard.artifactsSinceCorrelate = 0;
  const decision = shouldSkipRedundantCorrelate();
  assertEquals(decision.skip, false, "a failed pass delivered nothing — its retry must not be gated");
});

Deno.test("blocks a re-run after a SUCCESSFUL correlate with too little new evidence", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE - 1;
  const decision = shouldSkipRedundantCorrelate();
  assert(decision.skip, "insufficient new evidence since a successful pass must be gated");
  assert(typeof decision.reason === "string" && decision.reason.length > 0);
  assert(decision.reason!.includes("redundant correlate"), "reason must be classifiable as a governance skip");
});

Deno.test("the exact production regression: 12 -> 12 artifacts (zero new evidence) is gated", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = 0;
  const decision = shouldSkipRedundantCorrelate();
  assert(decision.skip, "zero new artifacts since a successful pass is the textbook redundant re-run");
});

Deno.test("allows a re-run after a successful correlate once enough new evidence accrued", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE;
  assertEquals(shouldSkipRedundantCorrelate().skip, false);

  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE + 20;
  assertEquals(shouldSkipRedundantCorrelate().skip, false, "well past the floor must still be allowed");
});

Deno.test("boundary: exactly at the threshold is allowed, one below is gated", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";

  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE;
  assertEquals(shouldSkipRedundantCorrelate().skip, false);

  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE - 1;
  assertEquals(shouldSkipRedundantCorrelate().skip, true);
});

Deno.test("resetCorrelateCycle's effect (counter back to 0) re-arms the gate for the NEXT pass", () => {
  resetGuardState();
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE + 5;
  assertEquals(shouldSkipRedundantCorrelate().skip, false, "due for a pass");
  // Simulates the tool's own resetCorrelateCycle() after this pass completes.
  guard.artifactsSinceCorrelate = 0;
  assertEquals(shouldSkipRedundantCorrelate().skip, true, "immediately gated again until new evidence accrues");
});
