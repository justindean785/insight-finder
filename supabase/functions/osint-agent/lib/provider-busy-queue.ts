// provider-busy-queue.ts — E3: wait for a busy provider instead of dropping the call.
//
// THE DEFECT. `circuit.shouldRun` refuses a call when another call to the SAME
// provider is already executing ("provider 'X' already has a call in-flight —
// waiting for its result"). That gate exists to stop a same-step parallel burst
// racing past a paid provider's 401/429 suppression, and it is right to stop the
// race. But the wrapper then returned a SKIP, so the sibling call was simply lost:
// measured 2026-10-15 over 30 days, ~230 calls in 60+ cases (oathnet_lookup 34,
// minimax_web_search 26, serus_darkweb_scan 22, rapidapi_breach_search 21,
// breach_check 19, ip_intel 18, ...). The sibling was a DIFFERENT selector — a
// second email, a second phone — not a duplicate (exact duplicates have their own
// `duplicateInFlight` refusal, which this module never waits on).
//
// THE FIX. Serialize instead of drop: wait for the in-flight call to clear, then
// ask `shouldRun` again. The re-check is the whole safety argument — if the first
// call came back 401/429 and suppressed the provider, the re-check refuses with
// THAT reason, so the burst protection is unchanged; only the healthy case now
// runs instead of vanishing.
//
// BOUNDS. The wait never outlives MAX_WAIT_MS, stops the moment the finalize
// window opens (`shouldStop`), and re-checks on a short tick so several waiters
// take turns rather than all firing on release (JS is single-threaded and the
// wrapper marks the provider in-flight synchronously after an allow, so exactly
// one waiter wins each release). It never waits on anything except a busy
// provider: suppression, backoff, dedup and duplicates return immediately.
//
// KILL SWITCH, read at call time: PROVIDER_BUSY_QUEUE_DISABLED=true restores the
// immediate skip. /health proof key: checks.provider_busy_queue.

export const PROVIDER_BUSY_MAX_WAIT_MS = 20_000;
export const PROVIDER_BUSY_TICK_MS = 250;

export function providerBusyQueueDisabled(env: (k: string) => string | undefined = readEnv): boolean {
  return (env("PROVIDER_BUSY_QUEUE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

function readEnv(k: string): string | undefined {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
}

export type BusyAwareDecision = { allow: boolean; providerBusy?: boolean; reason?: string };

export interface AwaitProviderTurnOpts<D extends BusyAwareDecision> {
  /** First decision, already computed by the caller. */
  initial: D;
  /** Re-run the gate. Must be synchronous with the caller's in-flight mark. */
  recheck: () => D;
  /** True once the run must stop starting live lookups (finalize window, or the step was aborted).
   *  Checked before every tick AND once more after the wait, so a call the gate allows on the
   *  tick the finalize window opened is still refused. */
  shouldStop?: () => boolean;
  /** Keep the run's liveness heartbeat fresh while waiting. */
  onTick?: () => void;
  maxWaitMs?: number;
  tickMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  disabled?: boolean;
}

export interface ProviderTurnResult<D> {
  decision: D;
  /** ms spent waiting; 0 when no wait happened. */
  waitedMs: number;
  /** Set when the call waited and the final decision is still a busy refusal. */
  timedOut: boolean;
  /** Set when the call waited and `shouldStop` turned true: the caller must NOT run it,
   *  even if `decision.allow` is true. */
  stopped: boolean;
}

/** Wait (bounded) while the ONLY reason for refusal is a busy provider. */
export async function awaitProviderTurn<D extends BusyAwareDecision>(
  o: AwaitProviderTurnOpts<D>,
): Promise<ProviderTurnResult<D>> {
  let decision = o.initial;
  if (decision.allow || !decision.providerBusy || o.disabled) {
    return { decision, waitedMs: 0, timedOut: false, stopped: false };
  }
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = o.maxWaitMs ?? PROVIDER_BUSY_MAX_WAIT_MS;
  const tick = o.tickMs ?? PROVIDER_BUSY_TICK_MS;
  const start = now();
  while (!decision.allow && decision.providerBusy) {
    if (now() - start >= maxWait) break;
    if (o.shouldStop?.()) break;
    await sleep(tick);
    o.onTick?.();
    decision = o.recheck();
  }
  const waitedMs = now() - start;
  // Re-check AFTER the wait: the loop tests shouldStop before each sleep, so without this a
  // call allowed on the very tick the finalize window opened (or the step aborted) would run.
  const stopped = !!o.shouldStop?.();
  return { decision, waitedMs, timedOut: !stopped && !decision.allow && !!decision.providerBusy, stopped };
}

/** /health → checks.provider_busy_queue. Pure; presence proves this build. */
export async function providerBusyQueueSelfTest(): Promise<{ ok: boolean; switch: string; detail: string }> {
  const sw = "PROVIDER_BUSY_QUEUE_DISABLED";
  if (providerBusyQueueDisabled()) {
    return { ok: true, switch: `${sw}=true`, detail: "LEGACY via PROVIDER_BUSY_QUEUE_DISABLED: a busy provider skips the call" };
  }
  const wrong: string[] = [];
  let t = 0;
  const clock = { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve(); } };
  // busy, then clears → runs
  let n = 0;
  const a = await awaitProviderTurn<BusyAwareDecision>({
    initial: { allow: false, providerBusy: true },
    recheck: () => (++n >= 2 ? { allow: true } : { allow: false, providerBusy: true }),
    ...clock,
  });
  if (!a.decision.allow) wrong.push("did not run after the provider cleared");
  // busy, then suppressed → refusal carries the suppression, no further wait
  t = 0;
  const b = await awaitProviderTurn<BusyAwareDecision>({
    initial: { allow: false, providerBusy: true },
    recheck: () => ({ allow: false, reason: "provider suppressed" }),
    ...clock,
  });
  if (b.decision.allow || b.decision.reason !== "provider suppressed") wrong.push("suppression after the wait not honoured");
  // never clears → bounded
  t = 0;
  const c = await awaitProviderTurn<BusyAwareDecision>({ initial: { allow: false, providerBusy: true }, recheck: () => ({ allow: false, providerBusy: true }), ...clock });
  if (!c.timedOut || c.waitedMs > PROVIDER_BUSY_MAX_WAIT_MS + PROVIDER_BUSY_TICK_MS) wrong.push("wait was not bounded");
  // finalize window opens during the last tick, gate then allows → must still be stopped
  t = 0;
  let open = false;
  const d = await awaitProviderTurn<BusyAwareDecision>({
    initial: { allow: false, providerBusy: true },
    recheck: () => { open = true; return { allow: true }; },
    shouldStop: () => open,
    ...clock,
  });
  if (!d.stopped) wrong.push("a call allowed as the finalize window opened was not stopped");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: `a call refused only because its provider is busy waits (≤${PROVIDER_BUSY_MAX_WAIT_MS / 1000}s, never into the finalize window) and re-checks the gate instead of being dropped; finalize/abort stop it, including on the tick it would run`,
    };
}
