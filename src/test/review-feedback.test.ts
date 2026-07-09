import { describe, it, expect } from "vitest";
import {
  REVIEW_STATE_GRADE,
  reviewStateToGrade,
  REVIEW_STATES,
  type ReviewState,
} from "@/lib/review";

// The analyst-verdict → evidence-grade mapping. Must stay in lockstep with the
// backend lib/evidence_classify.ts gradeFromReviewState and the apply_artifact_review
// SQL, or a Confirm in the UI won't match the grade the RPC writes.
describe("review verdict → classification_grade", () => {
  it("maps each state to the agreed grade", () => {
    expect(reviewStateToGrade("confirmed")).toBe("verified");
    expect(reviewStateToGrade("key")).toBe("verified");
    expect(reviewStateToGrade("recheck")).toBe("weak");
    expect(reviewStateToGrade("dismissed")).toBe("rejected");
    expect(reviewStateToGrade("wrong")).toBe("rejected");
    expect(reviewStateToGrade("new")).toBe("unclassified"); // reset → re-derive
  });

  it("covers every review state (no state without a grade)", () => {
    for (const s of REVIEW_STATES as ReviewState[]) {
      expect(REVIEW_STATE_GRADE[s]).toBeTruthy();
    }
  });

  it("only ever emits the six C-3 grade values", () => {
    const allowed = new Set(["verified", "probable", "weak", "contradicted", "rejected", "unclassified"]);
    for (const g of Object.values(REVIEW_STATE_GRADE)) expect(allowed.has(g)).toBe(true);
  });
});
