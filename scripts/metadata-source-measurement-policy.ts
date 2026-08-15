import {
  canonicalSourceToolIdentity,
  classifySource,
  splitSourceLabels,
} from "../supabase/functions/osint-agent/source-classification.ts";
import type { CapResult } from "../supabase/functions/osint-agent/confidence.ts";

const KNOWN_SYSTEM_WRITERS = new Set([
  "seed",
  "user_query",
  "collision_detector",
  "synthesis",
  "lib/cluster.ts",
  "cluster.ts",
]);

const KNOWN_EXECUTION_NEAR_MISSES = new Set([
  "web_search",
  "oathnet",
  "rapidapi",
  "third_party_osint",
  "card results",
]);

export type UnmatchedOrigin =
  | "known system writer"
  | "analyst or manual origin"
  | "execution near-miss or unmatched provider"
  | "unknown";

export interface DuplicateBreachTransportResult {
  singleLogicalBreachShape: boolean;
  historicalNudgeAffected: boolean;
  proposedFixedAtSingleSourceCap: boolean;
  invariantViolation: boolean;
}

export interface DuplicateBreachTransportInput {
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  legacy: CapResult;
  proposed: CapResult;
}

/** Auto-recorded rows use a distinct status writer, not ordinary recording. */
export function isAutoRecordedStatusRow(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.auto_recorded === true;
}

function metadataSourceStrings(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const labels: string[] = [];
  if (typeof metadata?.source === "string") labels.push(metadata.source);
  if (Array.isArray(metadata?.sources)) {
    for (const candidate of metadata.sources) {
      if (typeof candidate === "string") labels.push(candidate);
    }
  }
  return labels;
}

function canonicalTransportTokens(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const metadataSources = Array.isArray(metadata?.sources)
    ? metadata.sources.filter((candidate): candidate is string =>
      typeof candidate === "string"
    )
    : [];
  // Reproduce the historical transport topology: metadata.sources entered the
  // caller's source array, then the cap engine read metadata source fields again.
  const transported = [
    ...(typeof source === "string" ? [source] : []),
    ...metadataSources,
    ...metadataSourceStrings(metadata),
  ];
  return transported.flatMap((label) => {
    const parts = splitSourceLabels(label);
    return (parts.length ? parts : [label]).map(canonicalSourceToolIdentity);
  }).filter(Boolean);
}

/** Aggregate-only diagnostic; cap results are supplied to avoid recomputation. */
export function evaluateDuplicateBreachTransport(
  input: DuplicateBreachTransportInput,
): DuplicateBreachTransportResult {
  const tokens = canonicalTransportTokens(input.source, input.metadata);
  const unique = new Set(tokens);
  const hasTransportOverlap = unique.size < tokens.length;
  const breachOnly = (result: CapResult) =>
    result.source_classes.length === 1 && result.source_classes[0] === "breach";
  const singleLogicalBreachShape = hasTransportOverlap && unique.size === 1 &&
    breachOnly(input.legacy) && breachOnly(input.proposed);
  const historicalNudgeAffected = singleLogicalBreachShape &&
    input.legacy.cap === 65 && input.proposed.cap === 60;
  const proposedFixedAtSingleSourceCap = singleLogicalBreachShape &&
    input.proposed.cap === 60;

  return {
    singleLogicalBreachShape,
    historicalNudgeAffected,
    proposedFixedAtSingleSourceCap,
    invariantViolation: singleLogicalBreachShape &&
      !proposedFixedAtSingleSourceCap,
  };
}

export function normalizedToolToken(label: string): string {
  return label.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Keep known slash-bearing system writers atomic before production splitting. */
export function surfaceTokensForExecutionMatch(
  source: string | null | undefined,
): string[] {
  if (typeof source !== "string" || !source.trim()) return [];
  const atomic = normalizedToolToken(source);
  if (KNOWN_SYSTEM_WRITERS.has(atomic)) {
    return [atomic];
  }
  return splitSourceLabels(source).map(normalizedToolToken).filter(Boolean);
}

export function unmatchedOrigin(token: string): UnmatchedOrigin {
  if (KNOWN_SYSTEM_WRITERS.has(token)) {
    return "known system writer";
  }
  if (/\b(?:analyst|manual|operator|user input)\b/.test(token)) {
    return "analyst or manual origin";
  }
  if (
    classifySource(token) !== "unknown" ||
    /(?:_lookup|_search|_scrape|_scan|_correlate)$/.test(token) ||
    KNOWN_EXECUTION_NEAR_MISSES.has(token)
  ) {
    return "execution near-miss or unmatched provider";
  }
  return "unknown";
}
