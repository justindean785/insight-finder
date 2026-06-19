// Five-axis confidence engine.
// Replaces a single percentage with axis-decomposed scores so the UI / report
// can show *why* a finding is strong or weak.
//
// ── Merge note (backport mirror #16 PR2) ────────────────────────────────────
// SourceClass + classifySource now come from source-classification.ts (mirror
// #16's single-classifier architecture). The CLASS_CAP table and applyEvidenceCaps
// below preserve post-#56 main's BEHAVIOR verbatim — the SPLIT-infra caps, the
// infra-corroboration boost, the ownership guard, and the NEVER_HIGH ceiling are
// the integrity contract (audit_fixes_test.ts). #16's status-derivation helpers
// (deriveStatus / coerceCoherentStatus / looksDeadEnd) are kept (index.ts wires
// them). For back-compat, classifySource / SourceClass are re-exported here.

import { tierOf, TIER_SOURCE_RELIABILITY, TIER_C_ONLY_CONFIDENCE_CAP } from "./tiers.ts";
import type { ContradictionFinding } from "./contradictions.ts";
import { classifySource, countIndependentClasses, type SourceClass } from "./source-classification.ts";

// Back-compat re-export: historically these lived in confidence.ts / artifact_types.ts.
export { classifySource, type SourceClass };

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
//
// post-#56 main values are the integrity contract (infra split). #16's free-text
// classes (government_*/business_directory/real_estate_listing/etc.) are appended
// with #16's caps so the table is exhaustive over the merged SourceClass union.
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
  // ── infrastructure (post-#56 split caps — the integrity contract) ──
  infra: 70,
  infra_registry: 75,
  infra_dns: 75,
  infra_scan: 70,
  infra_reputation: 65,
  infra_passive: 70,
  // Shared/CDN host & reverse-IP co-tenancy: describes neighbours, not the
  // subject. Capped very low and never counted as independent corroboration.
  infra_shared_host: 35,
  // ── public-record / directory / listing classes (free-text labels, #16) ──
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

// Infrastructure sub-classes. These count as independent perspectives when
// corroborating an INFRASTRUCTURE claim (domain exists, resolves, has
// footprint) — but never when corroborating identity/ownership.
const INFRA_SUBCLASSES = new Set<SourceClass>([
  "infra_registry",
  "infra_dns",
  "infra_scan",
  "infra_reputation",
  "infra_passive",
  "infra_shared_host",
  "infra",
]);

function isInfraClass(c: SourceClass): boolean {
  return INFRA_SUBCLASSES.has(c);
}

// Infra sub-classes that can actually CORROBORATE an infra claim. A shared/CDN
// host tells you nothing the subject controls, so it is excluded — it must not
// lift a cap or count toward the "≥2 sub-classes" infra-corroboration boost.
function isInfraCorroborationClass(c: SourceClass): boolean {
  return isInfraClass(c) && c !== "infra_shared_host";
}

// Only these non-infra classes are strong enough to unlock the 90+ ownership /
// identity path. Weak signals (ai_summary, username_sweep, breach-only, passive
// social) can supply context but must never lift a finding past the infra-safe
// ceiling on their own. (#16's official/government public-record classes are
// added — they are authoritative identity/ownership sources too.)
const TRUSTED_NON_INFRA = new Set<SourceClass>([
  "official_profile_match",
  "court_record",
  "news",
  "independent_public",
  "government_property_record",
  "government_business_registry",
  "government_business_license",
  "public_record",
]);

