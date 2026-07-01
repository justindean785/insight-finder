// scheduler_health_test.ts — Phase 2 (latency/reliability-aware scheduler) tests.
//
//  T2: scoreExpectedValue ranks a slow + unreliable tool BELOW a fast + reliable
//      one at equal price tier; the health prior degrades to NEUTRAL below the
//      sample floor (no noise penalty on a low-sample tool); manual_override
//      bypasses the reliability suppression.
//  T3: the per-tool wrapper timeout RESOLVES with a schema-safe error result
//      (never throws), passes a fast tool's real result through, and still lets a
//      genuine pre-timeout rejection propagate (handled by the wrapper's catch).
//
// Resilience/perf-only — touches no evidence-integrity logic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreExpectedValue, HEALTH_MIN_SAMPLES } from "./runtime-policy.ts";
import { runWithToolTimeout } from "./cache.ts";

// Identical non-health inputs at EQUAL price tier — only the health signal varies.
const base = { selectorConfidence: 90, costPenalty: 8 } as const;

Deno.test("Phase 2 (T2): a slow, unreliable tool scores below a fast, reliable one at equal price tier", () => {
  const fastReliable = scoreExpectedValue({
    ...base,
    p95DurationMs: 200,
    reliability: 0.99,
    healthSampleSize: 120,
  });
  const slowUnreliable = scoreExpectedValue({
    ...base,
    p95DurationMs: 30_000, // >15s → large latency penalty
    reliability: 0.19, //     <40% → strong reliability suppression
    healthSampleSize: 120,
  });
  assert(
    slowUnreliable < fastReliable,
    `slow+unreliable (${slowUnreliable}) must score below fast+reliable (${fastReliable})`,
  );
  assert(fastReliable - slowUnreliable >= 60, "the demotion must be meaningful, not marginal");
});

Deno.test("Phase 2 (T2): the health prior is NEUTRAL below the sample floor (no noise penalty)", () => {
  const neutralNoHealth = scoreExpectedValue({ ...base }); // no health signal at all
  const lowSampleSlowUnreliable = scoreExpectedValue({
    ...base,
    p95DurationMs: 30_000,
    reliability: 0.19,
    healthSampleSize: HEALTH_MIN_SAMPLES - 1, // below the floor → must stay neutral
  });
  assertEquals(
    lowSampleSlowUnreliable,
    neutralNoHealth,
    "below the sample floor a slow/unreliable tool must NOT be penalized (2-call/1-fail ≠ 50% reliable)",
  );
  // Sanity: with just enough samples the SAME signals DO suppress.
  const highSample = scoreExpectedValue({
    ...base,
    p95DurationMs: 30_000,
    reliability: 0.19,
    healthSampleSize: HEALTH_MIN_SAMPLES,
  });
  assert(highSample < lowSampleSlowUnreliable, "at/above the floor the penalty engages");
});

Deno.test("Phase 2 (T2): manual_override bypasses the reliability suppression", () => {
  const suppressed = scoreExpectedValue({ ...base, reliability: 0.1, healthSampleSize: 100 });
  const overridden = scoreExpectedValue({
    ...base,
    reliability: 0.1,
    healthSampleSize: 100,
    manualOverride: true,
  });
  assert(overridden > suppressed, "manual override must lift the reliability penalty (analyst forced it)");
});

Deno.test("Phase 2 (T3): a tool timeout returns a schema-safe result, not a throw", async () => {
  const hang = () => new Promise<never>(() => {}); // never settles → hits the timeout
  const res = (await runWithToolTimeout("slow_tool", hang, 20)) as Record<string, unknown>;
  assertEquals(res.ok, false);
  assertEquals(res._tool_timeout, true);
  assertEquals(res._tool_error, true);
  assert(typeof res.error === "string" && (res.error as string).includes("timeout"));
});

Deno.test("Phase 2 (T3): a fast tool's real result passes through untouched", async () => {
  const fast = () => Promise.resolve({ ok: true, data: 42 });
  const res = (await runWithToolTimeout("fast_tool", fast, 1000)) as Record<string, unknown>;
  assertEquals(res.ok, true);
  assertEquals(res.data, 42);
});

Deno.test("Phase 2 (T3): a genuine pre-timeout rejection still propagates (the wrapper's catch makes it schema-safe)", async () => {
  const boom = () => Promise.reject(new Error("upstream 500"));
  let threw = false;
  try {
    await runWithToolTimeout("err_tool", boom, 1000);
  } catch (e) {
    threw = true;
    assert(String(e).includes("upstream 500"));
  }
  assert(threw, "a real rejection before the cap must propagate to the wrapper's catch (→ schema-safe result)");
});
