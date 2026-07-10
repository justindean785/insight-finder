/**
 * orchestrator-finalize.ts — guarantee a run ends with a written Findings report.
 *
 * WHY (P0 "No report yet"): the orchestrator loop stops on
 *   stopWhen: [stepCountIs(MAX_ORCHESTRATOR_STEPS), wall-clock deadline]
 * and EITHER can trip immediately after a TOOL step — denying the model the turn
 * where it writes its report. A dense run (observed: 57 calls / 271s > the 240s
 * deadline) then finished "finished" with no report text and 0 record_artifacts.
 *
 * Two guards, both PURE (no live model, no clock) so they unit-test without mocking
 * — mirroring orchestrator-budget.ts's testable-StopCondition precedent:
 *
 *   A (in-loop, preferred): shouldForceFinalize() opens a reserved window near the
 *     budget edge (or on the last allowed step). prepareStep then restricts tools to
 *     record_artifacts and injects buildFinalizeDirective() so the model spends its
 *     final step(s) synthesizing instead of fanning out — the report streams live.
 *   B (post-loop backstop): needsReportSalvage() detects a finished run that STILL
 *     has no report; index.ts then runs ONE bounded tool-free generation from the
 *     buildSalvageSynthesisPrompt() and persists that as the assistant message.
 *
 * Integrity-neutral: touches NO evidence ranking / confidence / attribution — it
 * only guarantees the synthesis STEP happens. The report content stays the model's,
 * grounded strictly in artifacts already gathered.
 */
import { MAX_ORCHESTRATOR_STEPS, ORCHESTRATOR_WALL_CLOCK_MS, MAX_TOOL_CALLS_PER_RUN } from "./orchestrator-budget.ts";

// Reserve the final stretch of the wall-clock budget for a guaranteed synthesis+record
// step. Once elapsed enters this window the orchestrator stops issuing new lookups and
// forces a FINALIZE step, so the run ends with a report instead of tripping the hard
// deadline mid-tool-call. 45s ≈ one closing MiniMax synthesis turn with headroom.
export const FINALIZE_RESERVE_MS = 45_000;

// Cap the forced finalize phase to this many steps (a StopCondition ends the run once
// reached). 2 lets the model call record_artifacts then write the report from its
// result, without looping synthesis for the whole reserve window.
export const FINALIZE_MAX_STEPS = 2;

// The only tools left active during the forced finalize step: persist any confirmed
// finding not yet recorded. No new lookups — the budget is spent.
export const FINALIZE_ACTIVE_TOOLS = ["record_artifacts"] as const;

// A finished run whose final assistant text is shorter than this is treated as
// having no usable report (the "No report yet" symptom) and is eligible for salvage.
export const MIN_REPORT_CHARS = 200;

/**
 * True once the run should stop new lookups and force its closing synthesis+record
 * step: either the wall-clock reserve window has opened, or this is the last allowed
 * step (`stepNumber` is 0-indexed for the step about to run, so `maxSteps - 1` is the
 * final step under stepCountIs(maxSteps)). Pure — the caller passes elapsed + step.
 */
export function shouldForceFinalize(
  elapsedMs: number,
  stepNumber: number,
  opts?: { budgetMs?: number; reserveMs?: number; maxSteps?: number },
): boolean {
  const budgetMs = opts?.budgetMs ?? ORCHESTRATOR_WALL_CLOCK_MS;
  const reserveMs = opts?.reserveMs ?? FINALIZE_RESERVE_MS;
  const maxSteps = opts?.maxSteps ?? MAX_ORCHESTRATOR_STEPS;
  return elapsedMs >= budgetMs - reserveMs || stepNumber >= maxSteps - 1;
}

/**
 * True once a run has made its budgeted number of genuine (live) tool executions.
 * Checked in prepareStep to force the closing synthesis — a third finalize trigger
 * alongside the wall-clock reserve window and the step cap.
 */
export function toolCallCapReached(genuineToolCalls: number, cap: number = MAX_TOOL_CALLS_PER_RUN): boolean {
  return genuineToolCalls >= cap;
}

