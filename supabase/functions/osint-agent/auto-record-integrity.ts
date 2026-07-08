// auto-record-integrity.ts — apply evidence caps + status metadata to tool
// auto-insert paths (dork_harvest, gemini_deep_dork). These tools bypass the
// record_artifacts LLM shim but must still honor the same confidence ceiling and
// surface reason_not_confirmed so the UI never shows an un-capped ai_summary hit
// as confirmed evidence.

import { applyEvidenceCaps, deriveStatus, coerceCoherentStatus } from "./confidence.ts";
import { queryTypesOf } from "./query-type-router.ts";

export interface AutoRecordInput {
  kind: string;
  value: string;
  source: string;
  rawConfidence: number;
  metadata?: Record<string, unknown>;
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
  const cap = applyEvidenceCaps({
    rawConfidence: input.rawConfidence,
    sources: [input.source],
    kind: input.kind,
    metadata: input.metadata ?? null,
  });
  const reasonNotConfirmed =
    (typeof input.metadata?.reason_not_confirmed === "string" ? input.metadata.reason_not_confirmed : null) ??
    cap.reason_not_confirmed ??
    DEFAULT_REASON;
  const status = coerceCoherentStatus(
    deriveStatus({
      requested: null,
      reasonNotConfirmed,
      sourceClasses: cap.source_classes,
      contradictions: [],
      deadEnd: false,
    }),
    reasonNotConfirmed,
  );
  return {
    kind: input.kind,
    value,
    confidence: cap.confidence,
    source: input.source,
    metadata: {
      ...(input.metadata ?? {}),
      auto_recorded: true,
      source_category: cap.source_classes,
      status,
      reason_for_confidence: cap.reason_for_confidence,
      reason_not_confirmed: reasonNotConfirmed,
      confidence_cap_applied: cap.cap,
      query_types: queryTypesOf({ value, kind: input.kind, metadata: input.metadata ?? null }),
    },
  };
}
