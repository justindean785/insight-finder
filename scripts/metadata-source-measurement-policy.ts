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

/**
 * Same-call write-ordering allowance for execution matching.
 *
 * `tool_usage_log.created_at` defaults to now() at INSERT time, and the tool
 * wrapper's `logUsage` runs in an UNAWAITED `finally` after `execute` returns
 * (`cache.ts` — the main miss path and the error path). The auto-insert tools
 * (`dork_harvest`, `gemini_deep_dork`) write their artifact rows INSIDE
 * `execute`, so for those the evidencing execution is logged slightly AFTER the
 * artifact it produced. A strict `execution <= artifact` bound would therefore
 * report every auto-recorded artifact as unmatched — replacing an overstatement
 * with a systematic undercount. This window covers that intra-call ordering
 * while staying orders of magnitude below the thread-reuse gaps (hours to days)
 * that the bound exists to reject.
 */
export const EXECUTION_MATCH_TOLERANCE_MS = 120_000;

export interface ExecutionRow {
  tool_name: string;
  created_at: string;
}

/**
 * Every observed execution instant (epoch ms, ascending) per lowercased tool
 * name. A tool is deliberately NOT reduced to a single timestamp: collapsing a
 * reused thread's runs to one instant makes an unrelated run stand in for the
 * artifact's actual provenance in one direction or the other.
 */
export function executionTimesByTool(
  rows: Iterable<ExecutionRow>,
): Map<string, number[]> {
  const times = new Map<string, number[]>();
  for (const row of rows) {
    const instant = Date.parse(row.created_at);
    if (!Number.isFinite(instant)) continue;
    const token = row.tool_name.toLowerCase();
    const known = times.get(token);
    if (known) known.push(instant);
    else times.set(token, [instant]);
  }
  for (const instants of times.values()) instants.sort((a, b) => a - b);
  return times;
}

/**
 * The execution NEAREST the artifact that could plausibly have produced it —
 * the latest run at or under the write-order bound — or null when the tool had
 * not run by then. Fails closed on absent threads, tools, and timestamps.
 *
 * LIMITATION: this is an upper bound only. With no durable run_id / call
 * identity on either table there is no defensible lower bound, so a tool that
 * ran once long before the artifact still qualifies. See the disclosure the
 * measurement prints alongside its execution figures.
 */
export function nearestQualifyingExecution(
  timesByTool: Map<string, number[]> | undefined,
  token: string,
  artifactCreatedAtMs: number,
  toleranceMs: number = EXECUTION_MATCH_TOLERANCE_MS,
): number | null {
  if (!timesByTool) return null;
  if (!Number.isFinite(artifactCreatedAtMs)) return null;
  const instants = timesByTool.get(token);
  if (!instants?.length) return null;
  const bound = artifactCreatedAtMs + toleranceMs;
  let nearest: number | null = null;
  for (const instant of instants) {
    if (instant > bound) break; // ascending — nothing later can qualify
    nearest = instant;
  }
  return nearest;
}

/** A tool only evidences an artifact if it had already run by that time. */
export function isExecutionAvailableAt(
  timesByTool: Map<string, number[]> | undefined,
  token: string,
  artifactCreatedAtMs: number,
  toleranceMs: number = EXECUTION_MATCH_TOLERANCE_MS,
): boolean {
  return nearestQualifyingExecution(
    timesByTool,
    token,
    artifactCreatedAtMs,
    toleranceMs,
  ) !== null;
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
