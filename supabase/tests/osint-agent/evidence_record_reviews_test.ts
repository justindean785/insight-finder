/**
 * evidence_record_reviews_test.ts — #479, the analyst-rejection boundary.
 *
 * THE DEFECT THIS PINS. The Evidence Record's whole value is that it is believed:
 * it prints under a heading that says "authoritative" precisely so it outranks
 * the model's prose. That makes republishing a finding the analyst marked
 * `dismissed` or `wrong` strictly worse than printing nothing — it spends the
 * block's credibility overturning the analyst's own verdict, in the one place a
 * reader has been told to trust over the narrative.
 *
 * These tests drive the REAL two-step the call site runs, in the same order:
 *
 *     salvageArts → dropRejectedArtifacts(rows, turnReviews) → buildEvidenceRecord
 *
 * `evidence_record_wiring_test.ts` pins that index.ts actually composes them that
 * way; this file pins what the composition does. Neither is sufficient alone —
 * that split is the same one reviews_test.ts / reviews_wiring_test.ts already use.
 *
 * ONE THING THAT IS DELIBERATELY NOT HERE: confidence adjustment. The call site
 * uses `dropRejectedArtifacts`, NOT `applyReviewsToArtifacts`, so a `confirmed`
 * or `key` verdict cannot raise a printed number. That is asserted below, because
 * swapping one call for the other is a one-word edit that looks like a tidy-up.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALL_FINDINGS_REJECTED_LINE,
  NO_FINDINGS_LINE,
  REVIEW_UNAVAILABLE_LINE,
  buildEvidenceRecord,
  isFindingRow,
} from "../../functions/osint-agent/lib/evidence-record.ts";
import {
  dropRejectedArtifacts,
  emptyReviewLoad,
  normalizeArtifactKey,
  type ReviewLoad,
} from "../../functions/osint-agent/reviews.ts";
import { hasReportShape } from "../../functions/osint-agent/orchestrator-finalize.ts";

const load = (byId: Record<string, string>, rejectedKeys: string[] = []): ReviewLoad => ({
  ok: true,
  byId: new Map(Object.entries(byId)),
  rejectedKeys: new Set(rejectedKeys),
  rejectedRows: [],
  error: null,
});

const finding = (id: string, value: string, confidence = 50) => ({
  id, kind: "finding", value, confidence, source: "oathnet_lookup", metadata: {},
});

/** The call site's exact composition (index.ts, persistFinalMessages). Kept to
 *  three lines so it stays a driver of the shipped functions, not a second
 *  implementation of them. */
function record(rows: Array<Record<string, unknown>>, review: ReviewLoad): string {
  const kept = review.ok ? dropRejectedArtifacts(rows, review) : [];
  const rejectedFindingCount = review.ok
    ? rows.filter(isFindingRow).length - kept.filter(isFindingRow).length
    : 0;
  return buildEvidenceRecord({
    rows: kept,
    totalArtifactCount: rows.length,
    retrieval: "complete",
    reviews: review.ok ? "applied" : "unavailable",
    rejectedFindingCount,
  });
}

Deno.test("an unreviewed finding still renders", () => {
  const md = record([finding("a1", "the adjudicated conclusion")], load({}));
  assertStringIncludes(md, "the adjudicated conclusion");
  assert(!md.includes(NO_FINDINGS_LINE));
});

Deno.test("a DISMISSED finding is never republished as authoritative", () => {
  const md = record([finding("a1", "the rejected conclusion")], load({ a1: "dismissed" }));
  assert(!md.includes("the rejected conclusion"), "the analyst's verdict outranks this block");
  assertStringIncludes(md, ALL_FINDINGS_REJECTED_LINE);
});

Deno.test("a finding marked WRONG is never republished either", () => {
  const md = record([finding("a1", "the false conclusion")], load({ a1: "wrong" }));
  assert(!md.includes("the false conclusion"));
  assertStringIncludes(md, ALL_FINDINGS_REJECTED_LINE);
});

Deno.test("re-recording a rejected finding under a NEW id does not restore it", () => {
  // The bypass reviews.ts already closes by normalized kind|value. Without it, a
  // rerun that records the same conclusion again gets a fresh uuid, no verdict
  // attaches to it, and the analyst's rejection silently lapses.
  const md = record(
    [finding("brand-new-id", "The Subject   Operates The Domain")],
    load({}, [normalizeArtifactKey("finding", "the subject operates the domain")]),
  );
  assert(!md.includes("Operates The Domain"), "same value, new id — still rejected");
  assertStringIncludes(md, ALL_FINDINGS_REJECTED_LINE);
});

Deno.test("one rejected and one valid finding leaves exactly the valid one", () => {
  const md = record(
    [finding("a1", "the rejected conclusion", 70), finding("a2", "the standing conclusion", 60)],
    load({ a1: "dismissed" }),
  );
  assertStringIncludes(md, "the standing conclusion");
  assert(!md.includes("the rejected conclusion"));
  assertStringIncludes(md, "1 further recorded finding row was excluded by analyst review");
  assert(!md.includes(NO_FINDINGS_LINE), "one finding remains, so this is not the empty state");
});

