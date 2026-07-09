// lib/evidence_classify_test.ts — C-3 acceptance: evidence grading DERIVED from the
// C-1 tier system (never a hardcoded "soft"). If these fail, STOP and re-plan.
//
// The enum grade lives in a NON-hashed `classification_grade` column (see
// 20260709_evidence_classification_grade.sql) so the end-of-cycle reclassification
// pass can update it without breaking the tamper-evident chain of custody.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  computeReclassification,
  EVIDENCE_GRADES,
  type EvidenceRow,
  gradeForArtifact,
  gradeFromReviewState,
  gradeFromSignals,
  gradeFromTier,
  gradeTag,
  isEvidenceGrade,
} from "./evidence_classify.ts";

// ---- tier → grade (the source-of-truth mapping) -------------------------------
Deno.test("C-3: each C-1 tier maps to the correct grade", () => {
  assertEquals(gradeFromTier("Confirmed"), "verified");
  assertEquals(gradeFromTier("Likely"), "probable");
  assertEquals(gradeFromTier("Possible"), "weak");
  assertEquals(gradeFromTier("Weak"), "weak");
  assertEquals(gradeFromTier("Unverified"), "weak");
  assertEquals(gradeFromTier("Excluded"), "contradicted"); // collision-excluded linkage
  assertEquals(gradeFromTier(null), "unclassified"); // no C-1 result yet
  assertEquals(gradeFromTier("nonsense"), "unclassified");
});

// ---- artifact metadata → grade ------------------------------------------------
Deno.test("C-3: a Confirmed artifact grades verified", () => {
  assertEquals(
    gradeForArtifact({ kind: "email", metadata: { confidence_tier: "Confirmed", promoted_confidence: 95 } }),
    "verified",
  );
});

Deno.test("C-3: a Likely artifact grades probable", () => {
  assertEquals(
    gradeForArtifact({ kind: "username", metadata: { confidence_tier: "Likely", promoted_confidence: 78 } }),
    "probable",
  );
});

Deno.test("C-3: Possible and Weak artifacts grade weak", () => {
  assertEquals(gradeForArtifact({ metadata: { confidence_tier: "Possible", promoted_confidence: 55 } }), "weak");
  assertEquals(gradeForArtifact({ metadata: { confidence_tier: "Weak", promoted_confidence: 33 } }), "weak");
});

Deno.test("C-3: a contradiction artifact grades contradicted (regardless of tier)", () => {
  assertEquals(gradeForArtifact({ kind: "contradiction", metadata: {} }), "contradicted");
  assertEquals(gradeForArtifact({ kind: "email", metadata: { status: "needs_review" } }), "contradicted");
  assertEquals(gradeForArtifact({ kind: "excluded_collision", metadata: {} }), "contradicted");
  // A capped-at-40 contradicted member: tier says Weak, but the contradiction signal wins.
  assertEquals(
    gradeForArtifact({ kind: "email", metadata: { confidence_tier: "Weak", promoted_confidence: 40, contradiction: true } }),
    "contradicted",
  );
});

Deno.test("C-3: no C-1 metadata → unclassified (NOT soft)", () => {
  assertEquals(gradeForArtifact({ kind: "email", metadata: {} }), "unclassified");
  assertEquals(gradeForArtifact({ kind: "email" }), "unclassified");
});

Deno.test("C-3: promoted_confidence alone (missing tier label) still derives a grade", () => {
  assertEquals(gradeForArtifact({ metadata: { promoted_confidence: 92 } }), "verified");
  assertEquals(gradeForArtifact({ metadata: { promoted_confidence: 76 } }), "probable");
  assertEquals(gradeForArtifact({ metadata: { promoted_confidence: 20 } }), "weak");
});

Deno.test("C-3: user verdict overrides derivation (placeholder for the feedback loop)", () => {
  assertEquals(gradeFromSignals({ userRejected: true, confidenceTier: "Confirmed" }), "rejected");
  assertEquals(gradeFromSignals({ userVerified: true, confidenceTier: "Weak" }), "verified");
});

// ---- reclassification pass: 0 unclassified after clustering --------------------
Deno.test("C-3: reclassification pass leaves 0 unclassified rows", () => {
  const arts = [
    { id: "a1", value: "manzavisuals@proton.me", kind: "email", metadata: { confidence_tier: "Confirmed", promoted_confidence: 92 } },
    { id: "a2", value: "manza_visuals", kind: "username", metadata: { confidence_tier: "Likely", promoted_confidence: 78 } },
    { id: "a3", value: "hamzashakoor@gmail.com", kind: "email", metadata: { status: "needs_review", contradiction: true } },
  ];
  const rows: EvidenceRow[] = [
    { id: "e1", artifact_id: "a1", kind: "email", value: "manzavisuals@proton.me" }, // by artifact_id → verified
    { id: "e2", artifact_id: null, kind: "tool_query", value: "manza_visuals" }, // by value → probable
    { id: "e3", artifact_id: null, kind: "tool_query", value: "hamzashakoor@gmail.com" }, // by value → contradicted
    { id: "e4", artifact_id: null, kind: "tool_query", value: "breach_check_ran_no_hits" }, // orphan → weak floor
  ];
  const updates = computeReclassification(arts, rows);
  assertEquals(updates.length, 4);
  const grade = (id: string) => updates.find((u) => u.id === id)!.grade;
  assertEquals(grade("e1"), "verified");
  assertEquals(grade("e2"), "probable");
  assertEquals(grade("e3"), "contradicted");
  assertEquals(grade("e4"), "weak"); // procedural row with no clustered artifact floors to weak
  assert(updates.every((u) => u.grade !== "unclassified"), "NO row may remain unclassified after the pass");
});

