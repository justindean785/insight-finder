import {
  applyEvidenceCaps,
  coerceCoherentStatus,
  deriveStatus,
  looksDeadEnd,
} from "./confidence.ts";
import { normalizeArtifactValue } from "./artifact-normalization.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { inferKind, isStrictKind } from "./artifact_types.ts";
import { queryTypesOf } from "./query-type-router.ts";
import {
  isLlmAssertedDomainSource,
  LLM_ASSERTED_PROVENANCE,
} from "./source-classification.ts";
import { validateArtifact } from "./validation.ts";

export interface ArtifactCandidate {
  kind: string;
  value: string;
  source: string;
  sourceUrl?: string | null;
  discoveredVia: string;
  rationale: string;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  autoRecorded: boolean;
}

export interface PersistenceRow {
  kind: string;
  value: string;
  normalized_value: string;
  confidence: number;
  source: string;
  evidence_tool_name: string;
  evidence_source: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactConversionContext {
  recognizedDomains?: string[];
}

export interface CandidateConversionResult {
  row: PersistenceRow | null;
  reason: string | null;
}

const UNSUPPORTED_KINDS = new Set([
  "cluster_decision",
  "triage_summary",
  "tool_failure",
  "risk_assessment",
  "pivot_decision",
  "run_health",
]);

export function toPersistenceRow(
  candidate: ArtifactCandidate,
  context: ArtifactConversionContext = {},
): PersistenceRow | null {
  return convertCandidate(candidate, context).row;
}

export function convertCandidate(
  candidate: ArtifactCandidate,
  context: ArtifactConversionContext = {},
): CandidateConversionResult {
  const requestedKind = candidate.kind.trim().toLowerCase();
  if (UNSUPPORTED_KINDS.has(requestedKind)) {
    return {
      row: null,
      reason: `unsupported artifact kind: ${candidate.kind}`,
    };
  }

  const inferred = inferKind(requestedKind, candidate.value);
  if (!isStrictKind(inferred.kind)) {
    return {
      row: null,
      reason: `unsupported artifact kind: ${candidate.kind}`,
    };
  }

  const validated = validateArtifact(inferred.kind, candidate.value);
  if (!validated.ok) {
    return {
      row: null,
      reason: `invalid artifact value: ${validated.reason}`,
    };
  }
  if (!isStrictKind(validated.kind)) {
    return {
      row: null,
      reason: `unsupported validated artifact kind: ${validated.kind}`,
    };
  }

  const canonical = normalizeArtifactValue(validated.kind, validated.value);
  if (!canonical) {
    return {
      row: null,
      reason: `invalid artifact value for kind: ${validated.kind}`,
    };
  }

  const normalized = {
    displayValue: candidate.value,
    normalizedValue: canonical.normalizedValue,
  };
  const baseMetadata = buildBaseMetadata(candidate, {
    ...(validated.metaPatch ?? {}),
    ...(inferred.reclassified_from
      ? { reclassified_from: inferred.reclassified_from }
      : {}),
  });
  const effectiveSources = collectSources(candidate.source, baseMetadata);
  const llmAssertedProvenance = effectiveSources.some((source) =>
    isLlmAssertedDomainSource(source, context.recognizedDomains ?? [])
  );
  const evidenceSource = llmAssertedProvenance
    ? LLM_ASSERTED_PROVENANCE
    : candidate.source;

  return {
    row: candidate.autoRecorded
      ? buildAutoRecordedCandidateRow(
        candidate,
        validated.kind,
        normalized,
        baseMetadata,
        llmAssertedProvenance,
        evidenceSource,
      )
      : buildManualCandidateRow(
        candidate,
        validated.kind,
        normalized,
        baseMetadata,
        effectiveSources,
        llmAssertedProvenance,
        evidenceSource,
      ),
    reason: null,
  };
}

function buildAutoRecordedCandidateRow(
  candidate: ArtifactCandidate,
  kind: string,
  normalized: { displayValue: string; normalizedValue: string },
  baseMetadata: Record<string, unknown>,
  llmAssertedProvenance: boolean,
  evidenceSource: string,
): PersistenceRow {
  const built = buildAutoRecordedRow({
    kind,
    value: normalized.displayValue,
    source: candidate.source,
    rawConfidence: candidate.confidence ?? 50,
    metadata: {
      ...baseMetadata,
      ...(llmAssertedProvenance
        ? {
          provenance: LLM_ASSERTED_PROVENANCE,
          provenance_verified: false,
        }
        : {}),
    },
  });

  return {
    ...built,
    normalized_value: normalized.normalizedValue,
    evidence_tool_name: evidenceSource,
    evidence_source: evidenceSource,
  };
}

function buildManualCandidateRow(
  candidate: ArtifactCandidate,
  kind: string,
  normalized: { displayValue: string; normalizedValue: string },
  baseMetadata: Record<string, unknown>,
  effectiveSources: string[],
  llmAssertedProvenance: boolean,
  evidenceSource: string,
): PersistenceRow {
  const cap = applyEvidenceCaps({
    rawConfidence: candidate.confidence ?? 50,
    sources: effectiveSources,
    kind,
    metadata: baseMetadata,
  });
  const resolvedReasonNotConfirmed =
    (typeof baseMetadata.reason_not_confirmed === "string"
      ? baseMetadata.reason_not_confirmed
      : null) ?? cap.reason_not_confirmed ?? null;

  return {
    kind,
    value: normalized.displayValue,
    normalized_value: normalized.normalizedValue,
    confidence: cap.confidence,
    source: candidate.source,
    evidence_tool_name: evidenceSource,
    evidence_source: evidenceSource,
    metadata: {
      ...baseMetadata,
      source_category: cap.source_classes,
      query_types: queryTypesOf({
        value: normalized.normalizedValue,
        kind,
        metadata: baseMetadata,
      }),
      status: coerceCoherentStatus(
        deriveStatus({
          requested: typeof baseMetadata.status === "string" ? baseMetadata.status : null,
          reasonNotConfirmed: resolvedReasonNotConfirmed,
          sourceClasses: cap.source_classes,
          contradictions: Array.isArray(baseMetadata.contradictions)
            ? baseMetadata.contradictions
            : [],
          deadEnd: looksDeadEnd(baseMetadata),
        }),
        resolvedReasonNotConfirmed,
      ),
      cluster_id: baseMetadata.cluster_id ?? null,
      reason_for_confidence: cap.reason_for_confidence,
      reason_not_confirmed: resolvedReasonNotConfirmed,
      contradictions: baseMetadata.contradictions ?? [],
      next_verification_step: baseMetadata.next_verification_step ?? null,
      confidence_cap_applied: cap.cap,
      ...(llmAssertedProvenance
        ? {
            provenance: LLM_ASSERTED_PROVENANCE,
            provenance_verified: false,
          }
        : {}),
    },
  };
}

function buildBaseMetadata(
  candidate: ArtifactCandidate,
  validationPatch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(candidate.metadata ?? {}),
    ...validationPatch,
    auto_recorded: candidate.autoRecorded,
    source_url:
      candidate.sourceUrl ??
      (candidate.metadata?.source_url as string | null | undefined) ??
      null,
    discovered_via: candidate.discoveredVia,
    rationale: candidate.rationale,
  };
}

function collectSources(
  source: string,
  metadata: Record<string, unknown>,
): string[] {
  const metadataSources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((value): value is string =>
      typeof value === "string" && value.length > 0
    )
    : [];
  return [
    source,
    ...metadataSources,
  ].filter(Boolean);
}
