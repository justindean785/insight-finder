/**
 * run-timeline.ts — the vocabulary the Investigate transcript uses for a run.
 *
 * The orchestrator stamps every tool call with a runtime STAGE token (TRIAGE,
 * REVIEW, TARGETED_PIVOT, VERIFY, REPORT) and a cycle id. Until 2026-10-19 the
 * transcript showed those almost verbatim ("Targeted pivot cycle 2 · 6 calls ·
 * iamfoxxx3@ya…"), which told an analyst which internal state machine step ran
 * and nothing about what the step DID. This module turns the two into the
 * three things a collapsed row has to answer at a glance:
 *
 *   phase    — one analyst word per stage (Triage · Review · Pivot · Verify ·
 *              Report), never the runtime token;
 *   purpose  — what the cycle did, from the tools it ran ("breach lookup ·
 *              username sweep"), concise and never a raw tool id;
 *   outcome  — one word plus an icon for what came of it (completed, from
 *              cache, skipped, no result, running), drawn from the ink ramp:
 *              an outcome is not an authority verdict and spends no hue.
 *
 * Pure. Pinned by src/test/run-timeline.test.ts.
 */
import { conciseToolLabel, humanizeStage } from "@/lib/tool-display";

export type PhaseKey = "triage" | "review" | "pivot" | "verify" | "report" | "other";

const PHASE_KEYS: Record<string, PhaseKey> = {
  TRIAGE: "triage",
  REVIEW: "review",
  TARGETED_PIVOT: "pivot",
  PIVOT: "pivot",
  VERIFY: "verify",
  REPORT: "report",
};

/** The phase a runtime stage token belongs to; `other` for an unknown/legacy token. */
export function phaseKey(stage: string | null | undefined): PhaseKey {
  const raw = (stage ?? "").trim().toUpperCase();
  if (!raw) return "review";
  return PHASE_KEYS[raw] ?? "other";
}

/** One analyst word per phase. Falls back to the humanised token so SNAKE_CASE never leaks. */
export function phaseLabel(stage: string | null | undefined): string {
  switch (phaseKey(stage)) {
    case "triage": return "Triage";
    case "review": return "Review";
    case "pivot": return "Pivot";
    case "verify": return "Verify";
    case "report": return "Report";
    default: return humanizeStage(stage);
  }
}

/** The collapsed-row title: phase word, plus the cycle id as a mono chip when the runtime resolved one. */
export function cycleTitle(stage: string | null | undefined, cycleId: number): { phase: string; cycle: string | null } {
  return { phase: phaseLabel(stage), cycle: Number.isFinite(cycleId) && cycleId > 0 ? `C${cycleId}` : null };
}

export type CycleOutcome = "completed" | "cached" | "skipped" | "partial" | "running";

/** The word beside the outcome icon. Ink ramp only: an outcome is not a verdict. */
export function outcomeWord(outcome: CycleOutcome): string {
  switch (outcome) {
    case "completed": return "completed";
    case "cached": return "from cache";
    case "skipped": return "skipped";
    case "running": return "running";
    default: return "no result";
  }
}

export interface CycleDescription {
  /** "breach lookup · username sweep", at most `max` distinct labels plus "+N". */
  purpose: string;
  /** Distinct real selectors the cycle touched, in first-seen order. */
  selectors: string[];
  /** Selectors beyond the ones listed (when the caller caps them). */
  extraSelectors: number;
}

/** Longest a purpose line gets before the remaining tools fold into "+N". */
export const CYCLE_PURPOSE_MAX_LABELS = 2;
export const CYCLE_SELECTORS_MAX = 2;

/**
 * What a cycle did and what it touched. `toolNames` are tool ids in call
 * order; `selectors` are the REAL selector values the runtime stamped (never
 * an action-label fallback), humanised by the caller.
 */
export function describeCycle(
  toolNames: readonly string[],
  selectors: readonly string[],
  opts: { maxLabels?: number; maxSelectors?: number } = {},
): CycleDescription {
  const maxLabels = opts.maxLabels ?? CYCLE_PURPOSE_MAX_LABELS;
  const maxSelectors = opts.maxSelectors ?? CYCLE_SELECTORS_MAX;
  const labels: string[] = [];
  for (const name of toolNames) {
    const label = conciseToolLabel(name);
    if (label && !labels.includes(label)) labels.push(label);
  }
  const shownLabels = labels.slice(0, maxLabels);
  const extraLabels = labels.length - shownLabels.length;
  const purpose = shownLabels.join(" · ") + (extraLabels > 0 ? ` +${extraLabels}` : "");
  const uniq: string[] = [];
  for (const s of selectors) {
    const v = (s ?? "").trim();
    if (v && !uniq.includes(v)) uniq.push(v);
  }
  return {
    purpose,
    selectors: uniq.slice(0, maxSelectors),
    extraSelectors: Math.max(0, uniq.length - maxSelectors),
  };
}

/** `3 lines · 412 B` — the code-panel meter. Bytes below 1 KB stay bytes. */
export function formatPayloadMeta(lineCount: number, charCount: number): string {
  const size = charCount < 1024
    ? `${charCount} B`
    : charCount < 1024 * 1024
      ? `${(charCount / 1024).toFixed(1)} KB`
      : `${(charCount / 1024 / 1024).toFixed(1)} MB`;
  return `${lineCount} line${lineCount === 1 ? "" : "s"} · ${size}`;
}
