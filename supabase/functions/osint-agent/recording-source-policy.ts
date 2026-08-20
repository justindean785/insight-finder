import {
  applyEvidenceCapsWithDistinctBreachIdentities,
  type ArtifactStatus,
  type CapResult,
  coerceCoherentStatus,
  deriveStatus,
  looksDeadEnd,
} from "./confidence.ts";

export interface RecordingSourcePolicyInput {
  /** The singular, top-level provenance accepted by the recording tool. */
  source?: string | null;
  /** Model-authored provenance may disclose or constrain, never create authority. */
  metadata?: Record<string, unknown> | null;
  rawConfidence: number;
  kind?: string;
}

export interface RecordingSourcePolicyResult {
  /** The complete result from the more conservative run. */
  effective: CapResult;
  /** Authority-bearing run: top-level source only, no model metadata. */
  surfaceOnly: CapResult;
  /** Constraining run: the same top-level source plus model metadata. */
  withMetadata: CapResult;
}

export interface RecordingStatusResult {
  status: ArtifactStatus;
  reasonNotConfirmed: string | null;
}

/** First trimmed, non-empty reason; empty model strings never erase a cap gap. */
export function firstNonemptyReason(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function metadataWithDistinctSourceLabels(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;

  const copy = { ...metadata };
  const seen = new Set<string>();
  if (typeof source === "string" && source.trim()) {
    seen.add(source.trim().toLowerCase());
  }

  if (typeof copy.source === "string" && copy.source.trim()) {
    const key = copy.source.trim().toLowerCase();
    if (seen.has(key)) delete copy.source;
    else seen.add(key);
  }

  if (Array.isArray(copy.sources)) {
    const distinct: string[] = [];
    for (const candidate of copy.sources) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const key = candidate.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(candidate);
    }
    copy.sources = distinct;
  }

  return copy;
}

function singularSurfaceSources(source: string | null | undefined): string[] {
  return typeof source === "string" && source.trim() ? [source] : [];
}

/** Exact ordinary recording status path, excluding collision/bio overrides. */
export function resolveRecordingStatus(
  cap: CapResult,
  metadata: Record<string, unknown> | null | undefined,
): RecordingStatusResult {
  const reasonNotConfirmed = firstNonemptyReason(
    typeof metadata?.reason_not_confirmed === "string"
      ? metadata.reason_not_confirmed
      : null,
    cap.reason_not_confirmed,
  );
  const status = coerceCoherentStatus(
    deriveStatus({
      requested: typeof metadata?.status === "string" ? metadata.status : null,
      reasonNotConfirmed,
      sourceClasses: cap.source_classes,
      contradictions: Array.isArray(metadata?.contradictions)
        ? metadata.contradictions
        : [],
      deadEnd: looksDeadEnd(metadata),
    }),
    reasonNotConfirmed,
  );
  return { status, reasonNotConfirmed };
}

/**
 * Keep recording provenance in two channels all the way into the cap engine.
 *
 * The shared cap pipeline remains the single implementation of evidence policy.
 * We run its recording mode once without model metadata and once with it, then
 * select the entire lower-cap result. Comparing caps (not the already-clamped
 * confidence) makes the authority boundary independent of the model's requested
 * score. Surface-only wins ties so metadata cannot change source category,
 * status inputs, graph weight, or breach corroboration without constraining the
 * numeric cap too.
 */
export function applyRecordingSourcePolicy(
  input: RecordingSourcePolicyInput,
): RecordingSourcePolicyResult {
  const sources = singularSurfaceSources(input.source);

  const surfaceOnly = applyEvidenceCapsWithDistinctBreachIdentities({
    rawConfidence: input.rawConfidence,
    sources,
    kind: input.kind,
    metadata: null,
  });
  const withMetadata = applyEvidenceCapsWithDistinctBreachIdentities({
    rawConfidence: input.rawConfidence,
    sources,
    kind: input.kind,
    // A logical label disclosed through more than one field is still one
    // provenance. Keep the channel boundary de-duplicated as defense in depth;
    // the cap engine independently counts distinct normalized breach tools.
    metadata: metadataWithDistinctSourceLabels(input.source, input.metadata),
  });

  return {
    effective: withMetadata.cap < surfaceOnly.cap ? withMetadata : surfaceOnly,
    surfaceOnly,
    withMetadata,
  };
}

/** All model-disclosed labels, for conservative detection and disclosure only. */
export function disclosedSourceLabels(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const labels: string[] = [];
  if (typeof source === "string" && source.trim()) labels.push(source);
  if (typeof metadata?.source === "string" && metadata.source.trim()) {
    labels.push(metadata.source);
  }
  if (Array.isArray(metadata?.sources)) {
    for (const candidate of metadata.sources) {
      if (typeof candidate === "string" && candidate.trim()) {
        labels.push(candidate);
      }
    }
  }
  return labels;
}
