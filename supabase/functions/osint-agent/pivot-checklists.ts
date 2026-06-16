// Per-query-type pivot checklists + exhaustion gating (edge runtime).
//
// The 1677 Iroquois Rd trace declared the investigation finished ("fan-out looks
// complete") while county assessor/recorder, CA SOS, business license, reverse
// phone and OATHNET property pivots were never attempted. A pivot may only be
// declared exhausted once every required pivot for the active query type(s) has
// been attempted, satisfied, or explicitly marked unavailable.

import type { QueryType } from "./query-type-router.ts";
import type { SourceClass } from "./source-classification.ts";

export type PivotStatus = "pending" | "attempted" | "satisfied" | "unavailable" | "blocked";

export interface PivotRequirement {
  id: string;
  label: string;
  queryTypes: QueryType[];
  /** Logical tool groups that can satisfy this pivot (matched by the router). */
  preferredToolGroups: string[];
  /** If true, the pivot must be attempted/satisfied/unavailable before exhaustion. */
  requiredForExhaustion: boolean;
  /** A source class from this set satisfies the pivot when an artifact is recorded. */
  satisfiesWithSourceClasses: SourceClass[];
}

// ── Address / property ───────────────────────────────────────────────────────
export const ADDRESS_PROPERTY_PIVOTS: PivotRequirement[] = [
  {
    id: "exact_address_search",
    label: "Exact address search",
    queryTypes: ["address", "property"],
    preferredToolGroups: ["web_search", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["web_search", "real_estate_listing", "government_property_record"],
  },
  {
    id: "county_assessor_parcel",
    label: "County assessor / parcel lookup",
    queryTypes: ["address", "property"],
    preferredToolGroups: ["oathnet_property", "government_property_record", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["government_property_record"],
  },
  {
    id: "county_recorder_deed",
    label: "County recorder / deed lookup",
    queryTypes: ["address", "property"],
    preferredToolGroups: ["oathnet_property", "government_property_record", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["government_property_record"],
  },
  {
    id: "address_business_crosscheck",
    label: "Address + business cross-check",
    queryTypes: ["address", "property", "business"],
    preferredToolGroups: ["business_directory", "oathnet_business", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["business_directory", "government_business_registry"],
  },
  {
    id: "address_phone_crosscheck",
    label: "Address + phone cross-check",
    queryTypes: ["address", "phone"],
    preferredToolGroups: ["reverse_phone", "business_directory", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["business_directory", "public_record"],
  },
];

// ── Business ─────────────────────────────────────────────────────────────────
export const BUSINESS_PIVOTS: PivotRequirement[] = [
  {
    id: "sos_entity_registry",
    label: "Secretary of State entity registry",
    queryTypes: ["business"],
    preferredToolGroups: ["government_business_registry", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["government_business_registry"],
  },
  {
    id: "business_license",
    label: "City/county business license",
    queryTypes: ["business"],
    preferredToolGroups: ["government_business_license", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["government_business_license"],
  },
  {
    id: "business_directory_listing",
    label: "Business directory listing",
    queryTypes: ["business"],
    preferredToolGroups: ["business_directory"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["business_directory"],
  },
  {
    id: "business_phone_address",
    label: "Business phone/address cross-check",
    queryTypes: ["business", "phone", "address"],
    preferredToolGroups: ["reverse_phone", "business_directory", "web_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["business_directory", "public_record"],
  },
];

// ── Person ───────────────────────────────────────────────────────────────────
export const PERSON_PIVOTS: PivotRequirement[] = [
  {
    id: "person_exact_name_location",
    label: "Exact name + location",
    queryTypes: ["person"],
    preferredToolGroups: ["web_search", "minimax_deep_dork", "people_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["web_search", "public_record", "news"],
  },
  {
    id: "person_public_record",
    label: "Public-record / people-search lookup",
    queryTypes: ["person"],
    preferredToolGroups: ["people_search", "oathnet_person", "public_record"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["public_record", "government_property_record", "court_record"],
  },
  {
    id: "person_professional_profile",
    label: "Professional profile",
    queryTypes: ["person"],
    preferredToolGroups: ["professional_profile", "web_search"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["professional_profile"],
  },
  {
    id: "person_name_org_address_phone",
    label: "Name + org / address / phone cross-check",
    queryTypes: ["person", "business", "address", "phone"],
    preferredToolGroups: ["minimax_deep_dork", "people_search", "business_directory"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["public_record", "business_directory", "government_property_record"],
  },
  {
    id: "person_collision_clustering",
    label: "Same-name collision clustering",
    queryTypes: ["person"],
    preferredToolGroups: ["minimax_deep_dork", "web_search"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["web_search", "public_record"],
  },
];

// ── Phone ────────────────────────────────────────────────────────────────────
export const PHONE_PIVOTS: PivotRequirement[] = [
  {
    id: "phone_reverse",
    label: "Reverse phone lookup",
    queryTypes: ["phone"],
    preferredToolGroups: ["reverse_phone", "oathnet_phone", "people_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["public_record", "social_profile_passive"],
  },
  {
    id: "phone_business_listing",
    label: "Business listing for phone",
    queryTypes: ["phone", "business"],
    preferredToolGroups: ["business_directory", "web_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["business_directory"],
  },
  {
    id: "phone_breach",
    label: "Breach/leak references for phone",
    queryTypes: ["phone"],
    preferredToolGroups: ["breach", "oathnet_phone"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["breach"],
  },
  {
    id: "phone_exact_dork",
    label: "Exact-phone web dorks",
    queryTypes: ["phone"],
    preferredToolGroups: ["web_search", "minimax_deep_dork"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["web_search"],
  },
];

// ── Email ────────────────────────────────────────────────────────────────────
export const EMAIL_PIVOTS: PivotRequirement[] = [
  {
    id: "email_breach",
    label: "Breach exposure",
    queryTypes: ["email"],
    preferredToolGroups: ["breach", "oathnet_email"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["breach"],
  },
  {
    id: "email_domain",
    label: "Domain context",
    queryTypes: ["email", "domain"],
    preferredToolGroups: ["domain_whois", "domain_dns"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "email_username_reuse",
    label: "Local-part username reuse",
    queryTypes: ["email", "username"],
    preferredToolGroups: ["username_enum", "web_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["social_profile_active", "web_search"],
  },
  {
    id: "email_social",
    label: "Social / profile presence",
    queryTypes: ["email"],
    preferredToolGroups: ["social_profile", "gravatar"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["social_profile_active", "social_profile_passive"],
  },
];

// ── Username ─────────────────────────────────────────────────────────────────
export const USERNAME_PIVOTS: PivotRequirement[] = [
  {
    id: "username_exact_enum",
    label: "Cross-platform username enumeration",
    queryTypes: ["username"],
    preferredToolGroups: ["username_enum", "social_profile"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["social_profile_active", "username_sweep"],
  },
  {
    id: "username_profile_meta",
    label: "Profile metadata",
    queryTypes: ["username"],
    preferredToolGroups: ["social_profile", "web_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["social_profile_active"],
  },
  {
    id: "username_avatar_reuse",
    label: "Avatar reuse",
    queryTypes: ["username"],
    preferredToolGroups: ["reverse_image", "gravatar"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["social_profile_active"],
  },
  {
    id: "username_archive",
    label: "Archive / bio links",
    queryTypes: ["username"],
    preferredToolGroups: ["archive", "web_search"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["archive"],
  },
];

// ── Domain / URL ─────────────────────────────────────────────────────────────
export const DOMAIN_PIVOTS: PivotRequirement[] = [
  {
    id: "domain_whois",
    label: "WHOIS / registration",
    queryTypes: ["domain", "url"],
    preferredToolGroups: ["domain_whois"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "domain_dns",
    label: "DNS records",
    queryTypes: ["domain", "url"],
    preferredToolGroups: ["domain_dns"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "domain_ssl_certs",
    label: "SSL/TLS certificates",
    queryTypes: ["domain", "url"],
    preferredToolGroups: ["certificate_transparency"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "domain_reputation",
    label: "Reputation / malware",
    queryTypes: ["domain", "url"],
    preferredToolGroups: ["malware_reputation"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "domain_archive",
    label: "Archive / history",
    queryTypes: ["domain", "url"],
    preferredToolGroups: ["archive"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["archive"],
  },
];

// ── IP / ASN ─────────────────────────────────────────────────────────────────
export const IP_PIVOTS: PivotRequirement[] = [
  {
    id: "ip_asn_org",
    label: "ASN / org",
    queryTypes: ["ip", "asn"],
    preferredToolGroups: ["ip_asn"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "ip_reverse_dns",
    label: "Reverse / passive DNS",
    queryTypes: ["ip", "asn"],
    preferredToolGroups: ["ip_asn", "domain_dns"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
  {
    id: "ip_reputation",
    label: "Reputation",
    queryTypes: ["ip", "asn"],
    preferredToolGroups: ["malware_reputation"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["infra"],
  },
];

// ── Image / media ────────────────────────────────────────────────────────────
export const IMAGE_PIVOTS: PivotRequirement[] = [
  {
    id: "media_exif",
    label: "Metadata / EXIF",
    queryTypes: ["image", "media"],
    preferredToolGroups: ["exif"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["independent_public"],
  },
  {
    id: "media_reverse_image",
    label: "Reverse image search",
    queryTypes: ["image", "media"],
    preferredToolGroups: ["reverse_image"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["web_search", "independent_public"],
  },
  {
    id: "media_ocr",
    label: "OCR / visible entities",
    queryTypes: ["image", "media"],
    preferredToolGroups: ["ocr"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["independent_public"],
  },
];

// ── Crypto ───────────────────────────────────────────────────────────────────
export const CRYPTO_PIVOTS: PivotRequirement[] = [
  {
    id: "crypto_tx_history",
    label: "Chain / tx history",
    queryTypes: ["crypto_wallet", "transaction"],
    preferredToolGroups: ["chain_explorer"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["independent_public"],
  },
  {
    id: "crypto_labels",
    label: "Address labels / attribution",
    queryTypes: ["crypto_wallet", "transaction"],
    preferredToolGroups: ["chain_explorer", "web_search"],
    requiredForExhaustion: true,
    satisfiesWithSourceClasses: ["independent_public", "web_search"],
  },
  {
    id: "crypto_public_mentions",
    label: "Public mentions",
    queryTypes: ["crypto_wallet", "transaction"],
    preferredToolGroups: ["web_search", "minimax_deep_dork"],
    requiredForExhaustion: false,
    satisfiesWithSourceClasses: ["web_search"],
  },
];

export const ALL_PIVOT_REQUIREMENTS: PivotRequirement[] = [
  ...ADDRESS_PROPERTY_PIVOTS,
  ...BUSINESS_PIVOTS,
  ...PERSON_PIVOTS,
  ...PHONE_PIVOTS,
  ...EMAIL_PIVOTS,
  ...USERNAME_PIVOTS,
  ...DOMAIN_PIVOTS,
  ...IP_PIVOTS,
  ...IMAGE_PIVOTS,
  ...CRYPTO_PIVOTS,
];

/** Requirements that apply to ANY of the active query types. */
export function requirementsForQueryTypes(
  queryTypes: QueryType[],
  requirements: PivotRequirement[] = ALL_PIVOT_REQUIREMENTS,
): PivotRequirement[] {
  const active = new Set(queryTypes);
  return requirements.filter((req) => req.queryTypes.some((qt) => active.has(qt)));
}

export interface ExhaustionInput {
  queryTypes: QueryType[];
  attemptedPivotIds: Set<string>;
  satisfiedPivotIds: Set<string>;
  unavailablePivotIds: Set<string>;
  requirements?: PivotRequirement[];
}

export interface ExhaustionResult {
  canExhaust: boolean;
  pending: PivotRequirement[];
  reason: string;
}

/** A query type's pivot may only be exhausted once every required pivot has been
 *  attempted, satisfied, or explicitly marked unavailable. */
export function canExhaustPivot(input: ExhaustionInput): ExhaustionResult {
  const requirements = input.requirements ?? ALL_PIVOT_REQUIREMENTS;
  const relevant = requirements.filter(
    (req) => req.requiredForExhaustion && req.queryTypes.some((qt) => input.queryTypes.includes(qt)),
  );

  const pending = relevant.filter(
    (req) =>
      !input.attemptedPivotIds.has(req.id) &&
      !input.satisfiedPivotIds.has(req.id) &&
      !input.unavailablePivotIds.has(req.id),
  );

  if (pending.length > 0) {
    return {
      canExhaust: false,
      pending,
      reason: `Cannot exhaust: ${pending.length} required ${input.queryTypes.join("/")} pivot(s) pending — ${pending
        .map((p) => p.id)
        .join(", ")}`,
    };
  }

  return {
    canExhaust: true,
    pending: [],
    reason: "All required pivots attempted, satisfied, or unavailable",
  };
}

/** Human-readable checklist for the system prompt / planner. */
export function renderPivotChecklistForPrompt(queryTypes: QueryType[]): string {
  const reqs = requirementsForQueryTypes(queryTypes).filter((r) => r.requiredForExhaustion);
  if (reqs.length === 0) return "";
  const lines = [`REQUIRED pivots for ${queryTypes.join("/")} before you may report "exhausted":`];
  for (const r of reqs) {
    lines.push(`  - [${r.id}] ${r.label} (try: ${r.preferredToolGroups.join(", ")})`);
  }
  lines.push(
    `Each must be attempted, satisfied, or recorded unavailable (e.g. provider returned no data / not configured). ` +
      `Until then, conclude "no direct link found yet in searched sources; pending pivots: …" — never "exhausted".`,
  );
  return lines.join("\n");
}
