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
  /**
   * A genuinely MULTI-source surface, kept as distinct labels.
   *
   * `record_finding` accepts `supporting_sources: string[]`, and callers used to
   * flatten it with `.join(",")` to fit the singular `source` field. That
   * silently destroyed evidence: `singularSurfaceSources` wraps the joined
   * string as ONE label and `classifySource` then classifies the whole thing as
   * a single token, so "breach_check,gemini_deep_dork,court_record_search"
   * resolved wholly to `breach` (BREACH_SLUG_RE's boundary class includes ","),
   * turning 3 classes into 1 and a cap of 95 into 60. The collapse is not
   * breach-specific — "court_record_search,gemini_deep_dork" collapsed to
   * [court_record], dropping ai_summary.
   *
   * Prefer this over `source` whenever the tool surface is already a list. It
   * keeps the cap engine as the single implementation of evidence policy rather
   * than pushing callers to reach past this module for the array form, which
   * `recording_source_policy_runtime_test.ts` forbids for good reason.
   *
   * Singular-surface callers (record_artifacts and the tools/recording.ts
   * mirror) must keep using `source`: for them one label really is one
   * provenance, and that is pinned by the mirror test.
   */
  sources?: readonly string[] | null;
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
  surface: readonly string[],
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;

  const copy = { ...metadata };
  const seen = new Set<string>();
  // Seed with every surface label so the channel boundary stays de-duplicated
  // for multi-source surfaces too, not just the singular one.
  for (const label of surface) {
    if (typeof label === "string" && label.trim()) {
      seen.add(label.trim().toLowerCase());
    }
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

/**
 * The authority-bearing surface labels. An explicit `sources` list is kept as
 * DISTINCT labels; otherwise the singular `source` is wrapped as exactly one.
 * Never join a list into one string here — that is the collapse documented on
 * `RecordingSourcePolicyInput.sources`.
 */
function surfaceSources(input: RecordingSourcePolicyInput): string[] {
  if (Array.isArray(input.sources)) {
    return input.sources.filter(
      (label): label is string => typeof label === "string" && !!label.trim(),
    );
  }
  return singularSurfaceSources(input.source);
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
  const sources = surfaceSources(input);

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
    metadata: metadataWithDistinctSourceLabels(sources, input.metadata),
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
