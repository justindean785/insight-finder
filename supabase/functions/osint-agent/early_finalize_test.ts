// early_finalize_test.ts — PR B: deterministic EARLY closeout (multi-trigger).
//
// The platform terminates the edge invocation at ~90–120s — well before the 240s
// wall-clock assumption — so 5/5 production runs died mid-investigation and were
// closed by the recovery sweeper instead of producing their own report. The old gate
// only fired at 150s (wall−reserve) or the step cap, so it never fired in time. PR B
// forces finalize on the EARLIEST of: a soft admitted-call limit, a soft elapsed
// budget, or the existing hard backstops — env-configurable and behind a kill switch.
import { assertEquals } from "jsr:@std/assert@^1";
import { MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";
import {
  shouldForceFinalize,
  FINALIZE_SOFT_TOOL_CALLS,
  FINALIZE_SOFT_ELAPSED_MS,
} from "./orchestrator-finalize.ts";

// Elapsed under the 150s hard window and step well under the cap, so ONLY a soft
// trigger can fire — isolating the new early-closeout behavior.
const EARLY_ELAPSED = 40_000;
const EARLY_STEP = 6;

Deno.test("early finalize: fires at the soft admitted-call limit for every run size that died in prod (24,26,30,44,74)", () => {
  for (const attempted of [24, 26, 30, 44, 74]) {
    // PR A caps reservations at MAX_TOOL_CALLS_PER_RUN, so admitted = min(attempted, cap).
    const admitted = Math.min(attempted, MAX_TOOL_CALLS_PER_RUN);
    assertEquals(
      shouldForceFinalize(EARLY_ELAPSED, EARLY_STEP, { admittedCalls: admitted }),
      true,
      `a run reaching ${admitted} admitted calls must force finalize (the old 28-call gate missed 24 & 26)`,
    );
  }
});

Deno.test("early finalize: does NOT fire one call below the soft limit (still investigating)", () => {
  assertEquals(
    shouldForceFinalize(EARLY_ELAPSED, EARLY_STEP, { admittedCalls: FINALIZE_SOFT_TOOL_CALLS - 1 }),
    false,
    "below the soft limit and under the hard window → keep working",
  );
});

Deno.test("early finalize: fires on the soft elapsed budget even with few tool calls (slow upstreams burn the window)", () => {
  assertEquals(shouldForceFinalize(FINALIZE_SOFT_ELAPSED_MS, EARLY_STEP, { admittedCalls: 2 }), true);
  assertEquals(shouldForceFinalize(FINALIZE_SOFT_ELAPSED_MS - 1, EARLY_STEP, { admittedCalls: 2 }), false);
});

Deno.test("early finalize: soft triggers respect the kill switch (forceEarly:false → only hard backstops)", () => {
  // With early finalize OFF, a run at 30 admitted calls / 40s does NOT finalize —
  // reverts to the pre-PR-B behavior (hard 150s / step cap only).
  assertEquals(
    shouldForceFinalize(EARLY_ELAPSED, EARLY_STEP, { admittedCalls: 30, forceEarly: false }),
    false,
    "kill switch disables both soft triggers",
  );
  // …and the hard backstop still fires under the kill switch.
  assertEquals(
    shouldForceFinalize(200_000, EARLY_STEP, { admittedCalls: 0, forceEarly: false }),
    true,
    "hard wall-clock backstop is always active",
  );
});

Deno.test("early finalize: soft thresholds are overridable (env-config surface)", () => {
  assertEquals(shouldForceFinalize(40_000, 3, { admittedCalls: 10, softToolCalls: 10 }), true);
  assertEquals(shouldForceFinalize(40_000, 3, { admittedCalls: 10, softToolCalls: 15 }), false);
  assertEquals(shouldForceFinalize(50_000, 3, { admittedCalls: 0, softElapsedMs: 45_000 }), true);
});
