import type { Artifact } from "@/hooks/useThreadArtifacts";
import { canonicalKey, computePivots, type DisplayPivot } from "@/lib/pivot-engine";
import { KIND_TO_PIVOT } from "@/lib/intel";
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
  // The engine collapses rows with the same pivot identity (type + normalized
  // value) into ONE pivot that carries the first row's id, so a second row of
  // the same identity (a `handle` beside a `username`, say) is matched by that
  // identity, not by id alone.
  const rowType = KIND_TO_PIVOT[artifact.kind.toLowerCase()];
  const rowKey = rowType ? canonicalKey({ type: rowType, value: artifact.value }) : null;
  const mine = all.find((p) => p.sourceArtifactId === artifact.id)
    ?? (rowKey ? all.find((p) => canonicalKey(p) === rowKey) : undefined);
  if (!mine) {
    return { available: false, why: "No pivot is offered for this row: its kind has no pivot, it is the case seed, or it was dismissed." };
  }
  // Eligibility is judged on the row the analyst is looking at, even when the
  // engine attributed the identity to a duplicate row.
  const validation = validatePivotSuggestion({ ...pivotSuggestionInput(mine), sourceArtifactIds: mine.sourceArtifactId.startsWith("report-pivot-") ? [] : [artifact.id] });
  if (validation.status !== "valid") {
    return { available: false, why: `This row cannot be pivoted on: ${validation.problems.join("; ")}` };
  }
  const byId = new Map(ctx.artifacts.map((a) => [a.id, a] as const));
  const eligibility = pivotEligibility(validation.pivot, { artifactsById: byId, review: ctx.reviewOf });
  return { available: true, pivot: validation.pivot, eligibility };
}
