// Five-axis confidence engine.
// Replaces a single percentage with axis-decomposed scores so the UI / report
// can show *why* a finding is strong or weak.

import { tierOf, TIER_SOURCE_RELIABILITY, TIER_C_ONLY_CONFIDENCE_CAP } from "./tiers.ts";
import type { ContradictionFinding } from "./contradictions.ts";
import { classifySource, type SourceClass } from "./artifact_types.ts";

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
const NEVER_HIGH = new Set<SourceClass>([
  "breach",
  "username_sweep",
  "social_profile_passive",
  "ai_summary",
]);

export interface CapInput {
  rawConfidence: number;
  sources: string[]; // tool/source names
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
  const classes = (input.sources ?? []).map(classifySource);
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
  if (uniqClasses.every((c) => NEVER_HIGH.has(c))) {
    cap = Math.min(cap, 65);
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

// ---- Different-person / unrelated-entity gate --------------------------------
// The orchestrator routinely discovers same-name/same-handle collisions that
// belong to a DIFFERENT entity than the seed (e.g. an unrelated TikTok user who
// happens to share a handle, or a namesake at a different company). It records
// these with a metadata note ("UNRELATED individual", "DIFFERENT company",
// "different entity") or an explicit boolean. Historically the server ignored
// those flags, so the namesake kept its full confidence and polluted the case.
//
// This detects the flag from metadata and, when set, downgrades the artifact to
// an excluded_collision with a hard-capped confidence so it can't roll up into
// the case score or get mistaken for a confirmed link.
const UNRELATED_NOTE_RE =
  /\b(unrelated|different\s+(?:person|individual|company|entity|firm|org(?:anization)?)|not\s+(?:the\s+same|related|our\s+(?:target|subject))|namesake|wrong\s+(?:person|entity)|collision|coincidental)\b/i;

export const EXCLUDED_COLLISION_CONFIDENCE = 15;

export function isUnrelatedEntity(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta ?? {};
  // Explicit booleans the model may set.
  if (m.different_person === true || m.unrelated === true || m.is_collision === true) return true;
  if (typeof m.different_person === "string" && /^(true|yes|1)$/i.test(m.different_person)) return true;
  // Note / free-text fields the model commonly uses instead of a boolean.
  for (const key of ["note", "notes", "reason", "relationship", "disposition"]) {
    const v = m[key];
    if (typeof v === "string" && UNRELATED_NOTE_RE.test(v)) return true;
  }
  return false;
}
