// Morris-case fixture tests — Phase 2 scoring engine regression suite.
//
// Synthetic Jarrett Morris person-investigation artifacts (no real PII). Exercises
// source-class caps, dork relevance, geography mismatch, contradiction penalty,
// and analyst review delta through scoreArtifact().
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreArtifact, GEOGRAPHY_MISMATCH_PENALTY } from "./scoring.ts";
import { applyEvidenceCaps } from "./confidence.ts";

// ── Morris-case fixture artifacts (synthetic) ───────────────────────────────

/** Breach-only email → verification lead, not confirmed identity. */
const MORRIS_BREACH_EMAIL = {
  rawConfidence: 78,
  sources: ["breach_check"],
  kind: "email",
};

/** Name surfaced only from a news hit — lead, not confirmation (#17). */
const MORRIS_NEWS_NAME = {
  rawConfidence: 88,
  sources: ["reuters"],
  kind: "name",
};

/** Placer County assessor parcel tied to the subject address. */
const MORRIS_ASSESSOR_ADDRESS = {
  rawConfidence: 92,
  sources: ["county assessor parcel record"],
  kind: "address",
};

/** Same-name hit in a different state — geography mismatch. */
const MORRIS_WRONG_STATE_NAME = {
  rawConfidence: 70,
  sources: ["reuters"],
  kind: "name",
  geographyMatch: false as const,
};

/** Dork-harvest template PDF — seed-only, low relevance. */
const MORRIS_DORK_TEMPLATE = {
  rawConfidence: 65,
  sources: ["dork_harvest"],
  kind: "document",
  relevance: 0.2,
};

/** Assessor + breach corroboration on the same address cluster. */
const MORRIS_ASSESSOR_PLUS_BREACH = {
  rawConfidence: 95,
  sources: ["county assessor parcel record", "breach_check+oathnet_lookup"],
  kind: "address",
};

Deno.test("Morris: breach-only email capped at breach ceiling (60)", () => {
  const r = scoreArtifact(MORRIS_BREACH_EMAIL);
  assertEquals(r.confidence_final, 60);
  assertEquals(r.confidence_ceiling, 60);
  assert(r.source_classes.includes("breach"));
  assertEquals(r.confidence_breakdown.after_cap, 60);
  assertEquals(r.reason_not_confirmed, "needs second independent class of evidence");
});

Deno.test("Morris: news-sourced name treated as lead (cap 55)", () => {
  const r = scoreArtifact(MORRIS_NEWS_NAME);
  assertEquals(r.confidence_final, 55);
  assertEquals(r.confidence_ceiling, 55);
  assert(r.reason_for_confidence.includes("name-from-news"));
});

Deno.test("Morris: county assessor address reaches government_property_record cap", () => {
  const r = scoreArtifact(MORRIS_ASSESSOR_ADDRESS);
  assertEquals(r.source_classes, ["government_property_record"]);
  assertEquals(r.confidence_ceiling, 90);
  assertEquals(r.confidence_final, 90);
});

Deno.test("Morris: geography mismatch penalizes a news name lead", () => {
  const clean = scoreArtifact({ ...MORRIS_WRONG_STATE_NAME, geographyMatch: true });
  const penalized = scoreArtifact(MORRIS_WRONG_STATE_NAME);
  assertEquals(clean.confidence_final, 55);
  assertEquals(penalized.confidence_final, 55 - GEOGRAPHY_MISMATCH_PENALTY);
  assertEquals(penalized.confidence_breakdown.geography_penalty, GEOGRAPHY_MISMATCH_PENALTY);
});

Deno.test("Morris: low-relevance dork template scales against ceiling", () => {
  const r = scoreArtifact(MORRIS_DORK_TEMPLATE);
  assertEquals(r.confidence_ceiling, 55); // ai_summary class
  assertEquals(r.confidence_final, Math.round(55 * 0.2));
  assertEquals(r.confidence_breakdown.after_relevance, 11);
});

Deno.test("Morris: assessor + breach cross-class corroboration lifts cap", () => {
  const r = scoreArtifact(MORRIS_ASSESSOR_PLUS_BREACH);
  assert(r.source_classes.includes("government_property_record"));
  assert(r.source_classes.includes("breach"));
  assertEquals(r.confidence_ceiling, 95);
  assertEquals(r.confidence_final, 95);
});

Deno.test("Morris: contradiction penalty subtracted after cap", () => {
  const base = scoreArtifact(MORRIS_ASSESSOR_ADDRESS);
  const r = scoreArtifact({ ...MORRIS_ASSESSOR_ADDRESS, contradictionPenalty: 20 });
  assertEquals(r.confidence_final, base.confidence_final - 20);
  assertEquals(r.confidence_breakdown.contradiction_penalty, 20);
});

Deno.test("Morris: analyst key review delta applied last", () => {
  const r = scoreArtifact({ ...MORRIS_BREACH_EMAIL, reviewDelta: 25 });
  assertEquals(r.confidence_final, 85); // 60 + 25
  assertEquals(r.confidence_breakdown.review_delta, 25);
});

Deno.test("Morris: scoreArtifact without optional fields matches applyEvidenceCaps", () => {
  const input = { rawConfidence: 90, sources: ["whois_lookup", "dns_records"], kind: "domain" };
  const capped = applyEvidenceCaps(input);
  const scored = scoreArtifact(input);
  assertEquals(scored.confidence_final, capped.confidence);
  assertEquals(scored.confidence_ceiling, capped.cap);
  assertEquals(scored.source_classes, capped.source_classes);
  assertEquals(scored.reason_for_confidence, capped.reason_for_confidence);
  assertEquals(scored.reason_not_confirmed, capped.reason_not_confirmed);
});
