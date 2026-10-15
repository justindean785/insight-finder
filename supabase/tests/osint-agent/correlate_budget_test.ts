// correlate_budget_test.ts — a hard per-run ceiling on LIVE minimax_correlate
// dispatches, covering the path the freshness gate deliberately does not.
//
// `shouldSkipRedundantCorrelate` keys on `lastCorrelateOutcome === "ok"` and its
// own comment says it "never blocks the run's first correlate call or a retry
// after a failed one". So the FAILURE path was unbounded, and each attempt can
// hold a step open for the full 60s wrapper cap.
//
// Measured 2026-09-09..12: 30 correlate calls, 696s — 40% of ALL tool wall time
// — 23.2s average, 46.2s max, ZERO cache hits. Two runs account for 387s of it:
// d4873abc spent 206s over 7 calls, ba58d6fd 181s over 8.
//
// These drive the exported guard predicates that `cache.ts` consults, and the
// wiring test below asserts the call sites exist, so the budget cannot be left
// defined-but-unread (the failure mode `artifactsSinceCorrelate` already had
// once — "the counter was maintained but never READ").
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  guard,
  MAX_CORRELATE_CALLS_PER_RUN,
  correlateBudgetExhausted,
  correlateBudgetReason,
  bumpCorrelateCall,
  resetCorrelateRun,
  resetCorrelateCycle,
} from "../../functions/osint-agent/guard.ts";

function freshRun() {
  resetCorrelateRun();
}

Deno.test("a fresh run has its full correlate budget", () => {
  freshRun();
  assertEquals(guard.correlateCalls, 0);
  assertEquals(correlateBudgetExhausted(), false);
});

Deno.test("the budget admits exactly MAX_CORRELATE_CALLS_PER_RUN attempts", () => {
  freshRun();
  for (let i = 0; i < MAX_CORRELATE_CALLS_PER_RUN; i++) {
    assertEquals(correlateBudgetExhausted(), false, `attempt ${i + 1} must be admitted`);
    bumpCorrelateCall();
  }
  assertEquals(correlateBudgetExhausted(), true, "the attempt after the budget must be refused");
});

Deno.test("⛔ the production shape: 7 and 8 attempts in one run are bounded to 2", () => {
  for (const attempts of [7, 8]) {
    freshRun();
    let admitted = 0;
    for (let i = 0; i < attempts; i++) {
      if (correlateBudgetExhausted()) continue;
      admitted++;
      bumpCorrelateCall();
    }
    assertEquals(admitted, MAX_CORRELATE_CALLS_PER_RUN, `${attempts} attempts admitted ${admitted}`);
  }
});

Deno.test("the budget counts ATTEMPTS, not successes — a failing correlate still spends it", () => {
  freshRun();
  // A failed attempt leaves lastCorrelateOutcome "failed", which is exactly the
  // state the freshness gate refuses to block on. The budget must still count it.
  bumpCorrelateCall();
  guard.lastCorrelateOutcome = "failed";
  bumpCorrelateCall();
  guard.lastCorrelateOutcome = "failed";
  assertEquals(correlateBudgetExhausted(), true);
});

Deno.test("a mid-run cycle reset does NOT refund the budget", () => {
  // resetCorrelateCycle fires on every successful correlate and on new evidence.
  // If it cleared the counter the ceiling would be unreachable.
  freshRun();
  bumpCorrelateCall();
  bumpCorrelateCall();
  resetCorrelateCycle();
  assertEquals(correlateBudgetExhausted(), true, "the cycle reset must not refund correlate calls");
});

Deno.test("resetCorrelateRun DOES refund it — a warm isolate must not starve the next run", () => {
  // `guard` is module-scoped and survives across requests on a warm isolate.
  freshRun();
  bumpCorrelateCall();
  bumpCorrelateCall();
  assertEquals(correlateBudgetExhausted(), true);
  resetCorrelateRun();
  assertEquals(correlateBudgetExhausted(), false, "Run B must get its own budget");
  assertEquals(guard.correlateCalls, 0);
});

Deno.test("the refusal reason tells the model to stop and names the fallback", () => {
  freshRun();
  bumpCorrelateCall();
  bumpCorrelateCall();
  const reason = correlateBudgetReason();
  // A refusal must be legible as a refusal, and must not read as a transient
  // error the model should retry through.
  assertStringIncludes(reason, "Do not call minimax_correlate again");
  assertStringIncludes(reason, String(MAX_CORRELATE_CALLS_PER_RUN));
  assertStringIncludes(reason, "lib/cluster.ts");
});

Deno.test("cache.ts WIRES the budget: refusal before the freshness gate, spend at admission", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/cache.ts", import.meta.url));
  assert(src.includes("correlateBudgetExhausted()"), "cache.ts must consult the budget");
  assert(src.includes("bumpCorrelateCall()"), "cache.ts must spend the budget");
  assert(src.includes("correlate_budget_spent"), "the refusal must be labelled in telemetry");

  // Order matters: the budget refusal is free only if it precedes the freshness
  // gate, the tool-call cap, the circuit and the paid-call reservation.
  const budgetAt = src.indexOf("correlateBudgetExhausted()");
  const freshnessAt = src.indexOf("shouldSkipRedundantCorrelate()");
  assert(budgetAt > 0 && freshnessAt > 0);
  assert(budgetAt < freshnessAt, "the budget check must run BEFORE the freshness gate");

  // Spend at admission, not completion: a timed-out attempt never reaches the
  // completion handlers, and it is precisely the attempt the budget bounds.
  const spendAt = src.indexOf("bumpCorrelateCall()");
  const outcomeAt = src.indexOf('guard.lastCorrelateOutcome = ok ? "ok" : "failed"');
  assert(spendAt > 0 && outcomeAt > 0);
  assert(spendAt < outcomeAt, "the budget must be spent at dispatch, before the outcome is known");
});
