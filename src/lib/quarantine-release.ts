/**
 * quarantine-release.ts — the analyst's explicit release of a linkage quarantine.
 *
 * THE DEFECT THIS CLOSES. `linkage_confirmed` is the documented escape hatch from
 * `subject_unlinked` quarantine, and it is honoured everywhere: `isQuarantined`
 * (quarantine.ts), the pivot engine, the entity graph, the report, the confidence
 * dimensions, and — since #518 — the DISPATCH boundary in the edge function. Every
 * boundary reads it. Nothing in the product could ever WRITE it.
 *
 * Before #518 that was a missing convenience: a quarantined row lost authority but
 * could still be dispatched. #518 made quarantine dispatch-blocking and gave `force`
 * no override, deliberately. That turned the missing writer into an active
 * data-loss defect — a row auto-quarantined in error (a false `queryIsNameOnly`
 * on an address seed, say) can never be pivoted on again, by anyone, ever.
 *
 * WHAT THIS MODULE IS NOT. It is not a quarantine redesign, it does not weaken
 * #518, and it is not reachable from `force`. Release stays an explicit, per-row
 * human decision.
 *
 * WHY NOT THE REVIEW CONTROL. `intel.ts` is explicit: `linkage_confirmed` is
 * "explicit and durable, not a one-click verdict (the review control is known to
 * invert on quarantined rows, so it must not be able to overrule an evidence
 * ceiling on a mis-click)". `quarantine.ts` says the same from the other side:
 * `reviewed`/`confirmed`/`key` answer "is this value real?", never "whose is it?".
 * So release is its OWN action with its own wording — never a review state, and
 * never inferred from one.
 *
 * PROVENANCE IS PRESERVED, NOT REWRITTEN. `subject_unlinked`, the recorded
 * `subject_unlinked_reason`, collision flags and the recorded confidence cap all
 * survive the release untouched. The row's history still says the machine
 * quarantined it and why; the release is an ADDITIVE human ruling layered on top.
 * That is what lets `quarantineReason` keep quoting the backend verbatim
 * afterwards, and it is why this returns a PATCH rather than a rebuilt object.
 */
import { isQuarantined } from "@/lib/quarantine";

/** The additive ruling. `linkage_confirmed` is what every predicate reads; the
 *  timestamp is audit provenance and is deliberately consulted by nothing. */
export type ReleasePatch = {
  linkage_confirmed: true;
  linkage_confirmed_at: string;
};

/**
 * The metadata patch that releases a linkage quarantine, or `null` when the row
 * is not under one.
 *
 * FAILS CLOSED, and that is the abuse guard. A row that is not quarantined —
 * never flagged, already released, or metadata that is malformed/absent — returns
 * `null`, so the mutation path cannot be used to stamp `linkage_confirmed` onto
 * arbitrary artifacts. `isQuarantined` is reused verbatim rather than
 * re-implemented: the predicate that BLOCKS is the predicate that gates the
 * release, so the two can never drift apart.
 */
export function releasePatch(metadata: unknown, now: Date = new Date()): ReleasePatch | null {
  if (!isQuarantined(metadata)) return null;
  return { linkage_confirmed: true, linkage_confirmed_at: now.toISOString() };
}

/** Is the release action offerable for this row? Exactly `isQuarantined`, named
 *  for the call site so a reader of the UI does not have to invert the predicate
 *  in their head. */
export function canReleaseLinkage(metadata: unknown): boolean {
  return isQuarantined(metadata);
}

/** The analyst-facing wording. Kept here, beside the predicate, so the action and
 *  its claim ship together — the sentence an analyst is agreeing to IS part of the
 *  contract, and a release offered under vaguer words is a different decision. */
export const RELEASE_ACTION_LABEL = "Confirm linkage to subject";
export const RELEASE_CONFIRM_TITLE = "Confirm this belongs to the investigated subject?";
export const RELEASE_CONFIRM_BODY =
  "The pipeline could not prove this row is linked to the subject of this investigation, " +
  "so it was quarantined: withheld from identity clusters, graph identity edges, confidence, " +
  "the report, and — since it may not start new work — from being used as a pivot.\n\n" +
  "Releasing it records YOUR ruling that the linkage holds. This is a statement about " +
  "PROVENANCE (whose this is), not about whether the value is real — that is what the " +
  "review controls say. The original quarantine and its recorded reason are kept either way.";
