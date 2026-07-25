// PR B — deterministic early closeout.
// The live failure: runs gather evidence but never stop to synthesize before the
// platform's ~90-135s invocation window ends. Finalize opens at 90s (reserve of an
// assumed 180s), leaving too little runway for the multi-step finalize. This opens
// finalize at the EARLIEST of a short elapsed budget OR a modest admitted-call count,
// so synthesis runs while ample runtime remains. Env-tunable + kill switch.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldEarlyCloseout } from "./orchestrator-finalize.ts";

const CANARY = { enabled: true, elapsedMs: 65_000, calls: 20 };

Deno.test("early closeout fires at each of the five audited run sizes (24/26/30/44/74 calls)", () => {
  for (const calls of [24, 26, 30, 44, 74]) {
    assert(shouldEarlyCloseout(0, calls, CANARY), `must fire at ${calls} genuine calls`);
  }
});

Deno.test("catches the runs the old 28-call gate missed (24 & 26)", () => {
  // elapsed far below threshold so ONLY the call trigger can fire.
  assert(shouldEarlyCloseout(1_000, 24, CANARY));
  assert(shouldEarlyCloseout(1_000, 26, CANARY));
});

Deno.test("elapsed trigger fires on a slow-tool stall with few calls", () => {
  assert(shouldEarlyCloseout(65_000, 3, CANARY), "65s stall must finalize");
  assert(!shouldEarlyCloseout(40_000, 3, CANARY), "40s with 3 calls must keep going");
});

Deno.test("light run keeps its full depth (below both thresholds)", () => {
  assert(!shouldEarlyCloseout(30_000, 10, CANARY));
});

Deno.test("kill switch disables early closeout entirely", () => {
  assert(!shouldEarlyCloseout(120_000, 100, { enabled: false }));
});

Deno.test("boundary: exactly at each threshold fires", () => {
  assert(shouldEarlyCloseout(65_000, 0, CANARY), "elapsed == threshold fires");
  assert(shouldEarlyCloseout(0, 20, CANARY), "calls == threshold fires");
});
