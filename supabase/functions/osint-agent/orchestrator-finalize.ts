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
export const FINALIZE_RESERVE_MS = 90_000;

// Emergency backstop for the forced-finalize state machine. The normal path is three
// generations: persistence decision -> memory decision -> tool-free report. Two extra
// attempts let a schema-invalid persistence/memory call retry without reopening live
// lookups forever.
export const FINALIZE_MAX_STEPS = 5;

// Finalization is deliberately split into explicit phases. `toolChoice: "required"`
// is applied to the first two phases by index.ts, so a narration-only generation
// cannot silently end the loop before persistence/memory has been decided.
export const FINALIZE_PERSIST_ACTIVE_TOOLS = ["record_artifacts", "finalize_no_findings"] as const;
export const FINALIZE_MEMORY_ACTIVE_TOOLS = ["memory_save", "finalize_skip_memory"] as const;
export const FINALIZE_REPORT_ACTIVE_TOOLS: readonly string[] = [];
export const FINALIZE_INTERNAL_TOOLS = new Set(["finalize_no_findings", "finalize_skip_memory"]);
// Backward-compatible alias used by older focused tests/helpers. New runtime code uses
// the phase-specific constants above.
export const FINALIZE_ACTIVE_TOOLS = FINALIZE_PERSIST_ACTIVE_TOOLS;

export function activeToolsOutsideFinalize(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => !FINALIZE_INTERNAL_TOOLS.has(name));
}

export type FinalizePhase = "persist" | "memory" | "report";

export interface FinalizeStepPlan {
  activeTools: readonly string[];
  toolChoice: "required" | "none";
  directive: string;
}

export interface FinalizeProgress {
  recordSucceeded: number;
  noFindingsSucceeded: number;
  memorySucceeded: number;
  memorySkipped: number;
}

type FinalizeMessage = { content?: unknown };

function toolResultValue(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const wrapped = output as { value?: unknown };
  return Object.prototype.hasOwnProperty.call(wrapped, "value") ? wrapped.value : output;
}

