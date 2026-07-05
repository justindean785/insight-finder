// scoring.ts — Phase 2 weighted scoring engine.
//
// Delegates source-class caps to applyEvidenceCaps (confidence.ts), then applies
// optional relevance, geography, contradiction, and analyst-review adjustments.
// applyEvidenceCaps is unchanged so existing cap regression tests stay valid.
// Analyst review deltas: pass reviewDelta from getReviewDeltaForArtifact()
// (analyst-feedback.ts) when re-scoring a reviewed artifact.

import { applyEvidenceCaps, type CapResult } from "./confidence.ts";
export { ANALYST_REVIEW_DELTA, getReviewDeltaForArtifact } from "./analyst-feedback.ts";
import type { SourceClass } from "./source-classification.ts";

export interface ScoringInput {
  rawConfidence: number;
  sources: string[];
  kind?: string;
  /** 0..1 multiplier applied after the source-class cap (e.g. dork relevance). */
  relevance?: number;
  /** false → geography mismatch penalty; true/undefined → no penalty. */
  geographyMatch?: boolean;
  /** Points subtracted after cap/relevance (e.g. graph contradiction). */
  contradictionPenalty?: number;
  /** Analyst review delta (+/-), applied last and clamped to 0..100. */
  reviewDelta?: number;
}

export interface ConfidenceBreakdown {
  raw: number;
  after_cap: number;
  ceiling: number;
  after_relevance?: number;
  geography_penalty?: number;
  contradiction_penalty?: number;
  review_delta?: number;
  final: number;
}

export interface ScoringResult {
  confidence_final: number;
  confidence_ceiling: number;
  confidence_breakdown: ConfidenceBreakdown;
  reason_for_confidence: string;
  reason_not_confirmed?: string;
  source_classes: SourceClass[];
}

/** Geography mismatch penalty — aligned with graph_reasoning CONTRADICTION_PENALTY. */
export const GEOGRAPHY_MISMATCH_PENALTY = 15;

/** Apply post-cap multipliers and penalties. Exported for unit tests. */
export function computeScore(
  input: ScoringInput,
  capped: CapResult,
): { final: number; breakdown: ConfidenceBreakdown } {
  const breakdown: ConfidenceBreakdown = {
    raw: input.rawConfidence ?? 50,
    after_cap: capped.confidence,
    ceiling: capped.cap,
    final: capped.confidence,
  };

  let score = capped.confidence;

  if (input.relevance != null && input.relevance !== 1) {
    const rel = Math.max(0, Math.min(1, input.relevance));
    // Match applyDorkRelevance: scale against the class ceiling, not raw model score.
    score = Math.round(capped.cap * rel);
    breakdown.after_relevance = score;
  }

  if (input.geographyMatch === false) {
    score = Math.max(0, score - GEOGRAPHY_MISMATCH_PENALTY);
    breakdown.geography_penalty = GEOGRAPHY_MISMATCH_PENALTY;
  }

  if (input.contradictionPenalty != null && input.contradictionPenalty > 0) {
    score = Math.max(0, score - input.contradictionPenalty);
    breakdown.contradiction_penalty = input.contradictionPenalty;
  }

  if (input.reviewDelta != null && input.reviewDelta !== 0) {
    score = Math.max(0, Math.min(100, score + input.reviewDelta));
    breakdown.review_delta = input.reviewDelta;
  }

  breakdown.final = score;
  return { final: score, breakdown };
}

/** Full artifact score: source-class caps + optional weighted adjustments. */
export function scoreArtifact(input: ScoringInput): ScoringResult {
  const capped = applyEvidenceCaps({
    rawConfidence: input.rawConfidence,
    sources: input.sources,
    kind: input.kind,
  });
  const { final, breakdown } = computeScore(input, capped);
  return {
    confidence_final: final,
    confidence_ceiling: capped.cap,
    confidence_breakdown: breakdown,
    reason_for_confidence: capped.reason_for_confidence,
    reason_not_confirmed: capped.reason_not_confirmed,
    source_classes: capped.source_classes,
  };
}
