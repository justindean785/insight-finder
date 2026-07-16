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
import { envInt } from "./env.ts";

// Reserve the final stretch of the wall-clock budget for a guaranteed synthesis+record
// step. Once elapsed enters this window the orchestrator stops issuing new lookups and
// forces a FINALIZE step, so the run ends with a report instead of tripping the hard
// deadline mid-tool-call.
//
// Widened 45s → 90s: `shouldForceFinalize` is only evaluated at STEP BOUNDARIES
// (prepareStep). With a 45s window [195s, 240s], a single step that begins before
// 195s and runs past 240s — e.g. a ~30s minimax_correlate, or a few serial tools —
// jumps the window entirely: no boundary lands inside it, so finalize is never
// forced and the hard deadline hard-stops the run mid-tool-chain with NO report
// (the live "convo stops, no report" bug, thread 92a7d650). A 90s window [150s,
// 240s] can only be jumped by a single step exceeding 90s, which the per-tool
// timeouts make very unlikely. Trade-off: long runs stop gathering ~45s earlier to
// guarantee a report — the right call. (Raising/removing the 240s hard deadline
// itself — plan Fix A2 — still needs a live Supabase edge wall-clock test; not done
// here.)
//
// Runtime override: env `FINALIZE_RESERVE_MS` (default 90000, clamped ≤ 300000).
// Hard safety: the reserve can never exceed HALF the wall-clock budget, so raising
// the reserve (or shrinking the wall-clock) can't collapse the finalize window onto
// step 0 and starve the run of any real investigation time.
export const FINALIZE_RESERVE_MS = Math.min(
  envInt("FINALIZE_RESERVE_MS", 90_000, 300_000),
  Math.floor(ORCHESTRATOR_WALL_CLOCK_MS / 2),
);

// Effective finalize timing at cold start (paired with orchestrator_budget_config).
console.log(JSON.stringify({
  event: "orchestrator_finalize_config",
  finalize_reserve_ms: FINALIZE_RESERVE_MS,
  orchestrator_wall_clock_ms: ORCHESTRATOR_WALL_CLOCK_MS,
}));

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
 * Runtime-level guard used inside the tool wrapper, not just prepareStep. The AI SDK
 * only evaluates prepareStep/stopWhen between model steps, so a single late step can
 * keep launching lookups after the finalize reserve window has opened. Once the
 * reserve is open, any new NON-recording live lookup is skipped; record_artifacts and
 * evidence writes stay available so the run can finish cleanly.
 */
export function shouldSkipForFinalizeWindow(
  elapsedMs: number,
  isRecordingTool: boolean,
  opts?: { budgetMs?: number; reserveMs?: number },
): boolean {
  if (isRecordingTool) return false;
  const budgetMs = opts?.budgetMs ?? ORCHESTRATOR_WALL_CLOCK_MS;
  const reserveMs = opts?.reserveMs ?? FINALIZE_RESERVE_MS;
  return elapsedMs >= budgetMs - reserveMs;
}

/**
 * The system-prompt addendum appended to every NON-finalize (intermediate) step.
 *
 * WHY: SYSTEM_PROMPT_FULL is injected verbatim on every streamText cycle, and its
 * "Final message MUST contain a Findings table / Network / Summary" language makes
 * the model re-narrate the WHOLE dossier every cycle (observed cycle-1 = 130,757
 * chars). That balloons the carried context and drives the between-cycle dead-time.
 * This directive establishes the per-cycle contract: emit ONLY this cycle's NEW
 * findings, one compact line each, with a confidence tier — no table, no re-stating
 * of prior findings, no full dossier. The full dossier is written ONCE, later, when
 * buildFinalizeDirective() fires (and rendered on demand by the Report tab from the
 * structured artifacts feed). Integrity-neutral: changes only the free-text channel;
 * record_artifacts / evidence provenance are untouched.
 *
 * Tier thresholds MUST mirror tierFor() in lib/cluster.ts (≥90 Confirmed, ≥75
 * Likely, ≥50 Possible, ≥30 Weak, else Unverified) so the words shown in the live
 * cycle stream match the structured tiers the clusterer stamps.
 */
export function buildPerCycleCompactDirective(): string {
  return [
    "",
    "",
    "=== PER-CYCLE OUTPUT: COMPACT ONLY (this is an intermediate step, NOT the final report) ===",
    "Do NOT write a Findings table, a Network section, a Summary, or a full report in this message.",
    "Do NOT re-state findings from earlier cycles. Report ONLY what is NEW in THIS cycle.",
    "For each new finding, emit exactly ONE short line:",
    "  <finding> — <selector/value> — <Tier>",
    "where <Tier> is derived from the finding's 0-100 confidence using these exact thresholds:",
    "  ≥90 Confirmed · ≥75 Likely · ≥50 Possible · ≥30 Weak · else Unverified.",
    "If this cycle found nothing new, say so in one short line and pivot. Keep the whole message tight.",
    "You will be told explicitly when to write the full closing report — do NOT pre-empt it here.",
  ].join("\n");
}

// ---- First-pass persistence nudge (DeepSeek deferral fix) ----------------------
// WHY: DeepSeek (now the live orchestrator) under-emits record_artifacts on the
// first pass — it fans out through many discovery calls and defers structured
// persistence, often waiting for minimax_correlate before recording anything. When
// correlate times out (chronic), the first turn can finish with 0 artifacts even
// though hard identifiers were already in hand (live thread 32d301d0: 46 tool calls,
// 0 record_artifacts, zero_artifacts_at_completion). This is a BEHAVIORAL nudge, not
// a deterministic extractor: it only asks the model to persist what it already has —
// it never invents artifacts from narration or raw tool output. MiniMax, which
// records incrementally on its own, never trips it because it records before the
// threshold (recordCalls > 0 short-circuits the predicate).

