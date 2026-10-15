// E3 — a call refused only because its provider is busy waits its turn instead of being dropped.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  awaitProviderTurn,
  providerBusyQueueDisabled,
  providerBusyQueueSelfTest,
  PROVIDER_BUSY_MAX_WAIT_MS,
} from "../../../functions/osint-agent/lib/provider-busy-queue.ts";
import {
  clearProviderInFlight,
  clearThread,
  markCallInFlight,
  markProviderInFlight,
  recordResult,
  shouldRun,
} from "../../../functions/osint-agent/circuit.ts";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve(); }, advance: (ms: number) => { t += ms; } };
}

Deno.test("circuit marks the provider-busy refusal, and only that one", () => {
  const th = "t-busy-flag";
  clearThread(th);
  markProviderInFlight(th, "oathnet_lookup");
  const busy = shouldRun(th, "oathnet_lookup", "a@example.com");
  assertEquals(busy.allow, false);
  assertEquals(!busy.allow && busy.providerBusy, true);
  // an exact duplicate is NOT a busy refusal — it must never be waited on
  markCallInFlight(th, "oathnet_lookup", "b@example.com", "default");
  const dup = shouldRun(th, "oathnet_lookup", "b@example.com");
  assertEquals(!dup.allow && dup.duplicateInFlight, true);
  assertEquals(!dup.allow && dup.providerBusy, undefined);
  clearThread(th);
});

Deno.test("a busy sibling runs once the in-flight call returns (real circuit)", async () => {
  const th = "t-busy-runs";
  clearThread(th);
  markProviderInFlight(th, "oathnet_lookup");
  const clock = fakeClock();
  let ticks = 0;
  const turn = await awaitProviderTurn({
    initial: shouldRun(th, "oathnet_lookup", "second@example.com"),
    recheck: () => shouldRun(th, "oathnet_lookup", "second@example.com"),
    onTick: () => { if (++ticks === 3) clearProviderInFlight(th, "oathnet_lookup"); },
    now: clock.now,
    sleep: clock.sleep,
  });
  assertEquals(turn.decision.allow, true);
  assertEquals(turn.timedOut, false);
  assert(turn.waitedMs > 0);
  clearThread(th);
});

Deno.test("if the first call got the provider suppressed, the waiter is refused with THAT reason", async () => {
  const th = "t-busy-suppressed";
  clearThread(th);
  markProviderInFlight(th, "oathnet_lookup");
  const clock = fakeClock();
  const turn = await awaitProviderTurn({
    initial: shouldRun(th, "oathnet_lookup", "second@example.com"),
    recheck: () => shouldRun(th, "oathnet_lookup", "second@example.com"),
    onTick: () => {
      recordResult(th, "oathnet_lookup", "first@example.com", "", { status: "http_429" });
      clearProviderInFlight(th, "oathnet_lookup");
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  assertEquals(turn.decision.allow, false);
  assertEquals(!turn.decision.allow && turn.decision.providerBusy, undefined, "the refusal is the suppression, not busy");
  assertEquals(turn.timedOut, false);
  clearThread(th);
});

Deno.test("the wait is bounded", async () => {
  const clock = fakeClock();
  const turn = await awaitProviderTurn({
    initial: { allow: false, providerBusy: true },
    recheck: () => ({ allow: false, providerBusy: true }),
    now: clock.now,
    sleep: clock.sleep,
  });
  assertEquals(turn.timedOut, true);
  assert(turn.waitedMs >= PROVIDER_BUSY_MAX_WAIT_MS && turn.waitedMs < PROVIDER_BUSY_MAX_WAIT_MS + 1000);
});

Deno.test("the wait stops when the finalize window opens", async () => {
  const clock = fakeClock();
  let stop = false;
  let rechecks = 0;
  const turn = await awaitProviderTurn({
    initial: { allow: false, providerBusy: true },
    recheck: () => { if (++rechecks === 2) stop = true; return { allow: false, providerBusy: true }; },
    shouldStop: () => stop,
    now: clock.now,
    sleep: clock.sleep,
  });
  assertEquals(rechecks, 2);
  assert(turn.waitedMs < 1000);
});

Deno.test("never waits on a non-busy refusal, and the kill switch skips at once", async () => {
  let rechecks = 0;
  const recheck = () => { rechecks++; return { allow: true }; };
  const a = await awaitProviderTurn({ initial: { allow: false, reason: "backoff" }, recheck });
  const b = await awaitProviderTurn({ initial: { allow: false, providerBusy: true }, recheck, disabled: true });
  assertEquals([a.waitedMs, b.waitedMs, rechecks], [0, 0, 0]);
  assertEquals(b.decision.allow, false);
});

Deno.test("kill switch parses only an explicit true", () => {
  assertEquals(providerBusyQueueDisabled(() => "true"), true);
  assertEquals(providerBusyQueueDisabled(() => " TRUE "), true);
  assertEquals(providerBusyQueueDisabled(() => "1"), false);
  assertEquals(providerBusyQueueDisabled(() => undefined), false);
});

Deno.test("/health self-test passes", async () => {
  const r = await providerBusyQueueSelfTest();
  assertEquals(r.ok, true, r.detail);
});
