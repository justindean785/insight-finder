/**
 * Zero-dependency primitives for "is this row disqualified as evidence?".
 *
 * This module imports NOTHING but a type. That is the whole point: it is the
 * bottom of the dependency graph, so `exclusion.ts` can compose these
 * predicates without importing `intel.ts` and `intel.ts` can consult them
 * without importing `exclusion.ts`.
 *
 * Required direction (enforced by src/test/import-boundaries.test.ts):
 *
 *     artifact-exclusion.ts   (imports nothing)
 *        ^            ^
 *        |            |
 *   exclusion.ts    intel.ts
 *        ^
 *        |
 *     intel.ts
 *
 * A previous revision put `isPipelineExcluded` in `intel.ts` and had
 * `exclusion.ts` import it, while `intel.ts` imported `exclusion.ts` — a real
 * cycle, documented in both files by comments asserting the opposite.
 */

/** Structural shape these predicates need. Deliberately not the full Artifact. */
export type ExclusionCandidate = {
  kind: string;
  metadata: Record<string, unknown> | null;
};

/**
 * Analyst verdicts that mean "the analyst rejected this".
 *
 * Canonical definition. `src/lib/review.ts` re-exports it as
 * `REJECTED_REVIEW_STATES` so there is exactly one source of truth — review.ts
 * is a React module (it pulls in the Supabase client and `sonner`) and must not
 * be the thing pure logic reaches into.
 */
export const REJECTED_REVIEW_STATE_VALUES: ReadonlySet<string> = new Set([
  "dismissed",
  "wrong",
]);

export function isRejectedReviewState(review?: string | null): boolean {
  return !!review && REJECTED_REVIEW_STATE_VALUES.has(review);
}

/** Kinds the pipeline writes when it has already decided a row is not the subject. */
const PIPELINE_EXCLUDED_KINDS = new Set(["excluded", "excluded_collision"]);

/**
 * The pipeline's definitive "this is not the subject" signal.
 *
 * Deliberately NARROWER than `isCollisionArtifact`: it does not match
 * `metadata.collision`, so an ordinary conflict row keeps its CONFLICT label
 * rather than being reclassified as a decided negative.
 */
export function isPipelineExcluded(a: ExclusionCandidate): boolean {
  if (PIPELINE_EXCLUDED_KINDS.has((a.kind ?? "").toLowerCase())) return true;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return typeof m.status === "string" && m.status.toLowerCase() === "excluded";
}

/**
 * A namesake / unrelated-entity quarantine marker.
 *
 * Moved here from `report-hygiene.ts`, which re-exports it unchanged so its
 * existing importers keep working. It never had any dependency beyond the
 * artifact shape.
 */
export function isCollisionArtifact(a: ExclusionCandidate): boolean {
  const kind = (a.kind ?? "").toLowerCase();
  if (kind === "excluded_collision") return true;
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  // metadata.status === "excluded" is the pipeline's definitive "not the subject"
  // signal (a namesake / unrelated entity). It must quarantine like an
  // excluded_collision so a same-name profile can neither seed the subject's
  // identity clusters nor let the report read "No collisions flagged" while such
  // rows exist.
  if (typeof m.status === "string" && m.status.toLowerCase() === "excluded") return true;
  return m.excluded_collision === true || m.collision === true || m.possible_collision === true;
}

/**
 * Does this row carry a minor signal?
 *
 * Load-bearing for child safety: a row matching this MUST keep driving the
 * report's minor-safety warnings even when it has been rejected or excluded,
 * and its raw value MUST NOT be printed in the ordinary dossier.
 */
export function isPossibleMinor(a: ExclusionCandidate): boolean {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  return m.possible_minor === true || m.minor_warning === true;
}

/** Placeholder shown instead of a possible-minor value that was excluded. */
export const REDACTED_MINOR_PLACEHOLDER = "[redacted — possible minor]";
