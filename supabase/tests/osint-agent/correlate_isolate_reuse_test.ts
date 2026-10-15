// correlate_isolate_reuse_test.ts — the warm-isolate half of the 2026-09-08
// correlation freshness gate (#561).
//
// WHY THIS FILE EXISTS, separately from correlate_freshness_test.ts:
//
// `guard` is module-scoped and SURVIVES ACROSS REQUESTS on a warm Deno isolate —
// index.ts says so in its own comment ("Reset guard/triage state (module-scoped,
// must be reset per-request)"). #561's gate keys on `lastCorrelateOutcome`, and
// that was the ONE correlation field request start never cleared: it reset the
// counter and the hint latch via resetCorrelateCycle() and left the outcome
// latched at "ok" from the PREVIOUS run.
//
// The consequence is the exact opposite of #561's stated invariant. #561 promises
// "the run's FIRST correlate call is never blocked", and on a cold isolate that
// holds. On a warm one, Run B started with lastCorrelateOutcome="ok" (Run A's) and
// artifactsSinceCorrelate=0 (freshly reset) — the precise pair the gate reads as
// "redundant" — so Run B's first correlate was refused until 3 artifacts happened
// to accrue. Every unit test in correlate_freshness_test.ts passed throughout,
// because each one hand-zeroes BOTH fields in its own resetGuardState() helper —
// it constructs a starting state that production never actually produced.
//
// So these tests drive the RESET HELPERS THEMSELVES across a simulated request
// boundary, rather than asserting the predicate against a hand-built state.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  guard,
  MIN_NEW_ARTIFACTS_FOR_RECORRELATE,
  resetCorrelateCycle,
  resetCorrelateRun,
  shouldSkipRedundantCorrelate,
} from "../../functions/osint-agent/guard.ts";

/** Leave `guard` exactly as a run that correlated successfully would leave it:
 *  outcome latched "ok", and fewer than the re-correlate threshold of new
 *  artifacts recorded since. This is the state a warm isolate hands to the NEXT
 *  request — it is deliberately NOT a hand-zeroed clean slate. */
function leaveGuardAsAFinishedRunWould() {
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = MIN_NEW_ARTIFACTS_FOR_RECORRELATE - 1;
  guard.correlateHintDelivered = true;
}

Deno.test("warm isolate: resetCorrelateRun lets Run B's FIRST correlate through", () => {
  leaveGuardAsAFinishedRunWould();

  // --- request boundary: what index.ts does at the top of Deno.serve ---
  resetCorrelateRun();

  assertEquals(guard.lastCorrelateOutcome, null, "a new request must not inherit the prior run's outcome");
  assertEquals(guard.artifactsSinceCorrelate, 0);
  assertEquals(guard.correlateHintDelivered, false);

  const decision = shouldSkipRedundantCorrelate();
  assertEquals(
    decision.skip,
    false,
    "Run B's first correlate must never be gated by Run A's success on a reused isolate",
  );
});

Deno.test("regression: the MID-RUN helper alone at request start reopens the bug", () => {
  leaveGuardAsAFinishedRunWould();

  // This is precisely what request start used to call. It is kept here as an
  // executable statement of WHY the two helpers must stay distinct: if someone
  // later "simplifies" index.ts back to resetCorrelateCycle(), this test fails.
  resetCorrelateCycle();

  assertEquals(guard.lastCorrelateOutcome, "ok", "the mid-run helper deliberately preserves the outcome");
  const decision = shouldSkipRedundantCorrelate();
  assert(
    decision.skip,
    "documents the defect: the cycle helper alone leaves Run B's first correlate gated",
  );
});

Deno.test("mid-run: resetCorrelateCycle must NOT clear the outcome (the gate would die)", () => {
  guard.lastCorrelateOutcome = "ok";
  guard.artifactsSinceCorrelate = 0;
  guard.correlateHintDelivered = true;

  // minimax_correlate's own success path calls this after a pass completes.
  resetCorrelateCycle();

  assertEquals(
    guard.lastCorrelateOutcome,
    "ok",
    "clearing the outcome here would make every post-success re-run look like the run's first",
  );
  assertEquals(guard.correlateHintDelivered, false, "the hint latch must re-arm for the next batch");
  assert(shouldSkipRedundantCorrelate().skip, "the gate must still bite immediately after a successful pass");
});

Deno.test("resetCorrelateRun is idempotent and safe on a cold isolate", () => {
  guard.lastCorrelateOutcome = null;
  guard.artifactsSinceCorrelate = 0;
  guard.correlateHintDelivered = false;

  resetCorrelateRun();
  resetCorrelateRun();

  assertEquals(guard.lastCorrelateOutcome, null);
  assertEquals(guard.artifactsSinceCorrelate, 0);
  assertEquals(shouldSkipRedundantCorrelate().skip, false);
});

// ---- Wiring: the call sites, read off disk -------------------------------------
// The behavioural tests above prove the helpers are correct. These prove the
// SHIPPED code calls the right one in each place — the gap that let the defect
// reach main with a fully green suite. Same idiom as reviews_wiring_test.ts
// (which is why the edge suite needs --allow-read).

Deno.test("wiring: index.ts resets the whole RUN at request start", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(
    /resetCorrelateRun\(\)/.test(src),
    "index.ts must call resetCorrelateRun() at request start",
  );
  assert(
    !/^\s*resetCorrelateCycle\(\);/m.test(src),
    "index.ts must NOT use the mid-run cycle helper as its per-request reset",
  );
});

Deno.test("wiring: tool-registry.ts keeps the mid-run CYCLE reset after a correlate pass", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  assert(
    /resetCorrelateCycle\(\)/.test(src),
    "minimax_correlate's success path must keep resetting the cycle",
  );
  assert(
    !/resetCorrelateRun\(\)/.test(src),
    "the mid-run path must NOT clear lastCorrelateOutcome — that would disable the freshness gate",
  );
});