/**
 * Decides whether the tool-cache wrapper should short-circuit a specific live call
 * because the run cap is hit. Recording/evidence tools are NEVER skipped (the
 * closing record_artifacts must run), so the cap can't strand collected evidence.
 * Pure so the enforcement rule is unit-tested without the wrapper's DB/circuit deps.
 */
export function shouldSkipForToolCap(
  genuineToolCalls: number,
  isRecordingTool: boolean,
  cap: number = MAX_TOOL_CALLS_PER_RUN,
): boolean {
  if (isRecordingTool) return false;
  return genuineToolCalls >= cap;
}

/**
 * The system-prompt addendum appended for the forced finalize step. Tells the model
 * the budget is nearly spent, forbids new lookups, and asks for the report AS ITS
 * MESSAGE TEXT plus record_artifacts for anything not yet persisted.
 */
export function buildFinalizeDirective(): string {
  return [
    "",
    "",
    "=== BUDGET NEARLY EXHAUSTED — FINALIZE NOW ===",
    "Your time and step budget for this investigation is almost spent.",
    "Do NOT start any new lookups, pivots, or web searches.",
    "In THIS step you MUST:",
    "1. Write your complete final Findings report as your message text — a short summary,",
    "   the confirmed findings grouped by type with their confidence and source, and any gaps.",
    "2. Call record_artifacts once for any confirmed finding you have not already recorded.",
    "Produce the report even if coverage is partial; state uncertainty honestly. Do not fabricate.",
  ].join("\n");
}

// ---- Fix B: post-loop salvage ---------------------------------------------------

type ReportPart = { type?: string; text?: unknown };
type ReportMsg = { role?: string; parts?: ReportPart[] };

/** Concatenated text parts of the LAST assistant message — what the UI shows as the
 * report. Tool parts and earlier assistant drafts are ignored. */
export function extractAssistantReportText(finalMessages: ReportMsg[]): string {
  const assistant = [...(finalMessages ?? [])].reverse().find((m) => m?.role === "assistant");
  if (!assistant || !Array.isArray(assistant.parts)) return "";
  return assistant.parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => p!.text as string)
    .join("\n")
    .trim();
}

/**
 * The "No report yet" gap: the run DID work (made tool calls) but produced no
 * substantive report text. A genuinely empty case (no tool calls at all) is left
 * alone — there is nothing to synthesize and no gap to paper over.
 */
export function needsReportSalvage(reportText: string, toolCalls: number): boolean {
  if (toolCalls <= 0) return false;
  return (reportText?.trim().length ?? 0) < MIN_REPORT_CHARS;
}

type SalvageArtifact = { kind?: unknown; value?: unknown; confidence?: unknown; source?: unknown };

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Prompt for the tool-free salvage generation. Grounds the model STRICTLY in the
 * artifacts already gathered (nothing new is fetched) and forbids fabrication and
 * further tool use, so the salvage report can only restate confirmed evidence.
 */
export function buildSalvageSynthesisPrompt(seed: string, artifacts: SalvageArtifact[]): string {
  const rows = (artifacts ?? []).slice(0, 200).map((a) => {
    const kind = String(a?.kind ?? "?");
    const value = typeof a?.value === "string" ? a.value : JSON.stringify(a?.value ?? "");
    const conf = a?.confidence != null && a?.confidence !== "" ? ` (confidence ${a.confidence})` : "";
    const src = a?.source ? ` [source: ${a.source}]` : "";
    return `- ${kind}: ${truncate(value, 300)}${conf}${src}`;
  });
  return [
    `Investigation seed: ${seed}`,
    "",
    `This run ended before it wrote its report. Below ${
      rows.length ? `are the ${rows.length} artifacts` : "is the (empty) set of artifacts"
    } gathered.`,
    "Write a complete, honest Findings report using ONLY these artifacts:",
    "- One short paragraph summarizing who or what was identified.",
    "- Confirmed findings grouped by type, each with its confidence and source.",
    "- Explicit gaps and unverified leads.",
    "Do not invent anything not present below. Do not call any tools.",
    rows.length ? "" : "If the set is empty, state plainly that no confirmed findings were recorded.",
    "",
    "Artifacts:",
    ...(rows.length ? rows : ["(none recorded)"]),
  ].filter((l) => l !== undefined).join("\n");
}
