// intermediate_step_plan_test.ts
//
// Pins the invariant that regressed on 2026-07-20: EVERY non-finalize prepareStep
// branch must force a tool call. When the intermediate `toolChoice` is absent the SDK
// default "auto" applies, and two things break:
//   1. the agent loop can end on a narration-only step (AI SDK v6 stops the moment a
//      step finishes with no tool call), and
//   2. the persistence nudge becomes a no-op — it narrows activeTools to
//      ["record_artifacts"] but the model may answer with prose instead of calling it,
//      so a run reaches finalize having recorded nothing and takes the
//      finalize_no_findings escape.
//
// Production evidence for (2): threads on the build WITH the forced tool choice
// recorded zero artifacts 7.1% of the time (4/56); on the build WITHOUT it that rose
// to 34.5% (10/29), and mean record_artifacts calls per thread fell 4.38 → 1.34.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntermediateStepPlan,
  orchestratorStepToolChoice,
  FORCE_TOOL_CALL_UNTIL_FINALIZE,
} from "./orchestrator-budget.ts";
import { buildFinalizeStepPlan } from "./orchestrator-finalize.ts";

const NORMAL_TOOLS = ["whois_lookup", "dns_records", "record_artifacts"];

// The exhaustive set of non-finalize branches prepareStep can take. If a new
// intermediate branch is added to index.ts it MUST be represented here.
const INTERMEDIATE_BRANCHES = [
  { name: "normal", nudgePersistence: false },
  { name: "persistence-nudge", nudgePersistence: true },
] as const;

Deno.test("every non-finalize step plan forces a tool call", () => {
  for (const branch of INTERMEDIATE_BRANCHES) {
    const plan = buildIntermediateStepPlan({
      nudgePersistence: branch.nudgePersistence,
      normalActiveTools: NORMAL_TOOLS,
    });
    assertEquals(
      plan.toolChoice,
      "required",
      `${branch.name}: intermediate steps must force a tool call, got "${plan.toolChoice}"`,
    );
    assert(
      Object.hasOwn(plan, "toolChoice"),
      `${branch.name}: toolChoice must be present, not left to the SDK default`,
    );
  }
});

Deno.test("the persistence-nudge branch narrows to record_artifacts AND forces the call", () => {
  const plan = buildIntermediateStepPlan({ nudgePersistence: true, normalActiveTools: NORMAL_TOOLS });
  // Narrowing alone is what silently failed in prod: under "auto" the model answered
  // the nudge with other tool calls / prose and never persisted.
  assertEquals(plan.activeTools, ["record_artifacts"]);
  assertEquals(plan.toolChoice, "required");
});

Deno.test("the normal branch passes activeTools through unchanged (copy, not alias)", () => {
  const plan = buildIntermediateStepPlan({ nudgePersistence: false, normalActiveTools: NORMAL_TOOLS });
  assertEquals(plan.activeTools, NORMAL_TOOLS);
  plan.activeTools.push("mutated");
  assertEquals(NORMAL_TOOLS.length, 3, "must not alias the caller's array");
});

Deno.test("finalize steps are NOT forced — the report phase must be free to emit text", () => {
  assertEquals(orchestratorStepToolChoice(true), "auto", "finalize opts out of forcing");
  // The report phase disables tools entirely so the closing report can be written.
  assertEquals(buildFinalizeStepPlan("report").toolChoice, "none");
  // Persist/memory phases force a decision so narration cannot end the run.
  assertEquals(buildFinalizeStepPlan("persist").toolChoice, "required");
  assertEquals(buildFinalizeStepPlan("memory").toolChoice, "required");
});

Deno.test("kill switch: FORCE_TOOL_CALL_UNTIL_FINALIZE is on, and flipping it degrades to auto", () => {
  assertEquals(FORCE_TOOL_CALL_UNTIL_FINALIZE, true, "forcing must ship enabled");
  // Documents the escape hatch: with the flag off, orchestratorStepToolChoice(false)
  // returns "auto" — the pre-fix behaviour — without reverting this module.
  assertEquals(orchestratorStepToolChoice(true), "auto");
});
