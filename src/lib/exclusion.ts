/**
 * One predicate for "this row must not be presented as evidence".
 *
 * Composed from the taxonomy that ALREADY exists — no new states are invented:
 *   - `REJECTED_REVIEW_STATES` (src/lib/review.ts) — the analyst said no.
 *   - `isCollisionArtifact`    (src/lib/report-hygiene.ts) — the pipeline said
 *     "namesake / unrelated entity".
 *   - `isPipelineExcluded`     (src/lib/intel.ts) — the `excluded` /
 *     `excluded_collision` kinds and `metadata.status = "excluded"`.
 *
 * Why this module exists: the report builders each re-derived a partial version
 * of "should this show?", and three of them derived none at all, which is how
 * analyst-rejected rows kept surfacing in the Evidence Matrix, Tool Coverage
 * and Timeline. One predicate, one place to change it.
 *
 * Import direction is deliberately acyclic: this module depends on intel.ts and
 * report-hygiene.ts, never the reverse.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { REJECTED_REVIEW_STATES, type ReviewState } from "@/lib/review";
import { isCollisionArtifact } from "@/lib/report-hygiene";
import { isPipelineExcluded } from "@/lib/intel";

/** A review verdict as the report builders see it — possibly absent. */
export type ReviewLike = ReviewState | null | undefined;

/** Reviews keyed by artifact id, matching `ReportInput.reviews`. */
export type ReviewMap = Record<string, ReviewLike>;

/**
 * Why a row was excluded. Ordered by authority: an analyst verdict outranks a
 * pipeline heuristic, because it is the more specific and more accountable
 * signal.
 */
export type ExclusionReason =
  | "analyst_rejected"
  | "collision"
  | "pipeline_excluded";

export const EXCLUSION_REASON_LABEL: Record<ExclusionReason, string> = {
  analyst_rejected: "Rejected by analyst",
  collision: "Namesake / unrelated entity",
  pipeline_excluded: "Excluded by pipeline",
};

/** True when the analyst's verdict rejects the row (`dismissed` or `wrong`). */
export function isRejectedReview(review?: ReviewLike): boolean {
  return !!review && REJECTED_REVIEW_STATES.has(review as ReviewState);
}

/**
 * The single reason this row must not be presented as evidence, or null when
 * it is presentable.
 */
export function exclusionReason(
  a: Artifact,
  review?: ReviewLike,
): ExclusionReason | null {
  if (isRejectedReview(review)) return "analyst_rejected";
  if (isCollisionArtifact(a)) return "collision";
  if (isPipelineExcluded(a)) return "pipeline_excluded";
  return null;
}

export function isExcludedArtifact(a: Artifact, review?: ReviewLike): boolean {
  return exclusionReason(a, review) !== null;
}

/** Every exclusion reason — the default for surfaces with no other handling. */
export const ALL_EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "analyst_rejected",
  "collision",
  "pipeline_excluded",
];

/**
 * Reasons that apply to the main markdown report. `collision` is deliberately
 * ABSENT: `buildReportMarkdown` already quarantines collision rows into their
 * own "Collision / Likely Unrelated" section, and excluding them here as well
 * would empty that section rather than fix anything.
 */
export const REPORT_EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "analyst_rejected",
  "pipeline_excluded",
];

export type ExcludedArtifact = { artifact: Artifact; reason: ExclusionReason };

/**
 * Split rows into what may be analysed and what may not. Total is preserved —
 * excluded rows are surfaced in an appendix, never silently dropped.
 */
export function partitionExcluded(
  artifacts: Artifact[],
  reviews?: ReviewMap,
  opts?: { reasons?: readonly ExclusionReason[] },
): { included: Artifact[]; excluded: ExcludedArtifact[] } {
  const active = new Set(opts?.reasons ?? ALL_EXCLUSION_REASONS);
  const included: Artifact[] = [];
  const excluded: ExcludedArtifact[] = [];
  for (const a of artifacts) {
    const reason = exclusionReason(a, reviews?.[a.id]);
    if (reason && active.has(reason)) excluded.push({ artifact: a, reason });
    else included.push(a);
  }
  return { included, excluded };
}