// Fire the nudge once a run has made this many tool calls with STILL zero
// record_artifacts calls — the "fanned out but persisted nothing" signature.
export const PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD = 5;

/**
 * True when the run should be nudged to persist already-supported findings NOW:
 * it has made >= PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD tool calls, has recorded
 * ZERO artifacts so far, and has not already been nudged this run. Pure — the caller
 * passes request-scoped counts + latch, so no module-global state crosses requests.
 *
 * The `alreadyNudged` latch bounds it to one injection per run (no nudge spam); the
 * `recordArtifactCalls === 0` gate independently stops it the instant any persistence
 * happens. Either alone ends the nudge; together it fires at most once.
 */
export function shouldNudgePersistence(
  toolCalls: number,
  recordArtifactCalls: number,
  alreadyNudged: boolean,
  threshold: number = PERSISTENCE_NUDGE_TOOL_CALL_THRESHOLD,
): boolean {
  if (alreadyNudged) return false;
  if (recordArtifactCalls > 0) return false;
  return toolCalls >= threshold;
}

/**
 * The system-prompt addendum injected ONCE on an intermediate step when
 * shouldNudgePersistence() fires. Tells the model to pause broad discovery and
 * persist the hard findings it ALREADY supports, with exact provenance — without
 * waiting for minimax_correlate and without fabricating anything from narration.
 * Integrity-neutral: it only redirects WHEN persistence happens, never WHAT counts
 * as evidence (confidence/source/custody rules are unchanged).
 */
export function buildPersistenceNudgeDirective(): string {
  return [
    "",
    "",
    "=== PERSIST NOW — you have made several lookups but recorded ZERO artifacts ===",
    "Pause broad discovery for THIS step and persist what you have already found:",
    "1. You may call ONLY record_artifacts in this step. Do not call any lookup,",
    "   search, scrape, correlate, or enrichment tool until after persistence succeeds.",
    "2. Call record_artifacts now for every hard finding already supported by a tool",
    "   result this run (confirmed selectors, infra, breach/identity hits).",
    "3. Preserve exact provenance — set `source` to the tool that produced it and keep",
    "   `metadata.discovered_via` so chain-of-custody stays intact.",
    "4. Do NOT wait for minimax_correlate — correlation is optional enrichment, not a",
    "   precondition for recording. Record first; correlate later.",
    "5. Record ONLY findings backed by real tool output. Your narration is NOT evidence:",
    "   do NOT invent, infer, or fabricate artifacts from prose or unrelated data.",
    "If you genuinely have no tool-supported hard finding yet, say so in one line and",
    "keep investigating — do not manufacture one to satisfy this instruction.",
  ].join("\n");
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

// MiniMax emits reasoning wrapped in <think>…</think>. Strip closed blocks AND a
// dangling (truncation-severed) opener so only the model's ACTUAL output text is
// measured. Verified necessary: a truncated turn carried 11.6k chars of text —
// all <think> + inter-step narration, zero report — and the old <200-char gate
// passed, so salvage never ran (thread 92a7d650).
const REASONING_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const REASONING_DANGLING_RE = /<think\b[^>]*>[\s\S]*$/i;
export function stripReasoning(text: string): string {
  return (text ?? "").replace(REASONING_BLOCK_RE, "").replace(REASONING_DANGLING_RE, "").trim();
}

// Positive signal that a closing REPORT (not just inter-step narration) was
// written. Stripping <think> is not enough — truncated turns still carry 500–1100
// chars of narration ("Going deeper —", "Recording now and diving into…") that is
// NOT a report. Real reports carry a report/findings heading, a markdown findings
// table, or repeated tier labels ([Confirmed]/[Verify]/…). Any one qualifies.
const REPORT_HEADING_RE = /^\s{0,3}#{1,4}\s+.*\b(report|findings|summary|assessment|conclusion)\b/im;
const TABLE_SEPARATOR_RE = /\|\s*:?-{2,}/;
const TIER_LABEL_RE = /\[(confirmed(?:\s+owner)?|verify|likely|possible(?:\s+owner)?|weak|unverified|low)\]/gi;
export function hasReportShape(text: string): boolean {
  const t = text ?? "";
  if (REPORT_HEADING_RE.test(t)) return true;
  if (TABLE_SEPARATOR_RE.test(t)) return true;
  return (t.match(TIER_LABEL_RE) ?? []).length >= 2;
}

/**
 * The "No report yet" gap: the run DID work (made tool calls) but produced no
 * closing REPORT — only reasoning + inter-step narration, cut off before synthesis.
 * A genuinely empty case (no tool calls) is left alone — nothing to synthesize.
 *
 * Fires when, after stripping <think>, the assistant text shows no report shape.
 * The old `< MIN_REPORT_CHARS` gate missed the common failure (lots of narration,
 * no report); this checks for a positive report signal instead.
 */
export function needsReportSalvage(reportText: string, toolCalls: number): boolean {
  if (toolCalls <= 0) return false;
  const body = stripReasoning(reportText);
  if (hasReportShape(body)) return false;   // a real report block exists — leave it
  return true;                               // work done, but no report → salvage
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
