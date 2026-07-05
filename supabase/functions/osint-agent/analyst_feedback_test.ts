import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANALYST_REVIEW_DELTA,
  buildFeedbackContext,
  getReviewDeltaForArtifact,
  type AnalystReview,
} from "./analyst-feedback.ts";

const reviews: AnalystReview[] = [
  {
    artifact_id: "a1",
    state: "key",
    note: null,
    artifact: { id: "a1", kind: "email", value: "alice@example.com", source: "breach_check", confidence: 60 },
  },
  {
    artifact_id: "a2",
    state: "dismissed",
    note: "wrong person",
    artifact: { id: "a2", kind: "name", value: "Bob Smith", source: "socialfetch_lookup", confidence: 40 },
  },
  {
    artifact_id: "a3",
    state: "recheck",
    note: null,
    artifact: { id: "a3", kind: "phone", value: "+15551234567", source: "leakcheck_lookup", confidence: 55 },
  },
  {
    artifact_id: "a4",
    state: "confirmed",
    note: null,
    artifact: { id: "a4", kind: "domain", value: "example.com", source: "whois_lookup", confidence: 88 },
  },
];

Deno.test("getReviewDeltaForArtifact returns configured delta per state", () => {
  assertEquals(getReviewDeltaForArtifact("a1", reviews), ANALYST_REVIEW_DELTA.key);
  assertEquals(getReviewDeltaForArtifact("a2", reviews), ANALYST_REVIEW_DELTA.dismissed);
  assertEquals(getReviewDeltaForArtifact("a3", reviews), ANALYST_REVIEW_DELTA.recheck);
  assertEquals(getReviewDeltaForArtifact("a4", reviews), ANALYST_REVIEW_DELTA.confirmed);
  assertEquals(getReviewDeltaForArtifact("missing", reviews), 0);
});

Deno.test("getReviewDeltaForArtifact key delta matches scoring_test (+25)", () => {
  assertEquals(ANALYST_REVIEW_DELTA.key, 25);
  assertEquals(getReviewDeltaForArtifact("a1", reviews), 25);
});

Deno.test("buildFeedbackContext empty when no reviews", () => {
  assertEquals(buildFeedbackContext([]), "");
});

Deno.test("buildFeedbackContext surfaces states, notes, and source hints", () => {
  const ctx = buildFeedbackContext(reviews);
  assertStringIncludes(ctx, "ANALYST FEEDBACK");
  assertStringIncludes(ctx, "Key findings");
  assertStringIncludes(ctx, "alice@example.com");
  assertStringIncludes(ctx, "Dismissed");
  assertStringIncludes(ctx, "wrong person");
  assertStringIncludes(ctx, "Needs recheck");
  assertStringIncludes(ctx, "breach_check");
  assertStringIncludes(ctx, "socialfetch_lookup");
});
