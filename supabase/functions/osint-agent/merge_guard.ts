/**
 * merge_guard.ts — pure identity-merge safety policy.
 *
 * Dark-launched helper for the graph engine: it answers whether two candidate
 * person clusters have enough independent evidence to be treated as the same
 * person. The high-harm case this protects against is a same-name/shared-DOB
 * collapse into a sensitive registry or criminal-record cluster.
 */

export type MergeSignalKind =
  | "name"
  | "dob"
  | "email"
  | "phone"
  | "address"
  | "username"
  | "social_profile"
  | "official_record"
  | "government_record"
  | "corporate_record"
  | "breach_record"
  | "aggregator_record"
  | "other";

export interface MergeSignal {
  kind: MergeSignalKind;
  value: string;
  source: string;
  confidence?: number | null;
}

export interface MergeGuardInput {
  leftLabel?: string | null;
  rightLabel?: string | null;
  signals: MergeSignal[];
  requestedLabel?: "CONFIRMED" | "CORROBORATED" | "INFERRED" | "VERIFY" | "LOW" | "CONFLICT";
}

export interface MergeGuardDecision {
  allowConfirmedMerge: boolean;
  recommendedLabel: "CONFIRMED" | "CORROBORATED" | "INFERRED" | "VERIFY" | "LOW" | "CONFLICT";
  independentStrongSignals: number;
  weakSignals: string[];
  correlatedSourceGroups: string[];
  reasons: string[];
}

const WEAK_SIGNAL_KINDS = new Set<MergeSignalKind>(["name", "dob", "address", "aggregator_record", "breach_record"]);
const STRONG_SIGNAL_KINDS = new Set<MergeSignalKind>([
  "email",
  "phone",
  "username",
  "social_profile",
  "official_record",
  "government_record",
  "corporate_record",
]);

const AGGREGATOR_PATTERNS: Array<[RegExp, string]> = [
  [/\binstant\s*checkmate\b/i, "people-search-aggregator"],
  [/\btruth\s*finder\b|\btruthfinder\b/i, "people-search-aggregator"],
  [/\bbeen\s*verified\b|\bbeenverified\b/i, "people-search-aggregator"],
  [/\bspokeo\b/i, "people-search-aggregator"],
  [/\bpeople\s*finder\b|\bpeoplefinder\b/i, "people-search-aggregator"],
  [/\bwhitepages\b/i, "people-search-aggregator"],
  [/\bcombolist\b|\bcombo\s*list\b|\bleak\s*combo\b/i, "breach-combolist"],
];

function normalizeValue(kind: MergeSignalKind, value: string): string {
  const v = value.trim().toLowerCase();
  if (kind === "email") return v;
  if (kind === "phone") return value.replace(/[^\d+]/g, "");
  if (kind === "dob") return v.replace(/\b0(\d)\b/g, "$1");
  return v.replace(/\s+/g, " ");
}

export function sourceGroup(source: string, kind: MergeSignalKind): string {
  for (const [re, group] of AGGREGATOR_PATTERNS) if (re.test(source)) return group;
  if (kind === "aggregator_record") return "people-search-aggregator";
  if (kind === "breach_record") return "breach";
  if (kind === "government_record") return "government";
  if (kind === "official_record") return "official";
  if (kind === "corporate_record") return "corporate";
  if (kind === "social_profile") return "social";
  return source.trim().toLowerCase() || "unknown";
}

function labelsLookLikeSameCommonName(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;
  const a = left.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const b = right.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (!a || !b || a !== b) return false;
  const parts = a.split(/\s+/).filter(Boolean);
  return parts.length <= 2;
}

/** Evaluate whether an identity merge has enough independent evidence to be
 * elevated to CONFIRMED. Aggregator and combolist sources are correlated and
 * count as one weak source group, not N independent confirmations. */
export function evaluateMergeGuard(input: MergeGuardInput): MergeGuardDecision {
  const weakSignals = new Set<string>();
  const correlatedSourceGroups = new Set<string>();
  const strongKeys = new Set<string>();
  const reasons: string[] = [];

  for (const signal of input.signals) {
    const kind = signal.kind;
    const group = sourceGroup(signal.source, kind);
    const value = normalizeValue(kind, signal.value);
    if (!value) continue;

    if (group === "people-search-aggregator" || group === "breach-combolist") {
      correlatedSourceGroups.add(group);
    }

    if (WEAK_SIGNAL_KINDS.has(kind)) {
      weakSignals.add(kind === "aggregator_record" ? group : kind);
      continue;
    }

    if (STRONG_SIGNAL_KINDS.has(kind)) {
      strongKeys.add(`${kind}:${value}:${group}`);
    }
  }

  const hasWeakNameCollision = weakSignals.has("name") || labelsLookLikeSameCommonName(input.leftLabel, input.rightLabel);
  const hasDob = weakSignals.has("dob");
  const independentStrongSignals = strongKeys.size;

  if (hasWeakNameCollision && hasDob && independentStrongSignals === 0) {
    reasons.push("shared DOB plus common/same name is not enough for a confirmed person merge");
  }
  if (correlatedSourceGroups.size > 0) {
    reasons.push("people-search aggregators and combolists are correlated and count as one weak source group");
  }
  if (independentStrongSignals === 0) {
    reasons.push("no independent strong identifier links the candidate clusters");
  }

  const allowConfirmedMerge = independentStrongSignals >= 1 && !(hasWeakNameCollision && hasDob && independentStrongSignals === 0);
  const requested = input.requestedLabel ?? "CONFIRMED";
  const recommendedLabel: MergeGuardDecision["recommendedLabel"] =
    allowConfirmedMerge
      ? requested === "CONFIRMED" ? "CONFIRMED" : requested
      : hasWeakNameCollision || hasDob
        ? "VERIFY"
        : "LOW";

  return {
    allowConfirmedMerge,
    recommendedLabel,
    independentStrongSignals,
    weakSignals: [...weakSignals].sort(),
    correlatedSourceGroups: [...correlatedSourceGroups].sort(),
    reasons,
  };
}