// ---- analyst review verdict: highest precedence, survives re-derivation -------
Deno.test("C-4: metadata.review_state outranks the C-1 tier in both directions", () => {
  // Analyst confirmed a Weak-tier artifact → verified (survives next reclassify).
  assertEquals(
    gradeForArtifact({ kind: "email", metadata: { review_state: "confirmed", confidence_tier: "Weak", promoted_confidence: 30 } }),
    "verified",
  );
  // Analyst marked a Confirmed-tier artifact wrong → rejected.
  assertEquals(
    gradeForArtifact({ kind: "email", metadata: { review_state: "wrong", confidence_tier: "Confirmed", promoted_confidence: 95 } }),
    "rejected",
  );
  assertEquals(gradeForArtifact({ metadata: { review_state: "key", confidence_tier: "Possible" } }), "verified");
  assertEquals(gradeForArtifact({ metadata: { review_state: "recheck", confidence_tier: "Confirmed" } }), "weak");
  assertEquals(gradeForArtifact({ metadata: { review_state: "dismissed", confidence_tier: "Likely" } }), "rejected");
});

Deno.test("C-4: a reset/unknown review_state falls back to machine derivation", () => {
  assertEquals(gradeFromReviewState("new"), null);
  assertEquals(gradeFromReviewState(""), null);
  assertEquals(gradeFromReviewState(null), null);
  // No review_state → tier still governs.
  assertEquals(gradeForArtifact({ metadata: { confidence_tier: "Likely" } }), "probable");
});

// ---- M1: value-matching must not re-introduce cross-person bridging -----------
Deno.test("C-3 (M1): a shared NAME never bridges a procedural row to a verified subject", () => {
  // Two DIFFERENT people share the name "Hamza Shakoor"; one is Confirmed.
  const arts = [
    { id: "n1", value: "Hamza Shakoor", kind: "name", metadata: { confidence_tier: "Confirmed", promoted_confidence: 92 } },
    { id: "n2", value: "Hamza Shakoor", kind: "name", metadata: { confidence_tier: "Weak", promoted_confidence: 30 } },
  ];
  const rows: EvidenceRow[] = [{ id: "e1", artifact_id: null, kind: "tool_query", value: "Hamza Shakoor" }];
  const [u] = computeReclassification(arts, rows);
  // Names are NOT anchors → the procedural row floors to weak, never inherits verified.
  assertEquals(u.grade, "weak");
});

Deno.test("C-3 (M1): a contradicted selector is not masked by a verified one on the same value", () => {
  const arts = [
    { id: "a1", value: "x@y.com", kind: "email", metadata: { confidence_tier: "Confirmed", promoted_confidence: 92 } },
    { id: "a2", value: "x@y.com", kind: "email", metadata: { status: "needs_review", contradiction: true } },
  ];
  const rows: EvidenceRow[] = [{ id: "e1", artifact_id: null, kind: "tool_query", value: "X@Y.com" }];
  const [u] = computeReclassification(arts, rows);
  // Conservative merge: the contradiction wins over the verified sibling.
  assertEquals(u.grade, "contradicted");
});

// ---- M2: grading is off LIVE state (enables demotion, no first-write freeze) ---
Deno.test("C-3 (M2): a now-contradicted artifact grades its row contradicted (no memory of a prior grade)", () => {
  // computeReclassification is pure/stateless: it always reflects current artifact
  // state, so the end-of-cycle pass can DEMOTE a row an earlier run graded verified.
  const arts = [{ id: "a1", value: "x@y.com", kind: "email", metadata: { status: "needs_review", contradiction: true } }];
  const rows: EvidenceRow[] = [{ id: "e1", artifact_id: "a1", kind: "email", value: "x@y.com" }];
  const [u] = computeReclassification(arts, rows);
  assertEquals(u.grade, "contradicted");
});

// ---- enum hygiene -------------------------------------------------------------
Deno.test("C-3: the grade enum is exactly the six values, and 'soft' is not one", () => {
  assertEquals([...EVIDENCE_GRADES].sort(), ["contradicted", "probable", "rejected", "unclassified", "verified", "weak"]);
  assert(!(EVIDENCE_GRADES as readonly string[]).includes("soft"), "'soft' is retired from the grade enum");
  assert(isEvidenceGrade("verified") && !isEvidenceGrade("soft"));
});

Deno.test("C-3: gradeTag renders the report label", () => {
  assertEquals(gradeTag("verified"), "[verified]");
  assertEquals(gradeTag("contradicted"), "[contradicted]");
});
