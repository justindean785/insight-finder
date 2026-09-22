/**
 * run-controls.ts — pure decision logic for the Continue / Auto-run / Write
 * report controls that sit above the composer.
 *
 * Why this exists. Measured 2026-09-20 over 30 days of production `messages`:
 * the analyst's most common follow-up turns were literally "run next pivots"
 * (8), "pivot" (5) and "summarize the strongest findings so far" (10) — typed by
 * hand, every cycle. Every such turn is a full agent invocation that ends in a
 * forced finalize and a fresh closing dossier, so the analyst was re-typing the
 * same instruction and re-reading the same report to move one pivot forward.
 *
 * These controls turn that into a click, and Auto-run into zero clicks: keep
 * cycling while each cycle still records NEW evidence, and stop on saturation.
 * The prompts are deliberately explicit about "only what is new" — the edge
 * function's per-cycle contract (system-prompt.ts, "PER CYCLE") already asks for
 * compact deltas inside a run; this carries the same intent across runs.
 *
 * Everything here is pure so it can be unit-tested without rendering the
 * 2,900-line ChatWindow. The component (RunControls.tsx) only renders state and
 * forwards clicks; ChatWindow owns the send.
 */

/** Sent when the analyst clicks Continue, or when Auto-run starts a cycle. */
export const CONTINUE_PROMPT =
  "Continue the investigation. Run the next highest-value pivots on the strongest " +
  "unpursued leads, recording each hard finding with record_artifacts as you go. " +
  "Report ONLY what is new this cycle as compact lines (finding — selector — tier) " +
  "followed by the next 3 pivots. Do not restate earlier findings and do not rewrite " +
  "the full report.";

/** Sent when the analyst clicks Write report. */
export const REPORT_PROMPT =
  "Write the full closing report now from the artifacts already recorded on this case: " +
  "Findings table, Network section showing how the dots connect, and a Summary with the " +
  "strongest leads and every pivot left unpursued (with the reason). Cite the source tool " +
  "for every hard finding. Do not run new lookups.";

/** Ceiling on unattended cycles per Auto-run activation. Each cycle is a paid
 *  agent invocation (median ~150 s, ~35 tool calls per case), so the ceiling is
 *  the cost guard — the analyst re-arms it deliberately, never by default. */
export const AUTO_RUN_MAX_CYCLES = 3;

/** Grace period between a run ending and the auto-continue decision, so the
 *  realtime artifact subscription has a chance to deliver the last cycle's rows
 *  before "did this cycle record anything new?" is evaluated. */
export const AUTO_RUN_SETTLE_MS = 2_000;

export type AutoRunStopReason =
  | "disabled"
  | "max_cycles"
  | "no_new_evidence"
  | "run_failed"
  | "run_not_finished";

export type AutoRunDecision =
  | { action: "continue"; cyclesRun: number }
  | { action: "stop"; reason: AutoRunStopReason };

export interface AutoRunInput {
  /** Auto-run switch as the analyst left it. */
  enabled: boolean;
  /** Cycles Auto-run has already started since it was armed. */
  cyclesRun: number;
  maxCycles?: number;
  /** Artifact count snapshotted when the last cycle was sent (null = never sent). */
  artifactsBefore: number | null;
  /** Artifact count now that the cycle has ended. */
  artifactsNow: number;
  /** The chat transport reported an error for the last run. */
  runFailed: boolean;
  /** The thread is no longer in a terminal state the UI can continue from
   *  (e.g. the analyst pressed Stop, or a recovery banner is up). */
  threadFinished: boolean;
}

/**
 * Decide whether Auto-run should send the next cycle. Every stop reason is
 * explicit so the UI can say WHY it stopped instead of going quiet.
 *
 * Order matters: a failed or stopped run wins over everything (never re-fire on
 * a broken thread), then the cycle ceiling, then saturation.
 */
export function decideAutoContinue(input: AutoRunInput): AutoRunDecision {
  const max = input.maxCycles ?? AUTO_RUN_MAX_CYCLES;
  if (!input.enabled) return { action: "stop", reason: "disabled" };
  if (input.runFailed) return { action: "stop", reason: "run_failed" };
  if (!input.threadFinished) return { action: "stop", reason: "run_not_finished" };
  if (input.cyclesRun >= max) return { action: "stop", reason: "max_cycles" };
  // The first armed cycle has no "before" snapshot; saturation is only judged
  // once a cycle has actually run under Auto-run.
  if (input.artifactsBefore !== null && input.artifactsNow <= input.artifactsBefore) {
    return { action: "stop", reason: "no_new_evidence" };
  }
  return { action: "continue", cyclesRun: input.cyclesRun + 1 };
}

export function autoRunStopMessage(reason: AutoRunStopReason, maxCycles = AUTO_RUN_MAX_CYCLES): string {
  switch (reason) {
    case "max_cycles":
      return `Auto-run paused after ${maxCycles} cycles. Continue or write the report when ready.`;
    case "no_new_evidence":
      return "Auto-run stopped: the last cycle recorded no new evidence. Write the report or pick a pivot.";
    case "run_failed":
      return "Auto-run stopped because the last run failed.";
    case "run_not_finished":
      return "Auto-run stopped: the run did not finish cleanly.";
    case "disabled":
      return "Auto-run is off.";
  }
}

export interface RunControlsVisibilityInput {
  isLoading: boolean;
  hasAssistantTurn: boolean;
  seedLoaded: boolean;
  hasLiveError: boolean;
  /** While Auto-run is cycling the bar stays up so the analyst can see the
   *  cycle count and switch it off without pressing Stop. */
  autoRunEnabled?: boolean;
  /** The case snapshot says a run is live on this thread (fresh heartbeat),
   *  even though THIS tab is not streaming it — a second tab, a reload, or a
   *  run that survived navigation. Continuing here would overlap it. */
  serverRunActive?: boolean;
}

/** The controls belong under a finished turn, never beside a failure card
 *  (which carries its own Retry). A live stream hides them unless Auto-run is
 *  the thing driving that stream. */
export function canShowRunControls(input: RunControlsVisibilityInput): boolean {
  if (!input.hasAssistantTurn || !input.seedLoaded || input.hasLiveError) return false;
  if (input.serverRunActive && !input.isLoading) return false;
  return !input.isLoading || Boolean(input.autoRunEnabled);
}
