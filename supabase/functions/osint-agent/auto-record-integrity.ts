// auto-record-integrity.ts — apply evidence caps + status metadata to tool
// auto-insert paths (dork_harvest, gemini_deep_dork). These tools bypass the
// record_artifacts LLM shim but must still honor the same confidence ceiling and
// surface reason_not_confirmed so the UI never shows an un-capped ai_summary hit
// as confirmed evidence.

import { deriveStatus, coerceCoherentStatus } from "./confidence.ts";
import { scoreArtifact } from "./scoring.ts";
import type { DorkRelevance } from "./dork-relevance.ts";
import { queryTypesOf } from "./query-type-router.ts";

export interface AutoRecordInput {
  kind: string;
  value: string;
  source: string;
  rawConfidence: number;
  metadata?: Record<string, unknown>;
  /** When set, confidence is scaled by relevance (ceiling × relevance). */
  dorkRelevance?: DorkRelevance;
}

const DEFAULT_REASON =
  "Automatically surfaced URL — document content not verified against the subject";

/** Build a single artifact row with server-side caps + status metadata applied. */
export function buildAutoRecordedRow(input: AutoRecordInput): {
  kind: string;
  value: string;
  confidence: number;
  source: string;
  metadata: Record<string, unknown>;
} {
  const value = (input.value ?? "").trim();
  const relevance = input.dorkRelevance;
  const scored = scoreArtifact({
    rawConfidence: input.rawConfidence,
    sources: [input.source],
    kind: input.kind,
    ...(relevance ? { relevance: relevance.relevance } : {}),
  });
  const reasonNotConfirmed =
    (typeof input.metadata?.reason_not_confirmed === "string" ? input.metadata.reason_not_confirmed : null) ??
    scored.reason_not_confirmed ??
    DEFAULT_REASON;
  const status = coerceCoherentStatus(
    deriveStatus({
      requested: null,
      reasonNotConfirmed,
      sourceClasses: scored.source_classes,
      contradictions: [],
      deadEnd: false,
    }),
    reasonNotConfirmed,
  );
  return {
    kind: input.kind,
    value,
    confidence: scored.confidence_final,
    source: input.source,
    metadata: {
      ...(input.metadata ?? {}),
      auto_recorded: true,
      source_category: scored.source_classes,
      status,
      reason_for_confidence: relevance
        ? `${scored.reason_for_confidence}; dork relevance ${Math.round(relevance.relevance * 100)}% (${relevance.reason})`
        : scored.reason_for_confidence,
      reason_not_confirmed: reasonNotConfirmed,
      confidence_cap_applied: scored.confidence_ceiling,
      confidence_ceiling: scored.confidence_ceiling,
      confidence_breakdown: scored.confidence_breakdown,
      ...(relevance
        ? {
            dork_relevance: relevance.relevance,
            dork_relevance_reason: relevance.reason,
            dork_contains_seed: relevance.containsSeed,
            dork_contains_name: relevance.containsName,
            dork_contains_city: relevance.containsCity,
          }
        : {}),
      query_types: queryTypesOf({ value, kind: input.kind, metadata: input.metadata ?? null }),
    },
  };
}
