/**
 * orchestrator_finalize_test.ts — unit tests for the guaranteed closing-synthesis
 * guards (P0 "No report yet" fix). All logic under test is PURE (no live model, no
 * clock), mirroring orchestrator-budget.ts's testable-StopCondition precedent.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldForceFinalize,
  buildFinalizeDirective,
  extractAssistantReportText,
  needsReportSalvage,
  buildSalvageSynthesisPrompt,
  FINALIZE_ACTIVE_TOOLS,
  FINALIZE_RESERVE_MS,
  FINALIZE_MAX_STEPS,
  MIN_REPORT_CHARS,
} from "./orchestrator-finalize.ts";
import { MAX_ORCHESTRATOR_STEPS, ORCHESTRATOR_WALL_CLOCK_MS } from "./orchestrator-budget.ts";

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
