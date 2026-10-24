import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots, type DisplayPivot } from "@/lib/pivot-engine";
import type { ReviewState } from "@/lib/review";
import {
  pivotEligibility,
  pivotSuggestionInput,
  validatePivotSuggestion,
  type PivotEligibility,
  type RunnablePivot,
} from "@/lib/pivot-schema";

export type ArtifactPivot =
  | { available: true; pivot: RunnablePivot; eligibility: PivotEligibility }
  | { available: false; why: string };

/**
 * The pivot the Evidence drawer offers for ONE recorded row.
 *
 * It does not build a pivot of its own: it asks the same engine the Pivots view
 * and the chat rail use (`computePivots`) and takes the entry that came from this
 * artifact, then runs it through the same validation and eligibility. So a row
 * the engine will not pivot on (an analyst-rejected identity, a credential-shaped
 * value, a kind with no pivot, the seed itself) is not offered here either, and
 * says why, instead of this surface becoming a second, looser path to a run.
 *
 * The analyst's skip list is deliberately NOT applied: skipping hides a lead from
 * the suggestions, and pressing Pivot on this row is an explicit request for it.
 */
export function pivotForArtifact(
  artifact: Artifact,
  ctx: {
    artifacts: Artifact[];
    seedValue: string | null;
    queriedSet: Set<string>;
    reviews: Record<string, string | null | undefined>;
    reviewOf: (id: string) => ReviewState;
  },
): ArtifactPivot {
  const all: DisplayPivot[] = computePivots({
    artifacts: ctx.artifacts,
    seedValue: ctx.seedValue,
    reportPivots: [],
    skipSet: new Set(),
    queriedSet: ctx.queriedSet,
    reviews: ctx.reviews,
  });
  const mine = all.find((p) => p.sourceArtifactId === artifact.id);
  if (!mine) {
    return { available: false, why: "No pivot is offered for this row: its kind has no pivot, it is the case seed, or it was dismissed." };
  }
  const validation = validatePivotSuggestion(pivotSuggestionInput(mine));
  if (validation.status !== "valid") {
    return { available: false, why: `This row cannot be pivoted on: ${validation.problems.join("; ")}` };
  }
  const byId = new Map(ctx.artifacts.map((a) => [a.id, a] as const));
  const eligibility = pivotEligibility(validation.pivot, { artifactsById: byId, review: ctx.reviewOf });
  return { available: true, pivot: validation.pivot, eligibility };
}