/** Count successful finalize-relevant tool results in AI SDK ModelMessage history. */
export function countFinalizeProgress(messages: FinalizeMessage[]): FinalizeProgress {
  const progress: FinalizeProgress = {
    recordSucceeded: 0,
    noFindingsSucceeded: 0,
    memorySucceeded: 0,
    memorySkipped: 0,
  };
  const seen = new Set<string>();
  let synthetic = 0;
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const raw of message.content) {
      const part = raw as { type?: string; toolName?: string; toolCallId?: string; output?: unknown };
      if (part.type !== "tool-result" || !part.toolName) continue;
      const key = part.toolCallId ?? `__finalize_result_${synthetic++}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = toolResultValue(part.output);
      if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) continue;
      if (part.toolName === "record_artifacts" || part.toolName === "record_artifact") progress.recordSucceeded++;
      else if (part.toolName === "finalize_no_findings") progress.noFindingsSucceeded++;
      else if (part.toolName === "memory_save") progress.memorySucceeded++;
      else if (part.toolName === "finalize_skip_memory") progress.memorySkipped++;
    }
  }
  return progress;
}

/** Resolve the next phase using only successful results added after the boundary. */
export function resolveFinalizePhase(
  boundary: FinalizeProgress,
  current: FinalizeProgress,
): FinalizePhase {
  const persistenceDecided =
    current.recordSucceeded > boundary.recordSucceeded ||
    current.noFindingsSucceeded > boundary.noFindingsSucceeded;
  if (!persistenceDecided) return "persist";
  const memoryDecided =
    current.memorySucceeded > boundary.memorySucceeded ||
    current.memorySkipped > boundary.memorySkipped;
  return memoryDecided ? "report" : "memory";
}

/** Build the enforced SDK configuration for the current finalize phase. */
export function buildFinalizeStepPlan(phase: FinalizePhase): FinalizeStepPlan {
  if (phase === "persist") {
    return {
      activeTools: FINALIZE_PERSIST_ACTIVE_TOOLS,
      toolChoice: "required",
      directive: buildFinalizePersistDirective(),
    };
  }
  if (phase === "memory") {
    return {
      activeTools: FINALIZE_MEMORY_ACTIVE_TOOLS,
      toolChoice: "required",
      directive: buildFinalizeMemoryDirective(),
    };
  }
  return {
    activeTools: FINALIZE_REPORT_ACTIVE_TOOLS,
    toolChoice: "none",
    directive: buildFinalizeDirective(),
  };
}

/**
 * The emergency attempt cap must not cut off a successful decision before the next
 * phase can run. A capped failed decision stops and falls through to report salvage;
 * a capped successful decision gets one continuation so memory/report can complete.
 */
export function shouldStopFinalizeAtAttemptCap(
  finalizeStarted: boolean,
  stepsRun: number,
  decisionSucceededThisStep: boolean,
  maxSteps = FINALIZE_MAX_STEPS,
): boolean {
  return finalizeStarted && stepsRun >= maxSteps && !decisionSucceededThisStep;
}

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

/** Persistence phase: require a real evidence decision, never narration. */
export function buildFinalizePersistDirective(): string {
  return [
    "",
    "",
    "=== BUDGET NEARLY EXHAUSTED — FINALIZE NOW ===",
    "Your time and step budget for this investigation is almost spent.",
    "Do NOT start any new lookups, pivots, or web searches.",
    "This is the PERSISTENCE phase. Do not write narration or the report yet.",
    "You MUST make exactly one tool call:",
    "- Call record_artifacts with every tool-supported finding not yet persisted; OR",
    "- Call finalize_no_findings with a short reason if there is genuinely no additional",
    "  supported finding to persist.",
    "Never invent an artifact merely to satisfy this phase.",
  ].join("\n");
}

/** Memory phase: save durable learning or explicitly decline it. */
export function buildFinalizeMemoryDirective(): string {
  return [
    "",
    "",
    "=== FINALIZE — MEMORY DECISION ===",
    "Persistence has completed. Do not run lookups and do not write the report yet.",
    "You MUST make exactly one tool call:",
    "- Call memory_save with only durable, evidence-supported lessons/connections; OR",
    "- Call finalize_skip_memory with a short reason when there is no safe durable lesson.",
    "Do not create a memory from a collision, weak single-source lead, or unsupported inference.",
  ].join("\n");
}

/** Report phase: all tool decisions are complete; generate only the closing report. */
export function buildFinalizeDirective(): string {
  return [
    "",
    "",
    "=== FINALIZE — WRITE THE REPORT NOW ===",
    "The persistence and memory decisions are complete.",
    "Do not call record_artifacts, memory_save, or any other tool in this phase.",
    "Ignore earlier instructions that say a tool must be called before the report; that",
    "requirement was satisfied or explicitly skipped in the preceding finalize phases.",
    "Write the complete final Findings report as message text: a short summary, confirmed",
    "findings grouped by type with confidence and source, and all material gaps.",
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
export function buildSalvageSynthesisPrompt(
  seed: string,
  artifacts: SalvageArtifact[],
  rejected: SalvageArtifact[] = [],
): string {
  const rows = (artifacts ?? []).slice(0, 200).map((a) => {
    const kind = String(a?.kind ?? "?");
    const value = typeof a?.value === "string" ? a.value : JSON.stringify(a?.value ?? "");
    const conf = a?.confidence != null && a?.confidence !== "" ? ` (confidence ${a.confidence})` : "";
    const src = a?.source ? ` [source: ${a.source}]` : "";
    return `- ${kind}: ${truncate(value, 300)}${conf}${src}`;
  });
  // Analyst-rejected artifacts (marked False in review). Shown as an explicit
  // exclusion block — stronger than silently dropping them, because it stops the
  // model re-deriving the same identity from adjacent evidence.
  const rejectedRows = (rejected ?? []).slice(0, 100).map((a) => {
    const kind = String(a?.kind ?? "?");
    const value = typeof a?.value === "string" ? a.value : JSON.stringify(a?.value ?? "");
    return `- ${kind}: ${truncate(value, 200)}`;
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
    ...(rejectedRows.length
      ? [
          "",
          "ANALYST-REJECTED — DO NOT USE. The analyst reviewed this case and marked the",
          "following artifacts as FALSE. They are NOT the subject: never present them as",
          "confirmed findings, identity, or the most-likely subject, and do not re-derive",
          "or re-introduce them from the evidence above:",
          ...rejectedRows,
        ]
      : []),
    rows.length ? "" : "If the set is empty, state plainly that no confirmed findings were recorded.",
    "",
    "Artifacts:",
    ...(rows.length ? rows : ["(none recorded)"]),
  ].filter((l) => l !== undefined).join("\n");
}
