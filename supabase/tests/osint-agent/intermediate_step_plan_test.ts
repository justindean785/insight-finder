// intermediate_step_plan_test.ts
//
// Pins the CORRECTED invariant (2026-07-25): non-finalize steps must NOT force a tool
// call. Forcing toolChoice:"required" on every step (added 07-21) was the completion
// regression — AI SDK v6 ends the loop naturally when the model writes its final report
// as a text-only step, so forcing a tool call every step removed the only natural way
// to conclude. Measured: self-completion 61%->25%, natural conclusion at ~7 calls
// eliminated, 75% of runs swept with no report.
//
// The forcing was originally added to fix a PERSISTENCE gap (without it, record_artifacts
// calls fell — 34.5% of runs recorded zero artifacts). That gap is now closed by the
// DETACHED auto-persist backstop (#380 + person-tool coverage), which secures findings
// whether or not the model calls record_artifacts — so forcing is no longer needed and
// its conclusion cost is not worth paying. The last-known-good build 6d76133 ran with
// forcing OFF and produced 65-83% real reports.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntermediateStepPlan,
  orchestratorStepToolChoice,
  FORCE_TOOL_CALL_UNTIL_FINALIZE,
  REQUIRE_TOOL_CALL_IN_OPENING_PHASE,
} from "../../functions/osint-agent/orchestrator-budget.ts";
import { buildFinalizeStepPlan, needsReportSalvage } from "../../functions/osint-agent/orchestrator-finalize.ts";

const NORMAL_TOOLS = ["whois_lookup", "dns_records", "record_artifacts"];

// The exhaustive set of non-finalize branches prepareStep can take. If a new
// intermediate branch is added to index.ts it MUST be represented here.
const INTERMEDIATE_BRANCHES = [
  { name: "normal", nudgePersistence: false },
  { name: "persistence-nudge", nudgePersistence: true },
] as const;

Deno.test("non-finalize steps do NOT force a tool call (model may conclude with a report)", () => {
  for (const branch of INTERMEDIATE_BRANCHES) {
    const plan = buildIntermediateStepPlan({
      nudgePersistence: branch.nudgePersistence,
      normalActiveTools: NORMAL_TOOLS,
    });
    assertEquals(
      plan.toolChoice,
      "auto",
      `${branch.name}: intermediate steps must allow a text-only conclusion, got "${plan.toolChoice}"`,
    );
  }
});

Deno.test("the persistence-nudge branch still narrows activeTools to record_artifacts", () => {
  // Narrowing is retained (steers the model toward recording) but no longer FORCES it —
  // the auto-persist backstop covers the case where the model narrates instead.
  const plan = buildIntermediateStepPlan({ nudgePersistence: true, normalActiveTools: NORMAL_TOOLS });
  assertEquals(plan.activeTools, ["record_artifacts"]);
  assertEquals(plan.toolChoice, "auto");
});

Deno.test("the normal branch passes activeTools through unchanged (copy, not alias)", () => {
  const plan = buildIntermediateStepPlan({ nudgePersistence: false, normalActiveTools: NORMAL_TOOLS });
  assertEquals(plan.activeTools, NORMAL_TOOLS);
  plan.activeTools.push("mutated");
  assertEquals(NORMAL_TOOLS.length, 3, "must not alias the caller's array");
});

Deno.test("finalize steps: report phase free to emit text; persist/memory still force a decision", () => {
  assertEquals(orchestratorStepToolChoice(true), "auto", "finalize opts out of forcing");
  assertEquals(buildFinalizeStepPlan("report").toolChoice, "none");
  assertEquals(buildFinalizeStepPlan("persist").toolChoice, "required");
  assertEquals(buildFinalizeStepPlan("memory").toolChoice, "required");
});

Deno.test("P0-B opening gate: the FIRST step of a seeded run may not end on narration", () => {
  // THE PRODUCTION FAILURE (thread 40f8a6eb): seed `jdean785` -> the model emitted
  // "I'll start" (10 chars, no tool call) -> SDK ended the loop at step 1 -> that
  // stub became the run's final message and the thread went COMPLETE. The analyst
  // had to type "go" to make the investigation happen at all.
  assertEquals(REQUIRE_TOOL_CALL_IN_OPENING_PHASE, true, "opening gate must ship on");
  assertEquals(
    orchestratorStepToolChoice(false, { openingPhase: true }),
    "required",
    "opening step of a seeded run must emit a tool call",
  );
  const opening = buildIntermediateStepPlan({
    nudgePersistence: false, normalActiveTools: NORMAL_TOOLS, openingPhase: true,
  });
  assertEquals(opening.toolChoice, "required");
  assertEquals(opening.activeTools, [...NORMAL_TOOLS], "the gate must not narrow the toolset");
});