Deno.test("ALL findings rejected says so — it does not say none were recorded", () => {
  // The two statements blame opposite parties. "Nothing was adjudicated by the
  // scoring engine" would erase the analyst's work and attribute the silence to
  // the engine, on a run where the engine adjudicated twice and was overruled.
  const md = record(
    [finding("a1", "first"), finding("a2", "second"), { id: "b1", kind: "email", value: "x@y.z", confidence: 80, metadata: {} }],
    load({ a1: "dismissed", a2: "wrong" }),
  );
  assertStringIncludes(md, ALL_FINDINGS_REJECTED_LINE);
  assertStringIncludes(md, "2 recorded finding rows were dismissed or marked wrong");
  assert(!md.includes(NO_FINDINGS_LINE), "the engine DID adjudicate — the analyst overruled it");
  assert(!md.includes("first") && !md.includes("second"));
});

Deno.test("zero findings and zero rejections still reads as never adjudicated", () => {
  // The common production state must not drift into the rejection wording.
  const md = record([{ id: "b1", kind: "email", value: "x@y.z", confidence: 80, metadata: {} }], load({}));
  assertStringIncludes(md, NO_FINDINGS_LINE);
  assert(!md.includes(ALL_FINDINGS_REJECTED_LINE));
});

Deno.test("UNREADABLE verdicts fail closed: nothing is published", () => {
  // `{ ok:false }` is what reviews.ts returns on an artifact_reviews outage. It
  // means "we do not know what the analyst rejected", and publishing the raw
  // population against that is how a dismissed finding returns.
  const md = record([finding("a1", "the possibly-rejected conclusion")], emptyReviewLoad(false, "boom"));
  assertStringIncludes(md, REVIEW_UNAVAILABLE_LINE);
  assert(!md.includes("the possibly-rejected conclusion"), "unknown verdicts must publish nothing");
  assert(!md.includes(NO_FINDINGS_LINE), "and must not claim nothing was recorded");
  assert(!md.includes(ALL_FINDINGS_REJECTED_LINE), "nor that the analyst rejected anything");
});

Deno.test("review state unavailable is not the same string as retrieval unavailable", () => {
  // Two different reads fail for two different reasons; an operator reading the
  // stored message should be able to tell which one did.
  const reviewsDown = record([finding("a1", "x")], emptyReviewLoad(false, "boom"));
  const artifactsDown = buildEvidenceRecord({
    rows: [], totalArtifactCount: 0, retrieval: "unavailable", reviews: "applied", rejectedFindingCount: 0,
  });
  assert(reviewsDown !== artifactsDown);
  assertEquals(hasReportShape(reviewsDown), false, "and neither may read as a report");
  assertEquals(hasReportShape(artifactsDown), false);
});

Deno.test("an unrecognised review authority fails closed, like an absent one", () => {
  for (const bad of [undefined, null, "", "ok", "APPLIED", true, 1, {}]) {
    const md = buildEvidenceRecord({
      rows: [finding("a1", "the conclusion")],
      totalArtifactCount: 1,
      retrieval: "complete",
      reviews: bad as never,
      rejectedFindingCount: 0,
    });
    assertStringIncludes(md, REVIEW_UNAVAILABLE_LINE, `reviews ${JSON.stringify(bad)}`);
    assert(!md.includes("the conclusion"), `reviews ${JSON.stringify(bad)} must publish nothing`);
  }
});

// ── The scoring boundary: rejection authority only, never review deltas ────────

Deno.test("a CONFIRMED verdict does not raise the number the block prints", () => {
  // applyReviewsToArtifacts would add +REVIEW_DELTA here. The Evidence Record's
  // contract is min(stored confidence, recorded cap) and nothing else — an
  // analyst attestation belongs to the review surface, not to this block's
  // arithmetic. Swapping the call is a one-word edit; this is what catches it.
  const md = record([finding("a1", "the conclusion", 50)], load({ a1: "confirmed" }));
  assertStringIncludes(md, "50% — Weak");
  assert(!md.includes("Possible") && !md.includes("Likely"), "no verdict may promote a tier here");
});

Deno.test("KEY and RECHECK verdicts do not move the number either", () => {
  for (const state of ["key", "recheck"]) {
    const md = record([finding("a1", "the conclusion", 50)], load({ a1: state }));
    assertStringIncludes(md, "50% — Weak", `state ${state}`);
  }
});

Deno.test("a positive verdict does not add a review_state tag to the printed row", () => {
  // dropRejectedArtifacts returns the row untouched; applyReviewsToArtifacts
  // spreads `review_state` onto it. Nothing model- or analyst-authored belongs in
  // this block's value column.
  const md = record([finding("a1", "the conclusion", 50)], load({ a1: "confirmed" }));
  assert(!md.includes("review_state"));
  assert(!md.includes("confirmed"), "the verdict string must not reach the block");
});
