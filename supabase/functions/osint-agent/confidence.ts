// Five-axis confidence engine.
// Replaces a single percentage with axis-decomposed scores so the UI / report
// can show *why* a finding is strong or weak.

import { tierOf, TIER_SOURCE_RELIABILITY, TIER_C_ONLY_CONFIDENCE_CAP } from "./tiers.ts";
import type { ContradictionFinding } from "./contradictions.ts";
import { classifySource, classifySourceWithUrl, type SourceClass } from "./artifact_types.ts";

export interface ConfidenceAxes {
  artifact: number;     // is the data point itself accurate?
  relationship: number; // is the link between two artifacts real?
  identity: number;     // do these artifacts belong to the same entity?
  source: number;       // how reliable is the source?
  case: number;         // rollup, capped by weakest required axis
}

export function sourceConfidence(toolNames: string[]): number {
  if (!toolNames.length) return 30;
  const scores = toolNames.map((t) => TIER_SOURCE_RELIABILITY[tierOf(t)]);
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function computeAxes(input: {
  sources: string[];                  // tool names that produced the evidence
  corroborationCount: number;         // distinct independent sources
  contradictions: ContradictionFinding[];
  identityEvidenceStrength: number;   // 0-100, caller-supplied
  relationshipEvidenceStrength: number; // 0-100, caller-supplied
}): ConfidenceAxes {
  const src = sourceConfidence(input.sources);
  const corroBoost = Math.min(20, Math.max(0, input.corroborationCount - 1) * 8);
  const artifact = Math.min(100, src + corroBoost);

  const contraPenalty = input.contradictions.reduce((sum, c) => {
    if (c.severity === "high") return sum + 25;
    if (c.severity === "medium") return sum + 12;
    return sum + 5;
  }, 0);

  const identity = Math.max(0, input.identityEvidenceStrength - contraPenalty);
  const relationship = Math.max(0, input.relationshipEvidenceStrength - Math.floor(contraPenalty / 2));

  // Case = min of artifact / relationship / identity, gently averaged with source
  const floor = Math.min(artifact, relationship, identity);
  let caseScore = Math.round(floor * 0.7 + src * 0.3);

  // Tier-C only? Cap.
  const onlyTierC = input.sources.length > 0 && input.sources.every((t) => tierOf(t) === "C");
  if (onlyTierC) caseScore = Math.min(caseScore, TIER_C_ONLY_CONFIDENCE_CAP);

  return { artifact, relationship, identity, source: src, case: caseScore };
}

// ──────────────────────────────────────────────────────────────────────────
// Status enum + status-clamp helpers (T-C1 / T-C2 / T-C3 / T-C4 / T-H2 / T-H3)
//
// The harm-bearing field is the free-text `status` label. The numeric cap
// engine is correct, but a "confirmed_indicted" string was persisted verbatim
// alongside a 50%-confidence number. These helpers are the single, shared
// authority that maps a (numeric cap, raw status, source classes) triple onto
// a validated status. DO NOT duplicate this clamp logic at the call sites.
// ──────────────────────────────────────────────────────────────────────────

/** Canonical, allowed artifact status vocabulary. Anything else is coerced. */
export const ARTIFACT_STATUSES = [
  "new",
  "verified",
  "probable",
  "needs_review",
  "contradicted",
  "excluded",
  "exhausted",
  "manual_review_required",
] as const;
export type ArtifactStatus = typeof ARTIFACT_STATUSES[number];
const STATUS_SET = new Set<string>(ARTIFACT_STATUSES);

/**
 * Statuses that assert a finding is *settled* — confirmed, corroborated,
 * convicted, indicted, verified, etc. These are the ones that must never
 * outrank the numeric cap or survive single-source / weak-class evidence.
 * Detection is substring-based so out-of-enum model prose ("confirmed_indicted",
 * "corroborated", "conviction") is also caught.
 */
const CONFIRMED_STATUS_RE =
  /confirm|corroborat|indict|convict|verified|guilty|sentenc|charged|prosecut/i;

/** True when a raw model status string asserts a settled/confirmed finding. */
export function isConfirmedStatus(rawStatus: string | null | undefined): boolean {
  return CONFIRMED_STATUS_RE.test(String(rawStatus ?? ""));
}

/** True when a verification_status string self-flags as UNVERIFIED. */
export function isUnverified(verificationStatus: string | null | undefined): boolean {
  return /unverified|unconfirmed|alleged|unsubstantiated/i.test(String(verificationStatus ?? ""));
}

/**
 * Crime-attribution kinds get an elevated evidentiary bar. A CSAM / criminal
 * claim against a named living person can never reach a confirmed status or
 * high confidence without a court_record-class source. (T-C4)
 */
export const CRIME_KINDS = new Set<string>([
  "criminal_case_event",
  "court_case",
  "case",
  "legal_record",
]);
export function isCrimeKind(kind: string | null | undefined): boolean {
  return CRIME_KINDS.has(String(kind ?? "").toLowerCase());
}

/** Hard confidence ceiling for crime-kind artifacts lacking a court_record source. */
export const CRIME_WEAK_CAP = 40;

/**
 * Map a normalized status string into the canonical enum. Out-of-enum strings
 * that assert a settled finding become `needs_review` (so we never *invent* a
 * confirmation); other out-of-enum strings become `new`.
 */
export function coerceStatus(rawStatus: string | null | undefined): ArtifactStatus {
  const s = String(rawStatus ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (STATUS_SET.has(s)) return s as ArtifactStatus;
  if (isConfirmedStatus(s)) return "needs_review";
  return "new";
}

export interface DeriveStatusInput {
  cap: number;                     // numeric cap from applyEvidenceCaps
  rawStatus: string | null | undefined;
  classes: SourceClass[];          // source classes present on the artifact
  kind?: string | null;            // artifact kind (to apply crime-kind bar)
  verificationStatus?: string | null; // self-reported verification_status, if any
}

export interface DeriveStatusResult {
  status: ArtifactStatus;
  downgraded: boolean;
  reason?: string;                 // why the status was clamped, when it was
}

/**
 * Single shared authority that decides the persisted status label. Reused by
 * every record path + the contradiction write-back + memory recall (C2/C3/C4/
 * H2/H3). A confirmed/settled status is only allowed to survive when:
 *   • the numeric cap is ≥ 90, AND
 *   • the evidence spans a court_record class PLUS an independent class
 *     (news / independent_public / official_profile_match), AND
 *   • the evidence is multi-class (≥ 2 distinct classes), AND
 *   • the artifact does not self-flag UNVERIFIED.
 * For crime kinds the court_record class is mandatory regardless of the above.
 * Anything that fails is downgraded to needs_review (crime kinds →
 * manual_review_required).
 */
export function deriveStatus(input: DeriveStatusInput): DeriveStatusResult {
  const { cap, rawStatus, classes, kind, verificationStatus } = input;
  const uniq = Array.from(new Set(classes ?? []));
  const crime = isCrimeKind(kind);
  const reviewStatus: ArtifactStatus = crime ? "manual_review_required" : "needs_review";

  // Normalize first — out-of-enum strings already collapse confirmations.
  let status = coerceStatus(rawStatus);
  const wantedConfirmed = isConfirmedStatus(rawStatus);

  const downgrade = (reason: string): DeriveStatusResult => ({
    status: reviewStatus,
    downgraded: true,
    reason,
  });

  // Self-flagged UNVERIFIED can never persist a confirmed status. (C1)
  if (wantedConfirmed && isUnverified(verificationStatus)) {
    return downgrade("verification_status is UNVERIFIED");
  }

  // Crime kinds: a confirmed status — or any high confidence — requires a
  // court_record class. (C4)
  if (crime) {
    const hasCourt = uniq.includes("court_record");
    if (!hasCourt && (wantedConfirmed || cap > CRIME_WEAK_CAP)) {
      return downgrade("crime-attribution kind without a court_record-class source");
    }
  }

  if (wantedConfirmed) {
    // Single weak class can never corroborate/confirm. (C3)
    if (uniq.length < 2) {
      return downgrade(`single source class (${uniq[0] ?? "unknown"}) cannot confirm`);
    }
    // Numeric cap must support a confirmation. (C2)
    if (cap < 90) {
      return downgrade(`numeric cap ${cap} < 90 cannot support a confirmed status`);
    }
    // Must include a court_record class AND an independent class. (C2)
    const hasCourt = uniq.includes("court_record");
    const hasIndependent = uniq.some(
      (c) => c === "news" || c === "independent_public" || c === "official_profile_match",
    );
    if (!(hasCourt && hasIndependent)) {
      return downgrade("confirmed status requires court_record + an independent class");
    }
    // Survives every gate — promote to the canonical settled status.
    status = "verified";
  }

  return { status, downgraded: false };
}

// ──────────────────────────────────────────────────────────────────────────
// T-H3 — memory re-injection sanitation.
//
// A "treat as high-confidence corroboration / cite as confirmed" lesson can be
// saved as free-text and re-surfaced via memory_recall. Re-injected into model
// context, it acts as a cap-override: the model is told to lift an artifact's
// status/confidence past the class clamp. These helpers strip the imperative
// confidence directives before re-injection and clamp any memory-borne
// confidence down to what the class clamp authorizes. Recalled memory can
// SUGGEST a lead but can never LIFT a finding above deriveStatus/the class cap.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Imperative confidence directives that must be neutralized before a lesson is
 * re-injected. Matches phrases like "treat as high-confidence", "cite as
 * confirmed", "high-confidence corroboration", "mark as verified", "consider
 * this confirmed", "override the cap", etc.
 */
const CONFIDENCE_DIRECTIVE_RE = new RegExp(
  [
    "\\b(?:treat|mark|cite|score|consider|count|regard|rate|set|flag|tag|record|report|label)\\s+(?:this|it|them|as|the\\s+\\w+\\s+as)?\\s*(?:as\\s+)?(?:high[- ]?confidence|confirmed|corroborat\\w*|verified|certain|conclusive|definitive|proven|settled|guilty|convicted)\\b",
    "\\bhigh[- ]?confidence\\s+(?:corroborat\\w*|confirmation|match|finding|identity|attribution|evidence)\\b",
    "\\b(?:override|ignore|bypass|disregard|raise|lift|boost|increase|skip)\\s+(?:the\\s+)?(?:confidence\\s+)?(?:cap|clamp|cap\\s+engine|limit|ceiling|threshold|review|gate)\\b",
    "\\b(?:always|automatically|auto)\\s+(?:treat|mark|cite|confirm|trust|verify)\\b",
    "\\bcan\\s+be\\s+(?:treated|cited|marked)\\s+as\\s+(?:high[- ]?confidence|confirmed|verified)\\b",
  ].join("|"),
  "gi",
);

export interface SanitizeMemoryResult {
  content: string;
  downWeighted: boolean;       // true when a directive was stripped
  strippedDirectives: string[];
}

/**
 * Strip imperative confidence directives from a lesson's free text before it is
 * re-injected into model context. The factual remainder is preserved; only the
 * "treat as confirmed"-style instructions are neutralized.
 */
export function sanitizeMemoryContent(raw: string | null | undefined): SanitizeMemoryResult {
  const text = String(raw ?? "");
  const stripped: string[] = [];
  const cleaned = text.replace(CONFIDENCE_DIRECTIVE_RE, (m) => {
    stripped.push(m.trim());
    return "[directive removed]";
  });
  return {
    content: cleaned.replace(/\s{2,}/g, " ").trim(),
    downWeighted: stripped.length > 0,
    strippedDirectives: stripped,
  };
}

/**
 * Clamp a memory entry's confidence so recalled memory can never push an
 * artifact above the authoritative class clamp. Recalled memory is advisory:
 * we cap it at the lesser of its own confidence and a conservative ceiling
 * (default 60 — the `unknown`-class cap), and harder when a directive was
 * stripped (the lesson was trying to inflate — trust it less).
 */
export const MEMORY_RECALL_CONFIDENCE_CEILING = 60;
export function clampMemoryConfidence(
  rawConfidence: number | null | undefined,
  opts?: { downWeighted?: boolean; ceiling?: number },
): number {
  const ceiling = Math.min(opts?.ceiling ?? MEMORY_RECALL_CONFIDENCE_CEILING, MEMORY_RECALL_CONFIDENCE_CEILING);
  const c = typeof rawConfidence === "number" && Number.isFinite(rawConfidence) ? rawConfidence : 0;
  const capped = Math.max(0, Math.min(c, ceiling));
  // A lesson that tried to override the cap is trusted less: halve it.
  return opts?.downWeighted ? Math.min(capped, Math.floor(ceiling / 2)) : capped;
}

/**
 * Sanitize a recalled memory row in place-safe fashion: returns a new object
 * with directive-stripped content, a clamped confidence, and an audit flag.
 * Used by both memory_recall and the auto-recall fan-out before the rows reach
 * model context (H3).
 */
export function sanitizeRecalledMemory<T extends { content?: unknown; confidence?: unknown }>(
  row: T,
): T & { content: string; confidence: number; memory_sanitized: boolean; memory_advisory_only: true } {
  const san = sanitizeMemoryContent(typeof row.content === "string" ? row.content : "");
  const conf = clampMemoryConfidence(
    typeof row.confidence === "number" ? row.confidence : null,
    { downWeighted: san.downWeighted },
  );
  return {
    ...row,
    content: san.content,
    confidence: conf,
    memory_sanitized: san.downWeighted,
    memory_advisory_only: true,
  };
}

// Source-class cap table — defensive ceilings on raw model-assigned confidence.
// Keys are SourceClass values; the cap is the maximum confidence allowed when
// the artifact's sources only fall into that class (or a strictly-weaker one).
const CLASS_CAP: Record<SourceClass, number> = {
  breach: 60,
  username_sweep: 45,
  social_profile_passive: 40,
  social_profile_active: 70,
  news: 80,
  court_record: 90,
  official_profile_match: 85,
  independent_public: 75,
  ai_summary: 55,
  infra: 70,
  unknown: 50,
};

// Sources that can never alone produce a high-confidence (>= 90) finding.
// `unknown` is included (C3): a single unverifiable source must not float high.
const NEVER_HIGH = new Set<SourceClass>([
  "breach",
  "username_sweep",
  "social_profile_passive",
  "ai_summary",
  "unknown",
]);

export interface CapInput {
  rawConfidence: number;
  sources: string[]; // tool/source names
  kind?: string | null; // artifact kind — crime kinds get an elevated bar (C4)
  verifiedUrl?: string | null; // verified URL — sole path to court_record/news (H4)
}

export interface CapResult {
  confidence: number;
  cap: number;
  reason_for_confidence: string;
  reason_not_confirmed?: string;
  source_classes: SourceClass[];
}

/** Apply conservative caps. Breach-only ≤60, two breaches ≤65, etc. */
export function applyEvidenceCaps(input: CapInput): CapResult {
  const classes = (input.sources ?? []).map((s) =>
    classifySourceWithUrl(s, input.verifiedUrl ?? null)
  );
  const uniqClasses = Array.from(new Set(classes));
  const counts: Record<string, number> = {};
  for (const c of classes) counts[c] = (counts[c] ?? 0) + 1;

  // Base cap = the most permissive class present.
  let cap = uniqClasses.length === 0
    ? CLASS_CAP.unknown
    : Math.max(...uniqClasses.map((c) => CLASS_CAP[c]));

  // Breach-only nudge: two distinct breach sources → 65 (vs 60).
  if (uniqClasses.length === 1 && uniqClasses[0] === "breach" && (counts.breach ?? 0) >= 2) {
    cap = 65;
  }

  // Cross-class corroboration: ≥2 distinct classes lifts cap.
  if (uniqClasses.length >= 2) {
    cap = Math.min(95, cap + 10);
  }
  if (uniqClasses.includes("court_record") && uniqClasses.some((c) => c === "news" || c === "independent_public")) {
    cap = 95;
  }

  // Hard ceiling: weak-only sources can never get to 90+.
  if (uniqClasses.length === 0 || uniqClasses.every((c) => NEVER_HIGH.has(c))) {
    cap = Math.min(cap, 65);
  }

  // Crime-attribution kinds get an elevated evidentiary bar (C4): without a
  // court_record-class source the confidence is hard-capped at CRIME_WEAK_CAP.
  if (isCrimeKind(input.kind) && !uniqClasses.includes("court_record")) {
    cap = Math.min(cap, CRIME_WEAK_CAP);
  }

  const confidence = Math.max(0, Math.min(input.rawConfidence ?? 50, cap));
  const reason_for_confidence =
    uniqClasses.length >= 2
      ? `corroborated across ${uniqClasses.length} source classes: ${uniqClasses.join(", ")}`
      : `single source class: ${uniqClasses[0] ?? "unknown"}`;
  const reason_not_confirmed = confidence < 90
    ? (uniqClasses.length < 2
        ? "needs second independent class of evidence"
        : "evidence does not yet meet official+independent threshold")
    : undefined;

  return { confidence, cap, reason_for_confidence, reason_not_confirmed, source_classes: uniqClasses };
}