Deno.test("P0-B opening gate: releases the moment work starts — this is NOT the 07-21 forcing regression", () => {
  // The 07-21 regression forced a tool call on EVERY intermediate step, which removed
  // the model's only natural way to conclude (a text-only report) and cratered
  // self-completion 61% -> 25%. The opening gate must apply to the opening step ONLY.
  assertEquals(
    orchestratorStepToolChoice(false, { openingPhase: false }),
    "auto",
    "once any tool has been admitted, steps are free to conclude with text",
  );
  const later = buildIntermediateStepPlan({
    nudgePersistence: false, normalActiveTools: NORMAL_TOOLS, openingPhase: false,
  });
  assertEquals(later.toolChoice, "auto", "the natural text-only report exit is preserved");
  // Finalize is never forced, opening phase or not.
  assertEquals(orchestratorStepToolChoice(true, { openingPhase: true }), "auto");
});

Deno.test("P0-B opening gate: never forces a choice on the persistence-nudge step", () => {
  // The nudge narrows activeTools to record_artifacts alone, whose schema requires
  // >= 1 artifact. Forcing there pressures the model to fabricate an artifact or fail
  // validation — the #384 P1 review defect. The gate must yield to the nudge.
  const nudge = buildIntermediateStepPlan({
    nudgePersistence: true, normalActiveTools: NORMAL_TOOLS, openingPhase: true,
  });
  assertEquals(nudge.activeTools, ["record_artifacts"]);
  assertEquals(nudge.toolChoice, "auto", "no forced choice when the only tool requires an artifact");
});

Deno.test("kill switch: forcing ships DISABLED; flipping it back on re-forces intermediate steps", () => {
  assertEquals(FORCE_TOOL_CALL_UNTIL_FINALIZE, false, "forcing must ship disabled (it caused the completion regression)");
  // orchestratorStepToolChoice keys off the flag: finalize always "auto"; non-finalize
  // is "auto" while the flag is false, and would return "required" if flipped back on.
  assertEquals(orchestratorStepToolChoice(false), "auto");
  assertEquals(orchestratorStepToolChoice(true), "auto");
});

Deno.test("narration-only regression: flag OFF lets a step conclude with text, and a narration-only ending still yields a report", () => {
  // The exact regression FORCE_TOOL_CALL_UNTIL_FINALIZE=true was added to prevent: with
  // forcing OFF an intermediate step may emit narration with NO tool call and END the
  // agent loop. This pins the safety chain that makes that non-fatal, so flipping the
  // flag off cannot reopen "investigation stops with no closing report":
  //   1. intermediate steps allow a text-only conclusion (toolChoice "auto"), AND
  //   2. a narration-only ending after real work triggers the post-loop salvage
  //      (needsReportSalvage), AND
  //   3. the salvage/report phase is tool-free so it can actually write the report.
  // This is the UNIT half only — the three-gate rule still requires a real-UI canary
  // proving a LIVE narration-only step ends with a visible closing report post-deploy.
  const intermediate = buildIntermediateStepPlan({ nudgePersistence: false, normalActiveTools: NORMAL_TOOLS });
  assertEquals(intermediate.toolChoice, "auto", "flag off → a text-only conclusion is allowed");

  const narrationOnly = "Now let me pull the WHOIS and pivot on the registrant email next.";
  assert(
    needsReportSalvage(narrationOnly, 8),
    "a narration-only ending after real work (8 tool calls) MUST trigger the salvage backstop",
  );
  assertEquals(
    needsReportSalvage("## Findings report\n\n| selector | tier |\n|:--|:--|\n| a | Confirmed |", 8),
    false,
    "a genuine report shape does NOT trigger salvage",
  );
  assertEquals(buildFinalizeStepPlan("report").toolChoice, "none", "the salvage/report phase must be tool-free");
});
