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
  infra_registry: 75,
  infra_dns: 75,
  infra_scan: 70,
  infra_reputation: 65,
  unknown: 50,
};

// Infrastructure sub-classes that should count as independent perspectives
// when corroborating infrastructure claims (domain exists, resolves, has
// footprint) — but NOT when corroborating identity/ownership claims.
const INFRA_SUBCLASSES = new Set<SourceClass>([
  "infra_registry",
  "infra_dns",
  "infra_scan",
  "infra_reputation",
  "infra",
]);

function isInfraClass(c: SourceClass): boolean {
  return INFRA_SUBCLASSES.has(c);
}

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

  // ── Infrastructure sub-class corroboration ──
  // Count how many distinct infra sub-classes are present. If ≥2, they
  // corroborate an infrastructure claim (domain exists, resolves, has
  // footprint) and the cap can lift — but NOT past 85, because infra
  // alone cannot confirm identity or ownership.
  const infraClasses = uniqClasses.filter(isInfraClass);
  const nonInfraClasses = uniqClasses.filter((c) => !isInfraClass(c));
  const infraOnly = nonInfraClasses.length === 0 && infraClasses.length > 0;

  if (infraClasses.length >= 2) {
    // Modest boost for 2 sub-classes, stronger for 3+.
    const infraBoost = infraClasses.length >= 3 ? 15 : 8;
    cap = Math.min(infraOnly ? 85 : 95, cap + infraBoost);
  }

  // Cross-class corroboration (non-infra or mixed): ≥2 distinct classes lifts cap.
  if (uniqClasses.length >= 2 && !infraOnly) {
    cap = Math.min(95, cap + 10);
  }
  if (uniqClasses.includes("court_record") && uniqClasses.some((c) => c === "news" || c === "independent_public")) {
    cap = 95;
  }

  // Hard ceiling: weak-only sources can never get to 90+.
  if (uniqClasses.every((c) => NEVER_HIGH.has(c))) {
    cap = Math.min(cap, 65);
  }

  // Infra-only hard ceiling: infrastructure evidence alone can support a
  // domain/IP claim but never confirm identity or ownership.
  if (infraOnly) {
    cap = Math.min(cap, 85);
  }

  const confidence = Math.max(0, Math.min(input.rawConfidence ?? 50, cap));

  // Build human-readable reason strings.
  const infraCount = infraClasses.length;
  const totalDistinct = uniqClasses.length;
  let reason_for_confidence: string;
  if (totalDistinct >= 2 && infraCount >= 2 && infraOnly) {
    reason_for_confidence = `infrastructure corroborated across ${infraCount} sub-classes: ${infraClasses.join(", ")}`;
  } else if (totalDistinct >= 2) {
    reason_for_confidence = `corroborated across ${totalDistinct} source classes: ${uniqClasses.join(", ")}`;
  } else {
    reason_for_confidence = `single source class: ${uniqClasses[0] ?? "unknown"}`;
  }

  let reason_not_confirmed: string | undefined;
  if (confidence >= 90) {
    reason_not_confirmed = undefined;
  } else if (infraOnly && infraCount >= 2) {
    reason_not_confirmed = "infrastructure evidence supports existence, not ownership or identity";
  } else if (totalDistinct < 2) {
    reason_not_confirmed = "needs second independent class of evidence";
  } else {
    reason_not_confirmed = "evidence does not yet meet official+independent threshold";
  }

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

// ---- Bio-linked cross-platform name gate -------------------------------------
// A profile bio frequently lists OTHER people's handles/names — collaborators,
// shoutouts, group members, "prod. by X", a friend's Facebook. The orchestrator
// has mistaken a bio-linked Facebook *name* for the subject's legal name and
// promoted it over the subject's own display name + an independent search hit
// (real case: SoundCloud "ohifearius" / "BosMan G" mis-reported as the FB name
// "Raheem Abdul Bey" pulled from the bio link block, when the corroborated
// identity was "Darius Johnson").
//
// A NAME asserted only because it appeared in / was linked from a bio is an
// UNVERIFIED identity claim. It must stay a lead, never the confirmed identity:
// we cap it low and flag it so the report and any merge cannot anchor on it.
export const BIO_CROSS_LINK_NAME_CAP = 30;

const BIO_LINK_KEYS = ["from_bio", "bio_link", "bio_mention", "linked_from_bio"];

/** True when this is a person `name` whose only provenance is a bio cross-link
 * (i.e. it was scraped out of a profile's bio / linked-accounts block rather
 * than being the profile's own display name or an independently searched name). */
export function isBioCrossLinkName(
  kind: string | null | undefined,
  meta: Record<string, unknown> | null | undefined,
): boolean {
  if (kind !== "name") return false;
  const m = meta ?? {};
  for (const key of BIO_LINK_KEYS) {
    const v = m[key];
    if (v === true) return true;
    if (typeof v === "string" && /^(true|yes|1)$/i.test(v)) return true;
  }
  return false;
}
