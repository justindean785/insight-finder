/**
 * orchestrator_finalize_test.ts — unit tests for the guaranteed closing-synthesis
 * guards (P0 "No report yet" fix). All logic under test is PURE (no live model, no
 * clock), mirroring orchestrator-budget.ts's testable-StopCondition precedent.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldForceFinalize,
  buildFinalizeDirective,
  buildPerCycleCompactDirective,
  extractAssistantReportText,
  needsReportSalvage,
  buildSalvageSynthesisPrompt,
  toolCallCapReached,
  shouldSkipForToolCap,
  FINALIZE_ACTIVE_TOOLS,
  FINALIZE_RESERVE_MS,
  FINALIZE_MAX_STEPS,
  MIN_REPORT_CHARS,
} from "./orchestrator-finalize.ts";
import { MAX_ORCHESTRATOR_STEPS, ORCHESTRATOR_WALL_CLOCK_MS, MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";

// ---- Fix A: shouldForceFinalize -------------------------------------------------

Deno.test("shouldForceFinalize: opens exactly at the wall-clock reserve window", () => {
  const edge = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS; // 240s - 45s = 195s
  assertEquals(shouldForceFinalize(edge - 1, 3), false, "1ms before the window stays open for lookups");
  assertEquals(shouldForceFinalize(edge, 3), true, "at the window edge we finalize");
  assertEquals(shouldForceFinalize(edge + 5_000, 3), true, "past the window we finalize");
});

Deno.test("shouldForceFinalize: forces on the last allowed step regardless of time", () => {
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS - 2), false, "two steps from cap: keep working");
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS - 1), true, "last step: finalize");
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS + 3), true, "past cap: finalize");
});

Deno.test("shouldForceFinalize: honors explicit budget/reserve/maxSteps overrides", () => {
  assertEquals(
    shouldForceFinalize(50, 2, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    false,
    "elapsed 50 < 60 window, step 2 < 9",
  );
  assertEquals(
    shouldForceFinalize(60, 2, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    true,
    "elapsed 60 == budget-reserve → finalize",
  );
  assertEquals(
    shouldForceFinalize(10, 9, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    true,
    "step 9 == maxSteps-1 → finalize",
  );
});

Deno.test("finalize constants are sane", () => {
  assert(FINALIZE_RESERVE_MS > 0 && FINALIZE_RESERVE_MS < ORCHESTRATOR_WALL_CLOCK_MS, "reserve fits inside budget");
  assert(FINALIZE_MAX_STEPS >= 1, "at least one finalize step");
  assertEquals(FINALIZE_ACTIVE_TOOLS.includes("record_artifacts"), true, "record_artifacts stays available to finalize");
});

Deno.test("buildFinalizeDirective instructs report-then-record and forbids new lookups", () => {
  const d = buildFinalizeDirective().toLowerCase();
  assert(d.includes("record_artifacts"), "mentions record_artifacts");
  assert(d.includes("findings report") || d.includes("final") , "asks for the final report");
  assert(d.includes("no new") || d.includes("not start") || d.includes("do not start"), "forbids new lookups");
});

// ---- Per-cycle compact output directive -----------------------------------------

Deno.test("buildPerCycleCompactDirective: forbids the full dossier and demands new-only compact lines", () => {
  const d = buildPerCycleCompactDirective();
  const lower = d.toLowerCase();
  // Forbids the full-dossier shapes on an intermediate turn.
  assert(lower.includes("do not write a findings table"), "forbids a Findings table mid-run");
  assert(/network section/i.test(d), "names the Network section it must not write");
  assert(/summary/i.test(d), "names the Summary it must not write");
  // New-findings-only + compact one-line format.
  assert(/only .*new|new in this cycle/i.test(d), "asks for NEW findings only");
  assert(lower.includes("do not re-state"), "forbids re-stating earlier findings");
  assert(lower.includes("one"), "asks for one-line-per-finding output");
  // Defers the full report to the explicit finalize signal.
  assert(/do not pre-empt|explicitly when to write/i.test(d), "defers the closing report");
});

Deno.test("buildPerCycleCompactDirective: tier thresholds mirror tierFor() exactly", () => {
  const d = buildPerCycleCompactDirective();
  // The words + numeric thresholds must match lib/cluster.ts tierFor():
  //   >=90 Confirmed, >=75 Likely, >=50 Possible, >=30 Weak, else Unverified.
  for (const [n, tier] of [["90", "Confirmed"], ["75", "Likely"], ["50", "Possible"], ["30", "Weak"]] as const) {
    assert(d.includes(n), `directive states the ${tier} threshold ${n}`);
    assert(d.includes(tier), `directive names the ${tier} tier`);
  }
  assert(d.includes("Unverified"), "directive names the Unverified (below-30) tier");
});

// ---- Run tool-call cap ----------------------------------------------------------

Deno.test("toolCallCapReached: trips at the cap, not before", () => {
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN - 1), false, "one under the cap keeps working");
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN), true, "at the cap → finalize");
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN + 10), true, "past the cap → finalize");
  assertEquals(toolCallCapReached(5, 5), true, "honors an explicit cap override");
});

Deno.test("shouldSkipForToolCap: skips a live lookup past the cap but NEVER a recording tool", () => {
  // A run that has already made cap genuine calls: further NON-recording lookups skip.
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN, false), true, "lookup past cap → skip");
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN - 1, false), false, "lookup under cap → run");
  // record_artifacts / evidence writes are exempt so capping can't strand evidence.
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN + 50, true), false, "recording tool past cap → still runs");
});

Deno.test("run-cap enforcement: a 61-call run cannot exceed the cap of genuine calls", () => {
  // Simulate the wrapper's per-call gate over 80 attempted NON-recording lookups.
  let genuine = 0;
  let capped = false;
  let skipped = 0;
  for (let i = 0; i < 80; i++) {
    if (shouldSkipForToolCap(genuine, false)) { capped = true; skipped++; continue; }
    genuine++; // a genuine live execution
  }
  assertEquals(genuine, MAX_TOOL_CALLS_PER_RUN, "genuine executions are clamped at the cap");
  assertEquals(capped, true, "run_capped is set once the cap is hit");
  assertEquals(skipped, 80 - MAX_TOOL_CALLS_PER_RUN, "every attempt past the cap is skipped, not run");
});

// ---- Fix B: report-salvage detection + synthesis prompt --------------------------

Deno.test("extractAssistantReportText: joins text parts of the LAST assistant message only", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "seed" }] },
    { role: "assistant", parts: [{ type: "text", text: "old draft" }] },
    { role: "assistant", parts: [
      { type: "tool-whois", text: "ignored tool part" },
      { type: "text", text: "Final report line 1." },
      { type: "text", text: "Line 2." },
    ] },
  ];
  assertEquals(extractAssistantReportText(msgs), "Final report line 1.\nLine 2.");
});

Deno.test("extractAssistantReportText: returns empty string when no assistant text", () => {
  assertEquals(extractAssistantReportText([{ role: "assistant", parts: [{ type: "tool-x" }] }]), "");
  assertEquals(extractAssistantReportText([]), "");
});

Deno.test("needsReportSalvage: gap = work happened but no substantive report", () => {
  assertEquals(needsReportSalvage("", 12), true, "12 tool calls, empty report → salvage");
  assertEquals(needsReportSalvage("too short", 12), true, "below MIN_REPORT_CHARS → salvage");
  assertEquals(needsReportSalvage("x".repeat(MIN_REPORT_CHARS + 1), 12), false, "real report → no salvage");
});

Deno.test("needsReportSalvage: a genuinely empty case (no tool calls) is left alone", () => {
  assertEquals(needsReportSalvage("", 0), false, "no work done → not the report gap");
});

Deno.test("buildSalvageSynthesisPrompt: grounds strictly in the passed artifacts, no tools", () => {
  const p = buildSalvageSynthesisPrompt("jane@example.com", [
    { kind: "username", value: "jdoe", confidence: 80, source: "github" },
    { kind: "location", value: "Austin, TX", confidence: 60, source: "exif" },
  ]);
  assert(p.includes("jane@example.com"), "includes the seed");
  assert(p.includes("jdoe") && p.includes("github"), "includes artifact value + source");
  assert(p.includes("Austin, TX"), "includes second artifact");
  assert(/do not invent|only these|from only/i.test(p), "instructs no fabrication");
  assert(/do not call any tools|no tools/i.test(p), "instructs tool-free synthesis");
});

Deno.test("buildSalvageSynthesisPrompt: tolerates zero artifacts", () => {
  const p = buildSalvageSynthesisPrompt("bob@example.com", []);
  assert(p.includes("bob@example.com"), "still includes the seed");
  assert(typeof p === "string" && p.length > 0, "produces a usable prompt");
});
