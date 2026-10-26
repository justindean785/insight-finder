/**
 * Builds the runnable queue, including validation and eligibility. In the
 * workspace, CasePivotQueueProvider owns its inputs and publishes ONE list
 * for the transcript, mobile cards and Workbench. Sharing this function alone
 * does not synchronize independently loaded data.
 */

import type { NextStepItem } from "@/components/pivots/NextSteps";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { RecommendedPivot } from "@/lib/recommended-pivots";
import type { ReviewState } from "@/lib/review";
import { computePivots } from "@/lib/pivot-engine";
import { cardDedupeKey } from "@/lib/next-step-cards";
import { validatePivotSuggestion, pivotSuggestionInput, pivotEligibility } from "@/lib/pivot-schema";

/** Shared with WorkbenchNext.tsx — one cap on the actionable queue. */
export const WORKBENCH_RUNNABLE_LIMIT = 5;

export interface WorkbenchQueueInput {
  artifacts: Artifact[];
  seedValue: string | null;
  reportPivots: RecommendedPivot[];
  skipSet: Set<string>;
  queriedSet: Set<string>;
  reviews: Record<string, ReviewState>;
}

/**
 * The pivots the Workbench Next tab would render RIGHT NOW
 * — the engine's new-status candidates, deduped by card key, validated, and
 * capped at WORKBENCH_RUNNABLE_LIMIT. The transcript's compact handoff line
 * ("N next pivots ranked — open the workbench") shows this count so a reader
 * who clicks "Open Next pivots" finds exactly what the number promised.
 */
export function buildWorkbenchQueue(input: WorkbenchQueueInput): NextStepItem[] {
  const ranked = computePivots(input);
  const artifactsById = new Map(input.artifacts.map(a => [a.id, a]));
  const seen = new Set<string>();
  const items: NextStepItem[] = [];
  const repair: NextStepItem[] = [];
  let runnable = 0;
  for (const p of ranked.filter(c => c.status === "new")) {
    if (runnable >= WORKBENCH_RUNNABLE_LIMIT) break;
    const key = cardDedupeKey({ title: p.actionLabel, target: p.value });
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = validatePivotSuggestion(pivotSuggestionInput(p));
    if (validation.status !== "valid") {
      if (repair.length < 3) repair.push({ kind: "pivot", key, validation, eligibility: null });
      continue;
    }
    const eligibility = pivotEligibility(validation.pivot, { artifactsById, review: id => input.reviews[id] ?? "new" });
    if (!eligibility.runnable) continue;
    runnable++;
    items.push({ kind: "pivot", key, validation, eligibility });
  }
  return [...items, ...repair];
}

export function countWorkbenchRunnablePivots(input: WorkbenchQueueInput): number {
  return buildWorkbenchQueue(input).filter(i => i.kind === "pivot" && i.validation.status === "valid" && i.eligibility?.runnable).length;
}