// Sources that can never alone produce a high-confidence (>= 90) finding.
// (post-#56 main set, plus #16's weak free-text classes.)
const NEVER_HIGH = new Set<SourceClass>([
  "breach",
  "username_sweep",
  "social_profile_passive",
  "ai_summary",
  "infra_shared_host",
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
  // Distinct infra sub-classes that can corroborate (shared-host excluded). If
  // ≥2, they corroborate an infrastructure claim (domain exists, resolves, has
  // footprint) and the cap can lift — but NOT past 85, because infrastructure
  // alone never confirms identity or ownership.
  const infraCorroborationClasses = uniqClasses.filter(isInfraCorroborationClass);
  const nonInfraClasses = uniqClasses.filter((c) => !isInfraClass(c));
  const hasTrustedNonInfra = nonInfraClasses.some((c) => TRUSTED_NON_INFRA.has(c));
  // "infra-only" for ownership purposes = nothing but infrastructure signals.
  const infraOnly = nonInfraClasses.length === 0 && uniqClasses.some(isInfraClass);

  if (infraCorroborationClasses.length >= 2) {
    // Modest boost for 2 sub-classes, stronger for 3+.
    const infraBoost = infraCorroborationClasses.length >= 3 ? 15 : 8;
    cap = Math.min(95, cap + infraBoost);
  }

  // Cross-class corroboration with a non-infra class: ≥2 distinct classes lifts
  // the cap. This is allowed for any mix, but the trusted-class guard below
  // prevents weak non-infra signals from escaping the infra-safe ceiling.
  if (uniqClasses.length >= 2 && !infraOnly) {
    cap = Math.min(95, cap + 10);
  }
  if (uniqClasses.includes("court_record") && uniqClasses.some((c) => c === "news" || c === "independent_public")) {
    cap = 95;
  }

  // Hard ceiling: weak-only sources can never get to 90+.
  if (uniqClasses.length > 0 && uniqClasses.every((c) => NEVER_HIGH.has(c))) {
    cap = Math.min(cap, 65);
  }

  // Ownership / identity guard: without at least one TRUSTED non-infra class
  // (official match, court record, news, independent public page, government
  // public record), a finding can never exceed the infra-safe ceiling of 85 —
  // no matter how many infra sub-classes or weak ai_summary/breach signals
  // corroborate it. This is what stops "infra + ai_summary" (or many infra
  // perspectives) from displaying as a confirmed ownership/identity claim.
  if (!hasTrustedNonInfra) {
    cap = Math.min(cap, 85);
  }

  const confidence = Math.max(0, Math.min(input.rawConfidence ?? 50, cap));

  // Build human-readable reason strings.
  const infraCount = infraCorroborationClasses.length;
  const totalDistinct = uniqClasses.length;
  let reason_for_confidence: string;
  if (infraOnly && infraCount >= 2) {
    reason_for_confidence = `infrastructure corroborated across ${infraCount} sub-classes: ${infraCorroborationClasses.join(", ")}`;
  } else if (totalDistinct >= 2) {
    reason_for_confidence = `corroborated across ${totalDistinct} source classes: ${uniqClasses.join(", ")}`;
  } else {
    reason_for_confidence = `single source class: ${uniqClasses[0] ?? "unknown"}`;
  }

  let reason_not_confirmed: string | undefined;
  if (confidence >= 90) {
    reason_not_confirmed = undefined;
  } else if (infraOnly) {
    reason_not_confirmed = "infrastructure evidence supports existence, not ownership or identity";
  } else if (!hasTrustedNonInfra && totalDistinct >= 2) {
    reason_not_confirmed = "no independent identity/ownership source — needs an official, court, news, or independent-public class";
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

/** Canonical artifact status whitelist — the ONLY values allowed to land in
 *  `metadata.status`. Anything else is normalized away. */
export const ARTIFACT_STATUS_WHITELIST: readonly ArtifactStatus[] = [
  "observed",
  "needs_corroboration",
  "verified",
  "confirmed",
  "excluded",
  "exhausted",
  "contradicted",
  "needs_review",
  "manual_review_required",
] as const;

const STATUS_WHITELIST_SET: ReadonlySet<string> = new Set(ARTIFACT_STATUS_WHITELIST);

/** Map common legacy / free-text labels into the canonical whitelist. Anything
 *  not in the whitelist or this alias map falls through to `needs_review` so
 *  arbitrary model-asserted strings ("CONFIRMED", "found", "verify", "active",
 *  "inferred", "documented", "private", "deceased", free text…) can never
 *  pollute the artifact stream again. */
const STATUS_ALIAS: Record<string, ArtifactStatus> = {
  new: "observed",
  found: "observed",
  active: "observed",
  noted: "observed",
  documented: "observed",
  inferred: "needs_corroboration",
  probable: "needs_corroboration",
  unverified_connection: "needs_corroboration",
  unverified_bio_link: "needs_corroboration",
  verify: "needs_review",
  needs_verification: "needs_review",
  needs_verify: "needs_review",
  pending: "needs_review",
  unknown: "needs_review",
  manual_review: "manual_review_required",
  // Evidence-integrity policy (P1 audit follow-up): legacy high-confidence
  // labels do NOT promote to confirmed/verified on their own. They become a
  // review lead; the cap engine / deriveStatus must lift them based on
  // source classes, not on a model-asserted string.
  confirmed_owner: "needs_review",
  primary_subject: "observed",
  verified_clean: "verified",
  clean: "verified",
  deliverable: "verified",
  correlated: "verified",
  public_record: "needs_review",
  not_found: "exhausted",
  page_not_found: "exhausted",
  deleted_or_never_created: "exhausted",
  deactivated: "exhausted",
  account_exists_but_inactive: "exhausted",
  no_content_visible: "exhausted",
  inaccessible: "exhausted",
  auth_gated: "exhausted",
  private: "exhausted",
  rate_limited: "exhausted",
  inactive_402: "exhausted",
  timeout: "exhausted",
  aborted: "exhausted",
  failed: "exhausted",
  false_positive: "excluded",
  deceased: "excluded",
  past_address: "observed",
  current_address: "needs_corroboration",
};

/** Normalize ANY status-shaped input into the canonical whitelist, then apply
 *  the coherence guard: a verified/confirmed status can never coexist with an
 *  open `reason_not_confirmed`. Unknown / free-text / cased values land as
 *  `needs_review`. Safe-downgrade — never throws. */
export function coerceCoherentStatus(
  status: ArtifactStatus | string | null | undefined,
  reasonNotConfirmed?: string | null,
): ArtifactStatus {
  // 1. Normalize shape.
  const raw = (typeof status === "string" ? status : "").trim().toLowerCase();
  let normalized: ArtifactStatus;
  if (raw === "") {
    normalized = "needs_review";
  } else if (STATUS_WHITELIST_SET.has(raw)) {
    normalized = raw as ArtifactStatus;
  } else if (raw in STATUS_ALIAS) {
    normalized = STATUS_ALIAS[raw];
  } else {
    // Strip any free-text trailers and try once more on the leading token.
    const head = raw.split(/[\s—\-:;,(/]+/)[0] ?? "";
    if (STATUS_WHITELIST_SET.has(head)) normalized = head as ArtifactStatus;
    else if (head in STATUS_ALIAS) normalized = STATUS_ALIAS[head];
    else normalized = "needs_review";
  }
  // 2. Coherence guard — verified/confirmed cannot coexist with an open reason.
  if ((normalized === "verified" || normalized === "confirmed") && reasonNotConfirmed) {
    return "needs_corroboration";
  }
  return normalized;
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
