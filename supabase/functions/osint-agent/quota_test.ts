// Namespaced hourly quota — used by evidence-export, whose PDF/zip build is the
// most CPU-expensive path this project exposes and previously had NO limiter of
// any kind (the orchestrator's 30/min + 300/hr is keyed on its own counters and
// never applied to that function).
//
// Two properties matter and are easy to get wrong:
//   - namespaces must not bleed, or an export would consume orchestrator budget
//   - it must FAIL OPEN, matching checkRateLimit — a Redis outage must not stop
//     a user exporting their own evidence.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { inMemoryQuotaCheck, _resetQuotaForTests, checkHourlyQuota } from "./ratelimit.ts";

Deno.test("quota: allows exactly the cap, then blocks", () => {
  _resetQuotaForTests();
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 10; i++) {
    const d = inMemoryQuotaCheck("evidence-export", "u1", 10, now);
    assert(d.ok, `call ${i} of 10 should be allowed, got ${JSON.stringify(d)}`);
  }
  const over = inMemoryQuotaCheck("evidence-export", "u1", 10, now);
  assertEquals(over.ok, false, "the 11th call must be blocked");
  if (!over.ok) assertEquals(over.retryAfterSec, 3600);
});

Deno.test("quota: namespaces are isolated", () => {
  _resetQuotaForTests();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) inMemoryQuotaCheck("evidence-export", "u1", 10, now);
  assertEquals(inMemoryQuotaCheck("evidence-export", "u1", 10, now).ok, false, "exhausted in its own namespace");
  assert(
    inMemoryQuotaCheck("some-other-job", "u1", 10, now).ok,
    "a different namespace must have its own budget for the same user",
  );
});

Deno.test("quota: users are isolated", () => {
  _resetQuotaForTests();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) inMemoryQuotaCheck("evidence-export", "u1", 10, now);
  assertEquals(inMemoryQuotaCheck("evidence-export", "u1", 10, now).ok, false);
  assert(inMemoryQuotaCheck("evidence-export", "u2", 10, now).ok, "u2 must not inherit u1's usage");
});

Deno.test("quota: the window rolls — usage an hour old no longer counts", () => {
  _resetQuotaForTests();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) inMemoryQuotaCheck("evidence-export", "u1", 10, t0);
  assertEquals(inMemoryQuotaCheck("evidence-export", "u1", 10, t0).ok, false, "exhausted at t0");

  const later = t0 + 3_600_001; // just past the hour
  assert(inMemoryQuotaCheck("evidence-export", "u1", 10, later).ok, "the window must roll off");
});

Deno.test("quota: FAILS OPEN when Upstash is unconfigured", async () => {
  // No UPSTASH_* env in the test environment, so this takes the fallback path
  // rather than throwing or denying. Denying here would mean a Redis outage
  // blocks users from exporting their own evidence.
  _resetQuotaForTests();
  const d = await checkHourlyQuota("evidence-export", "u-failopen", 10);
  assert(d.ok, `an unconfigured limiter must allow, got ${JSON.stringify(d)}`);
});

Deno.test("quota: reported usage climbs with each consumed unit", () => {
  _resetQuotaForTests();
  const now = 1_700_000_000_000;
  assertEquals(inMemoryQuotaCheck("ns", "u", 5, now).used, 1);
  assertEquals(inMemoryQuotaCheck("ns", "u", 5, now).used, 2);
  assertEquals(inMemoryQuotaCheck("ns", "u", 5, now).used, 3);
});
