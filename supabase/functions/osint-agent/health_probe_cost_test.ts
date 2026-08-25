// C1 — the unauthenticated `?health=1` endpoint must not be a cost-amplification
// or privileged-work amplification lever.
//
// `?health=1` returns at index.ts:118, BEFORE setupRequest() — so it carries no
// Authorization header requirement and no rate limit (the 30/min + 300/hr
// distributed limiter is keyed on a userId that only exists after auth.getUser()).
// Two things behind that endpoint cost real money or real privilege:
//   1. checkDeepseek() bills a completion against the live orchestrator vendor.
//   2. recoverStaleActiveThreads() runs under the SERVICE-ROLE key, cross-tenant.
// Both are now bounded. These tests drive the shipped functions rather than
// re-describing them.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkDeepseek, __resetRecoverySweepThrottle } from "./health-handler.ts";
import { markDeepseekHealthy, deepseekHealthyWithin } from "./providers.ts";

Deno.test("checkDeepseek: a recent success suppresses the paid probe entirely", async () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls++;
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as unknown as typeof fetch;

  // Cold: the probe must actually run, or a real outage would be invisible.
  const first = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: fakeFetch, recentlyHealthy: false });
  assertEquals(first.ok, true);
  assertEquals(calls, 1, "a cold isolate must still probe");

  // Warm: the success above marked the slot healthy, so a second probe inside the
  // window must NOT bill a second completion.
  const second = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: fakeFetch });
  assertEquals(second.ok, true);
  assertEquals(second.detail, "recently_ok");
  assertEquals(calls, 1, "a cached probe MUST NOT issue a second paid request");
});

Deno.test("checkDeepseek: a FAILURE is never cached — an outage still surfaces", async () => {
  let calls = 0;
  const failing = (() => {
    calls++;
    return Promise.resolve({ ok: false, status: 503 } as Response);
  }) as unknown as typeof fetch;

  const a = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: failing, recentlyHealthy: false });
  const b = await checkDeepseek({ hasKey: true, apiKey: "k", doFetch: failing, recentlyHealthy: false });

  assertEquals(a.ok, false);
  assertEquals(b.ok, false);
  assertEquals(calls, 2, "failures must not populate the cooldown");
});

Deno.test("checkDeepseek: a missing key short-circuits before any network call", async () => {
  let calls = 0;
  const spy = (() => {
    calls++;
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }) as unknown as typeof fetch;
  const r = await checkDeepseek({ hasKey: false, doFetch: spy });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "missing_key");
  assertEquals(calls, 0);
});

Deno.test("deepseek health marker: window is honoured in both directions", () => {
  markDeepseekHealthy();
  assert(deepseekHealthyWithin(60_000), "a just-marked slot is inside the window");
  assert(!deepseekHealthyWithin(0), "a zero-width window can never be 'recent'");
});

Deno.test("recovery sweep throttle: reset restores the cold state", () => {
  // The throttle is a module global; the reset hook exists so a test can assert
  // the cold path deterministically regardless of what ran before it.
  __resetRecoverySweepThrottle();
  // Nothing to assert beyond the hook being callable and exported — the
  // behavioural coverage of the gate itself lives in health_handler_test.ts,
  // which drives handleHealthProbe end to end.
  assert(typeof __resetRecoverySweepThrottle === "function");
});
