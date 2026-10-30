/**
 * Shared "actionable Next-steps queue" — one count the transcript's compact
 * summary and the Workbench's Next tab both read, so they can never disagree.
 *
 * The transcript previously ran a tighter model (3 runnable pivots + 1 generic
 * fallback = 4 cards) because it was the ONLY recommendations surface. Now the
 * Workbench Next tab is the single actionable queue (register item 1), and the
 * transcript's visible summary line names the Workbench's figure so both read
 * the same number.
 *
 * This file deliberately contains only the queue shape, not the full
 * NextStepItem construction — the two callers continue to build their own
 * NextStepItem[] for rendering (with ChatWindow's fallback-only generic
 * actions) because the full item structure carries validation + eligibility
 * UX the two surfaces need differently.
 */

import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { RecommendedPivot } from "@/lib/recommended-pivots";
import type { ReviewState } from "@/lib/review";
import { computePivots } from "@/lib/pivot-engine";
import { cardDedupeKey } from "@/lib/next-step-cards";
import { pivotRunKey } from "@/lib/pivot-runs";
import { validatePivotSuggestion, pivotSuggestionInput } from "@/lib/pivot-schema";

/** Shared with WorkbenchNext.tsx — one cap on the actionable queue. */
export const WORKBENCH_RUNNABLE_LIMIT = 5;

export interface WorkbenchQueueInput {
  artifacts: Artifact[];
  seedValue: string | null;
  reportPivots: RecommendedPivot[];
  skipSet: Set<string>;
  queriedSet: Set<string>;
  reviews: Record<string, ReviewState>;
  /** `pivotRunKey`s of pivots that are running or have a tool call recorded against them. The Workbench
   *  lists those above the queue (Running / Completed), not in it, so the count must leave them out too.
   *  Required: a caller that forgets it would print one more pivot than the Workbench shows. */
  sentKeys: ReadonlySet<string>;
}

/**
 * The count of runnable pivots the Workbench Next tab would render RIGHT NOW
 * — the engine's new-status candidates, deduped by card key, validated, and
 * capped at WORKBENCH_RUNNABLE_LIMIT. The transcript's compact handoff line
 * ("N next pivots ranked — open the workbench") shows this count so a reader
 * who clicks "Open Next pivots" finds exactly what the number promised.
 */
export function countWorkbenchRunnablePivots(input: WorkbenchQueueInput): number {
  const ranked = computePivots({
    artifacts: input.artifacts,
    seedValue: input.seedValue,
    reportPivots: input.reportPivots,
    skipSet: input.skipSet,
    queriedSet: input.queriedSet,
    reviews: input.reviews,
  });
  const seen = new Set<string>();
  let runnable = 0;
  for (const p of ranked.filter((c) => c.status === "new" && !input.sentKeys.has(pivotRunKey(c.type, c.value)))) {
    if (runnable >= WORKBENCH_RUNNABLE_LIMIT) break;
    const key = cardDedupeKey({ title: p.actionLabel, target: p.value });
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = validatePivotSuggestion(pivotSuggestionInput(p));
    if (validation.status !== "valid") continue;
    runnable++;
  }
  return runnable;
}
