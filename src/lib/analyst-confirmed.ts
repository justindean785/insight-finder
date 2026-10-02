/**
 * analyst-confirmed.ts — when a row's confidence SLOT reads "Analyst-confirmed"
 * instead of the machine score.
 *
 * WHY. An analyst marks a row Confirmed or Key and the number beside it does not
 * move. That is deliberate and stays deliberate: `labelForArtifact` gives an
 * analyst decision its own rung, ATTESTED, which "never touches the figure"
 * (intel.ts), and `display-confidence.ts` refuses to fold review deltas into the
 * number because a decision is not evidence. But a machine 50 sitting unchanged
 * beside the analyst's own Confirm reads as if the product ignored the decision.
 * So on the evidence board and the evidence cards the slot SAYS what happened —
 * "Analyst-confirmed" — and the machine score moves into the slot's accessible
 * name and the ⓘ popover, where it is still one click away and still the same
 * `displayConfidence(a).effective` every other surface renders.
 *
 * THIS IS PRESENTATION ONLY. It computes no score, applies no cap and changes no
 * label. Nothing here may call `adjustedConfidence`.
 *
 * ONE PREDICATE, AND IT IS THE LABEL LADDER'S. The slot reads "Analyst-confirmed"
 * exactly when `labelForArtifact(a, review) === "ATTESTED"` — not a re-derivation
 * from the review state. That inherits every floor the ladder already enforces,
 * with no second path to drift:
 *   - a row whose EVIDENCE clears CONFIRMED keeps CONFIRMED, and keeps its number;
 *   - an active `subject_unlinked` quarantine is never ATTESTED (only
 *     `linkage_confirmed` clears it), so a quarantined row keeps its number;
 *   - a `possible_minor` row is never ATTESTED (the minor-safety hard floor);
 *   - a dismissal / `false_positive` is FAILED, a conflict is CONFLICT.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { labelForArtifact, type ReviewAdjustment } from "@/lib/intel";
import type { DisplayConfidence } from "@/lib/display-confidence";

/** The words the slot shows. One constant, so every surface spells it the same. */
export const ANALYST_CONFIRMED_TEXT = "Analyst-confirmed";

/** True when the row's confidence slot should read "Analyst-confirmed". */
export function isAnalystConfirmed(a: Artifact, review?: ReviewAdjustment): boolean {
  return labelForArtifact(a, review) === "ATTESTED";
}

type ScoreParts = Pick<DisplayConfidence, "effective" | "cap">;

/**
 * "Machine score: 50 (cap 50)" — the canonical figure, named for what it is.
 * `cap` is shown only when the server recorded one; `=== null`, never
 * truthiness, because a recorded cap of 0 is a real statement.
 */
export function machineScoreText(shown: ScoreParts): string {
  if (shown.effective === null) return "Machine score: none recorded";
  return shown.cap === null
    ? `Machine score: ${shown.effective}`
    : `Machine score: ${shown.effective} (cap ${shown.cap})`;
}

/** Accessible name for the slot: "Analyst-confirmed (machine score 50)". */
export function analystConfirmedLabel(shown: ScoreParts): string {
  return shown.effective === null
    ? `${ANALYST_CONFIRMED_TEXT} (no machine score recorded)`
    : `${ANALYST_CONFIRMED_TEXT} (machine score ${shown.effective})`;
}
