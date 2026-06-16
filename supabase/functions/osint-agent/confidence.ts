// Five-axis confidence engine.
// Replaces a single percentage with axis-decomposed scores so the UI / report
// can show *why* a finding is strong or weak.

import { tierOf, TIER_SOURCE_RELIABILITY, TIER_C_ONLY_CONFIDENCE_CAP } from "./tiers.ts";
import type { ContradictionFinding } from "./contradictions.ts";
import {
  classifySourceLabel,
  countIndependentClasses,
  type SourceClass,
} from "./source-classification.ts";

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
  // public-record / directory / listing classes
  government_property_record: 90,
  government_business_registry: 90,
  government_business_license: 88,
  business_directory: 65,
  real_estate_listing: 60,
  property_aggregator: 55,
  professional_profile: 70,
  social_review: 35,
  public_record: 75,
  web_search: 50,
  archive: 70,
  unknown: 50,
};

// Sources that can never alone produce a high-confidence (>= 90) finding.
// (Government/court/official public records CAN be authoritative alone, so they
// are deliberately excluded.)
const NEVER_HIGH = new Set<SourceClass>([
  "breach",
  "username_sweep",
  "social_profile_passive",
  "ai_summary",
  "social_review",
  "web_search",
  "property_aggregator",
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

/** Apply conservative caps. Breach-only ≤60, two breaches ≤65, etc.
 *
 * `sources` may contain internal tool slugs OR free-text provider labels, and a
 * single entry may be a mixed label ("D&B / Redfin") — classifySourceLabel
 * splits it into multiple classes and drops wrapper labels ("Multiple sources").
 * The CALLER is expected to pass [source, ...metadata.sources] so a wrapper
 * top-level source still resolves via its members. */
export function applyEvidenceCaps(input: CapInput): CapResult {
  const classes = (input.sources ?? []).flatMap(classifySourceLabel);
  const uniqClasses = Array.from(new Set(classes));
  const counts: Record<string, number> = {};
  for (const c of classes) counts[c] = (counts[c] ?? 0) + 1;

  // Distinct classes that can INDEPENDENTLY corroborate (excludes discovery /
  // low-trust aggregators / single AI summaries). Two Redfin pages are still one
  // real_estate_listing class — they never count as independent corroboration.
  const independent = countIndependentClasses(uniqClasses);

  // Base cap = the most permissive class present.
  let cap = uniqClasses.length === 0
    ? CLASS_CAP.unknown
    : Math.max(...uniqClasses.map((c) => CLASS_CAP[c]));

  // Breach-only nudge: two distinct breach sources → 65 (vs 60).
  if (uniqClasses.length === 1 && uniqClasses[0] === "breach" && (counts.breach ?? 0) >= 2) {
    cap = 65;
  }

  // Cross-class corroboration: ≥2 INDEPENDENT classes lifts cap.
  if (independent >= 2) {
    cap = Math.min(95, cap + 10);
  }
  if (uniqClasses.includes("court_record") && uniqClasses.some((c) => c === "news" || c === "independent_public")) {
    cap = 95;
  }

  // Hard ceiling: weak-only sources can never get to 90+.
  if (uniqClasses.length > 0 && uniqClasses.every((c) => NEVER_HIGH.has(c))) {
    cap = Math.min(cap, 65);
  }

  const confidence = Math.max(0, Math.min(input.rawConfidence ?? 50, cap));
  const classList = uniqClasses.join(", ") || "unknown";
  const reason_for_confidence =
    independent >= 2
      ? `corroborated across ${independent} independent source classes: ${classList}`
      : uniqClasses.length >= 2
        ? `multiple source classes (${classList}) but not independently corroborating`
        : `single source class: ${uniqClasses[0] ?? "unknown"}`;
  const reason_not_confirmed = confidence < 90
    ? (independent < 2
        ? `only ${uniqClasses.length <= 1 ? "one" : "low-independence"} source class (${classList}); needs a second independent class (official/government public record, court, or news)`
        : `source classes present (${classList}) but evidence does not yet meet the official+independent threshold`)
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

// ---- Status coherence --------------------------------------------------------
// The recording layer used to persist the model's `status` verbatim, so a
// model-asserted `status: "verified"` coexisted with the cap engine's
// `reason_not_confirmed: "needs second independent class of evidence"` — an
// internally contradictory artifact (the exact bug in the 1677 Iroquois Rd
// trace). Status is now DERIVED from the evidence so it can never contradict the
// confirmation reason.

export type ArtifactStatus =
  | "observed"             // a source asserts this exists; no independent corroboration yet
  | "needs_corroboration" // plausible lead, missing a required independent class
  | "verified"            // sufficiently supported for its OWN limited claim (≥90, no open reason)
  | "confirmed"           // ≥2 independent classes, no material contradiction
  | "excluded"            // unrelated / collision
  | "exhausted"           // dead-end OR pivot checklist complete
  | "contradicted"
  | "needs_review"
  | "manual_review_required";

const DEAD_END_NOTE_RE = /\b(defunct|parked|expired|invalid|no records?|not found|disconnected|no longer (?:in service|active)|404|410)\b/i;

/** True when metadata indicates a genuine dead-end (so "exhausted" is honest). */
export function looksDeadEnd(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta ?? {};
  if (m.http_status === 404 || m.http_status === 410) return true;
  for (const key of ["note", "notes", "reason", "dns_result", "status_detail"]) {
    const v = m[key];
    if (typeof v === "string" && DEAD_END_NOTE_RE.test(v)) return true;
  }
  return false;
}

/** Minimal guard: a verified/confirmed status can never coexist with an open
 *  `reason_not_confirmed`. Safe-downgrade (never throws in production). */
export function coerceCoherentStatus(
  status: ArtifactStatus,
  reasonNotConfirmed?: string | null,
): ArtifactStatus {
  if ((status === "verified" || status === "confirmed") && reasonNotConfirmed) {
    return "needs_corroboration";
  }
  return status;
}

export interface DeriveStatusInput {
  /** status the model asked for (may be a legacy/loose value). */
  requested?: string | null;
  /** the RESOLVED reason_not_confirmed (model-supplied ?? cap). null ⇒ confidence ≥ 90. */
  reasonNotConfirmed: string | null;
  sourceClasses: SourceClass[];
  contradictions?: unknown[];
  unrelated?: boolean;
  deadEnd?: boolean;
  /** for conclusion/pivot artifacts: whether the required pivot checklist is done. */
  pivotChecklistComplete?: boolean;
}

/** Derive a coherent status from the evidence. The invariant guaranteed:
 *  a returned "verified"/"confirmed" implies `reasonNotConfirmed == null`. */
export function deriveStatus(input: DeriveStatusInput): ArtifactStatus {
  const req = (input.requested ?? "").toLowerCase().trim();
  const contra = Array.isArray(input.contradictions) && input.contradictions.length > 0;
  const notConfirmed = !!input.reasonNotConfirmed;
  const independent = countIndependentClasses(input.sourceClasses);

  if (input.unrelated || req === "excluded") return "excluded";
  if (req === "contradicted" || contra) return "contradicted";
  if (req === "needs_review") return "needs_review";
  if (req === "manual_review_required") return "manual_review_required";

  if (req === "exhausted") {
    // Only honor "exhausted" when it's a real dead-end or the checklist is done.
    if (input.deadEnd || input.pivotChecklistComplete) return "exhausted";
    return notConfirmed ? "needs_corroboration" : "observed";
  }

  // verified/confirmed are only granted when there is no open confirmation gap.
  if (notConfirmed) {
    return independent >= 2 ? "needs_corroboration" : "observed";
  }
  // reasonNotConfirmed == null ⇒ confidence ≥ 90 (strong, capped-through).
  if (independent >= 2 && !contra) return "confirmed";
  return "verified";
}
