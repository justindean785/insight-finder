/**
 * paid_call_accounting_test.ts — the paid-call cap must measure SPEND, not admission.
 *
 * WHAT THE CAP IS FOR (repository evidence, runtime-policy.ts ~line 213):
 *   "Production consequence: a single investigation ran 262 tool calls and COST
 *    $3.05 against a documented ceiling of 30 calls / 12 paid."
 * `costTier` itself is derived from `TOOL_COSTS_MICRO_USD` — `costTierForTool`
 * maps micro-USD to free/low/expensive. The paid cap is a MONEY control.
 *
 * THE DEFECT
 * `startCall` increments `state.paidCalls` at ADMISSION, before `execute()` runs.
 * A tool that declines its selector inside `execute()` — the Indicia unusable-phone
 * gate (#426), a guard `skipStub` — issues ZERO provider requests and spends
 * ZERO, yet permanently consumes one of the 12 slots. The clean
 * budget-exhaustion fixture reaches that ceiling, so wasted slots truncate real
 * investigations.
 *
 * WHY NOT "REFUND EVERY skipped"
 * `skipped` does NOT imply "no provider request". `tool-outcome.ts`'s SKIP_RE
 * also matches `rate-limited — provider`, `5xx — provider`, and
 * `provider … suppressed` — all of which mean a request WAS issued and may have
 * been billed. `cache.ts:tagSkipState` additionally sets `skipped: true` on
 * TIMEOUTS, which are the most expensive requests of all. Refunding on the
 * outcome bucket would hand back slots for work that really did spend.
 *
 * WHY NOT "COUNT PROVIDER REQUESTS"
 * One admitted tool call is not one provider request: `fetchRetry(..., {retries:1})`
 * retries internally, serus polls to completion, and the stolen.tax wrapper fans
 * out to three endpoints in parallel. A per-request counter is unmeasurable
 * without instrumenting ~70 tools. The honest unit is the TOOL-LEVEL PAID
 * ATTEMPT: one slot per call that actually reached a paid provider at least once.
 *
 * THE CONTRACT PINNED HERE
 *   A paid slot is consumed unless the tool proves it never contacted the
 *   provider, by returning the structural marker `provider_attempted: false`.
 *   STRUCTURAL ONLY — no string sniffing (this codebase has been burned by
 *   substring predicates). Absent marker ⇒ charge. Fails closed toward charging,
 *   which is the safe direction for a cost cap.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clearRuntime,
  isPreProviderGate,
  refundPaidCall,
  runtimeLimits,
  startCall,
} from "./runtime-policy.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";

const DEFAULT_LIMITS = { ...runtimeLimits };
const restoreLimits = () => Object.assign(runtimeLimits, DEFAULT_LIMITS);
const noWeakLead = { weak: false, reasons: [] as string[], autoPivotBlocked: false };

function paidCall(threadId: string, overrides: Record<string, unknown> = {}) {
  return startCall({
    threadId,
    toolName: "indicia_phone",
    selector: "5550100123",
    selectorType: "phone",
    costTier: "expensive" as const,
    expectedValue: 80,
    familyKey: "indicia_phone::phone::5550100123",
    weakLead: noWeakLead,
    staleCache: false,
    manualOverride: false,
    now: 1_000_000,
    ...overrides,
  } as Parameters<typeof startCall>[0]);
}

// ---- 1. The marker is structural, and only structural ----------------------

Deno.test("isPreProviderGate: only an explicit provider_attempted:false counts", () => {
  assert(isPreProviderGate({ ok: false, provider_attempted: false, error: "gated" }));
  assert(!isPreProviderGate({ ok: false, error: "gated — unusable selector" }), "no string sniffing");
  assert(!isPreProviderGate({ ok: false, skipped: true }), "skipped alone proves nothing");
  assert(!isPreProviderGate({ ok: true }), "a success attempted the provider");
  assert(!isPreProviderGate(null), "absent output charges — fail closed");
  assert(!isPreProviderGate({ provider_attempted: "false" }), "a string is not the marker");
});

Deno.test("isPreProviderGate: a post-provider skip is NOT a pre-provider gate", () => {
  // Every one of these is `skipped` per tool-outcome.ts, and every one of them
  // issued a real request that may have been billed.
  for (const out of [
    { ok: false, skipped: true, error: "429 rate-limited — provider indicia suppressed for investigation" },
    { ok: false, skipped: true, error: "5xx — provider degraded this run" },
    { ok: false, skipped: true, error: "tool timed out after 18000ms" },
  ]) {
    assert(!isPreProviderGate(out), `must still be charged: ${out.error}`);
  }
});

// ---- 2. A zero-request gate does not consume the budget --------------------

Deno.test("a pre-provider gate does not consume a paid slot", () => {
  const t = "t-paid-gate";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 2;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    // Two admitted-then-gated calls: each reached execute(), issued no request.
    for (let i = 0; i < 2; i++) {
      assertEquals(paidCall(t).allow, true);
      refundPaidCall(t, "expensive");
    }
    // The budget was never spent, so a genuine paid call is still admitted.
    assertEquals(
      paidCall(t).allow,
      true,
      "THE BUG: gated selectors that never reached a provider consumed the cost budget",
    );
  } finally {
    restoreLimits();
  }
});

// ---- 3. Real paid attempts still consume ------------------------------------

Deno.test("real paid executions still consume the budget", () => {
  const t = "t-paid-real";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 2;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    assertEquals(paidCall(t).allow, true, "1st paid execution");
    assertEquals(paidCall(t).allow, true, "2nd paid execution");
    const third = paidCall(t);
    assertEquals(third.allow, false, "the cap must still bite on genuine spend");
    assert(
      !third.allow && /paid-call cap reached/i.test(third.reason),
      "and say so honestly",
    );
  } finally {
    restoreLimits();
  }
});

Deno.test("a provider failure is charged — failures cannot become free retries", () => {
  const t = "t-paid-fail";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 2;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    // Two calls that reached the provider and failed. Nothing refunds them,
    // because a failed request still issued a request.
    for (const failure of [
      { ok: false, error: "HTTP 500 from provider" },
      { ok: false, skipped: true, error: "429 rate-limited — provider suppressed for investigation" },
    ]) {
      assertEquals(paidCall(t).allow, true);
      if (isPreProviderGate(failure)) refundPaidCall(t, "expensive");
    }
    assertEquals(
      paidCall(t).allow,
      false,
      "a retry loop on provider failures must not be able to spend forever",
    );
  } finally {
    restoreLimits();
  }
});

Deno.test("an empty result is charged — the request happened", () => {
  const t = "t-paid-empty";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 1;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    assertEquals(paidCall(t).allow, true);
    const empty = { ok: true, empty: true, note: "no usable result" };
    if (isPreProviderGate(empty)) refundPaidCall(t, "expensive");
    assertEquals(paidCall(t).allow, false, "an empty lookup still cost money");
  } finally {
    restoreLimits();
  }
});

// ---- 4. Refund safety -------------------------------------------------------

Deno.test("refunding a FREE tool never touches the paid counter", () => {
  const t = "t-paid-free";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 1;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    refundPaidCall(t, "free");
    refundPaidCall(t, "free");
    assertEquals(paidCall(t).allow, true, "the free path must not mint paid credit");
    assertEquals(paidCall(t).allow, false, "…and the cap still holds at 1");
  } finally {
    restoreLimits();
  }
});

Deno.test("refund never underflows into extra budget", () => {
  const t = "t-paid-underflow";
  clearRuntime(t);
  runtimeLimits.maxPaidCallsPerRun = 1;
  runtimeLimits.stopOnBudgetExhausted = true;
  try {
    // Five refunds with nothing spent must not create five free slots.
    for (let i = 0; i < 5; i++) refundPaidCall(t, "expensive");
    assertEquals(paidCall(t).allow, true, "first genuine call");
    assertEquals(paidCall(t).allow, false, "cap still 1 — refunds cannot mint budget");
  } finally {
    restoreLimits();
  }
});

// ---- 5. Telemetry parity ----------------------------------------------------

Deno.test("an internal cap refusal is classified skipped, not a provider failure", () => {
  // These are the exact strings startCall returns. tool-outcome.ts exists to keep
  // governance throttles out of the failure rate — and circuit.ts treats a
  // `failed` outcome as a consecutive provider failure, so a run that hits its
  // OWN budget could trip the provider circuit breaker.
  for (const reason of [
    "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
    "internal run cap reached (30 calls this investigation) — internal throttle, not a provider limit",
    "internal per-tool cap reached (exa_search ran 16× this run) — vary the selector or choose another pivot; internal throttle, not a provider limit",
  ]) {
    assertEquals(
      classifyToolOutcome(reason, null),
      "skipped",
      `an internal throttle is not a provider failure: ${reason.slice(0, 40)}`,
    );
  }
});
