/**
 * The evidence-view contract: which rows may act as evidence, which must keep
 * driving safety warnings, and which are retained only for audit.
 *
 * Composed from the zero-dependency primitives in `artifact-exclusion.ts`.
 * This module imports NO report builder and NOT `intel.ts` — see the direction
 * diagram there. `src/test/import-boundaries.test.ts` enforces it.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import {
  isCollisionArtifact,
  isPipelineExcluded,
  isPossibleMinor,
  isRejectedReviewState,
  REDACTED_MINOR_PLACEHOLDER,
} from "@/lib/artifact-exclusion";

export type ReviewLike = ReviewState | null | undefined;
export type ReviewMap = Record<string, ReviewLike>;

/**
 * Why a row was excluded. Ordered by authority: an analyst verdict outranks a
 * pipeline heuristic, because it is more specific and more accountable.
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

export function isRejectedReview(review?: ReviewLike): boolean {
  return isRejectedReviewState(review ?? null);
}

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

export type ExcludedArtifact = {
  artifact: Artifact;
  reason: ExclusionReason;
  /** True when the value must not be printed in the ordinary dossier. */
  redacted: boolean;
  /** Value safe to display in an audit surface — redacted for possible minors. */
  displayValue: string;
};

/**
 * The three views every report surface must choose between.
 *
 * These are NOT three filters of convenience — they encode three different
 * obligations, and conflating any two of them has already caused a defect:
 *
 * - `analysisArtifacts` — may influence identity, confidence, KPIs, evidence
 *   tables, charts, risk, pivots and evidentiary coverage.
 * - `safetyArtifacts` — the FULL population. Safety warnings (possible-minor,
 *   adult x minor collision) must be computed from this, never from
 *   `analysisArtifacts`. Rejecting a minor row must not delete the warning that
 *   a minor is implicated.
 * - `excludedArtifacts` — retained for audit, with possible-minor values
 *   redacted so the ordinary dossier never prints a rejected minor's identifier.
 */
export type EvidenceViews = {
  analysisArtifacts: Artifact[];
  safetyArtifacts: Artifact[];
  excludedArtifacts: ExcludedArtifact[];
};

/** Every exclusion reason — the default for surfaces with no other handling. */
export const ALL_EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "analyst_rejected",
  "collision",
  "pipeline_excluded",
];

/**
 * Reasons that remove a row from the ANALYSIS view in the markdown report.
 *
 * `collision` is absent because `buildReportMarkdown` already quarantines
 * collision rows into a dedicated "Collision / Likely Unrelated" section;
 * partitioning them here as well would empty that section. This carve-out is
 * pinned by a test — see report-exclusion.test.ts "collision section survives".
 */
export const REPORT_EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "analyst_rejected",
  "pipeline_excluded",
];

/**
 * Build the three views in one pass.
 *
 * `safetyArtifacts` is always the complete input, by construction — it is
 * returned so call sites name the obligation explicitly rather than reaching
 * for whichever array happens to be in scope.
 */
export function buildEvidenceViews(
  artifacts: Artifact[],
  reviews?: ReviewMap,
  opts?: { reasons?: readonly ExclusionReason[] },
): EvidenceViews {
  const active = new Set(opts?.reasons ?? ALL_EXCLUSION_REASONS);
  const analysisArtifacts: Artifact[] = [];
  const excludedArtifacts: ExcludedArtifact[] = [];
  for (const a of artifacts) {
    const reason = exclusionReason(a, reviews?.[a.id]);
    if (reason && active.has(reason)) {
      const redacted = isPossibleMinor(a);
      excludedArtifacts.push({
        artifact: a,
        reason,
        redacted,
        displayValue: redacted ? REDACTED_MINOR_PLACEHOLDER : a.value,
      });
    } else {
      analysisArtifacts.push(a);
    }
  }
  return { analysisArtifacts, safetyArtifacts: artifacts, excludedArtifacts };
}

/**
 * Back-compat shim over `buildEvidenceViews`. Prefer the three-view form at new
 * call sites — it forces the caller to say which obligation it is serving.
 */
export function partitionExcluded(
  artifacts: Artifact[],
  reviews?: ReviewMap,
  opts?: { reasons?: readonly ExclusionReason[] },
): { included: Artifact[]; excluded: ExcludedArtifact[] } {
  const v = buildEvidenceViews(artifacts, reviews, opts);
  return { included: v.analysisArtifacts, excluded: v.excludedArtifacts };
}
