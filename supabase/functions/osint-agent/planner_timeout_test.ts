// planner_timeout_test.ts — pins the minimax_plan_pivots timeout calibration.
//
// Production tool_usage_log (2026-07-30) showed 100% of this tool's recorded
// failures were our OWN wrapper firing (`exceeded 12000ms tool timeout`, n=12,
// avg 12,164ms) against a call whose real latency is 15-25s. It had no entry in
// TOOL_TIMEOUT_OVERRIDE_MS, so it inherited the 12s default — while its sibling
// minimax_correlate (same provider, same smart tier) sits at 60s.
//
// The failure mode is the one already documented for correlate: execute() does
// not forward the wrapper signal, so the model call completes anyway and the cap
// merely discards the finished plan. Regressing this to the default would not
// save time — it would resume throwing away completed work.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TOOL_TIMEOUT_OVERRIDE_MS, DEFAULT_TOOL_TIMEOUT_MS } from "./cache.ts";

Deno.test("minimax_plan_pivots has an explicit timeout override, not the 12s default", () => {
  const t = TOOL_TIMEOUT_OVERRIDE_MS["minimax_plan_pivots"];
  assert(typeof t === "number", "minimax_plan_pivots MUST have an explicit override");
  assert(
    t > DEFAULT_TOOL_TIMEOUT_MS,
    `override (${t}ms) must exceed the ${DEFAULT_TOOL_TIMEOUT_MS}ms default that was clipping it`,
  );
});

Deno.test("minimax_plan_pivots clears its observed production latency with headroom", () => {
  // Observed: daily averages 15.0-20.8s (7/25-7/28); slowest recorded success
  // 17,276ms; wrapper-timeout cluster at 12,164ms and a 20s tier at 20,269ms.
  const OBSERVED_SLOWEST_MS = 20_269;
  const t = TOOL_TIMEOUT_OVERRIDE_MS["minimax_plan_pivots"];
  assert(
    t >= OBSERVED_SLOWEST_MS * 2,
    `override (${t}ms) must leave real headroom over the observed tail (${OBSERVED_SLOWEST_MS}ms), ` +
    `or completed plans get binned as timeouts again`,
  );
});

Deno.test("minimax_plan_pivots stays at or below its correlate sibling", () => {
  // Both are smart-tier calls to the same provider. plan_pivots carries a
  // materially smaller payload (60/80 vs correlate's 200), so its cap should not
  // exceed correlate's — if it ever needs to, the payload cap is the thing that
  // drifted, not the timeout.
  const plan = TOOL_TIMEOUT_OVERRIDE_MS["minimax_plan_pivots"];
  const correlate = TOOL_TIMEOUT_OVERRIDE_MS["minimax_correlate"];
  assert(typeof correlate === "number", "correlate override is the calibration reference");
  assert(plan <= correlate, `plan_pivots (${plan}ms) must not exceed correlate (${correlate}ms)`);
});

Deno.test("minimax_plan_pivots payload stays bounded — the override's justification", () => {
  // The 45s cap is only defensible while the payload is capped. If these ceilings
  // are raised back toward 200, the latency tail grows and the timeout stops being
  // calibration. Read the live schema off disk so the test tracks the real source.
  const src = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));
  const block = src.slice(src.indexOf('memoSchema("minimax_plan_pivots"'));
  const decl = block.slice(0, 500);

  const queried = decl.match(/already_queried:\s*z\.array\(z\.string\(\)\)\.max\((\d+)\)/);
  const artifacts = decl.match(/\.max\((\d+)\)\)/);
  assert(queried, "already_queried cap not found — schema shape changed");
  assert(artifacts, "artifacts cap not found — schema shape changed");

  assertEquals(Number(queried[1]) <= 80, true, `already_queried cap ${queried[1]} exceeds 80`);
  assertEquals(Number(artifacts[1]) <= 60, true, `artifacts cap ${artifacts[1]} exceeds 60`);
});
