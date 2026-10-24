import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { PivotEligibility, RunnablePivot } from "@/lib/pivot-schema";
import type { NextStepItem } from "@/components/pivots/NextSteps";

/**
 * Why one runnable pivot is listed first, in plain sentences.
 *
 * READ-ONLY over signals the pivot engine and eligibility check already
 * produced. It adds no score and ranks nothing: the order comes from
 * `computePivots`, and this only says what is true about the pivot at the top
 * so the analyst can judge it. A reason is only emitted when its fact holds.
 */
const WIDE_FAN_OUT = new Set(["email", "username"]);

export function explainPivot(
  pivot: RunnablePivot,
  eligibility: PivotEligibility | null,
  artifactsById: ReadonlyMap<string, Artifact>,
): string[] {
  const reasons: string[] = [];
  const sources = pivot.sourceArtifactIds.filter((id) => artifactsById.has(id));
  if (pivot.status === "new") reasons.push("No tool has run against it yet.");
  if (sources.length === 1) {
    reasons.push("Only one recorded row points at it, so running it is how it gets a second source.");
  } else if (sources.length === 0 && pivot.sourceArtifactIds.length === 0) {
    reasons.push("The report suggested it; no recorded row backs it yet.");
  }
  if (eligibility?.linkage === "linked") reasons.push("Its source row counts toward the subject.");
  if (WIDE_FAN_OUT.has(pivot.targetType)) {
    reasons.push(`A ${pivot.targetType} usually leads to the most linked accounts.`);
  }
  if (pivot.priority === "high") reasons.push("The report ranked it high.");
  return reasons.slice(0, 3);
}

/** A pivot Auto-run may start without the analyst reading a preview: unsearched,
 *  runnable, and no warning attached (no quarantined source, no rerun). */
export function isAutoRunnable(item: NextStepItem): boolean {
  if (item.kind !== "pivot" || item.validation.status !== "valid" || !item.eligibility) return false;
  return item.validation.pivot.status === "new" && item.eligibility.runnable && item.eligibility.warnings.length === 0;
}

/** The first runnable pivot in list order (the engine's order), or null. */
export function pickBestPivot(items: NextStepItem[]): Extract<NextStepItem, { kind: "pivot" }> | null {
  for (const item of items) {
    if (item.kind === "pivot" && item.validation.status === "valid" && item.eligibility?.runnable) return item;
  }
  return null;
}

/**
 * Must the analyst read the preview before this pivot starts? Yes for a rerun,
 * a quarantined or unlinked source, a conflict or a weak lead. The single
 * warning "suggested by the report text" is the ordinary case for a pivot the
 * agent proposed before any row existed, and does not by itself force a preview.
 */
export function requiresPreview(e: PivotEligibility): boolean {
  if (e.rerun || e.linkage === "unproven") return true;
  if (e.linkage === "report") return e.warnings.length > 1;
  return e.warnings.length > 0;
}
