// Central source-classification layer (edge runtime — source of truth).
//
// The recording paths persist `metadata.source_category` and the confidence
// engine caps on it, so the entity that maps a raw `source` to a SourceClass
// MUST live here and be the only home for that logic.
//
// Two kinds of input flow in:
//   1. internal tool slugs  — e.g. "minimax_web_search", "oathnet_lookup"
//   2. free-text provider labels — e.g. "D&B", "D&B / Redfin", "Houzz review",
//      "Property records search", "Web search", "LinkedIn", "Multiple sources"
//
// Historically (1) was handled by TOOL_CLASS and (2) fell through to `unknown`
// (cap 50) — the exact bug seen in the 1677 Iroquois Rd trace where every
// artifact carried `source_category: ["unknown"]`. This module classifies both,
// splits mixed labels ("D&B / Redfin" → two classes), and recognises wrapper
// labels ("Multiple sources" / "Investigation") so the real provenance is read
// from `metadata.sources` instead.
//
// ── Merge note (backport mirror #16 PR2) ────────────────────────────────────
// This module is the merged single classifier. It adopts mirror #16's
// architecture (one classifier, free-text label support, mixed-label splitting,
// wrapper-label handling, OFFICIAL_CLASSES / countIndependentClasses helpers)
// BUT preserves post-#56 main's BEHAVIOR verbatim: the SPLIT infrastructure
// sub-class taxonomy (infra_registry / infra_dns / infra_scan / infra_reputation
// / infra_passive / infra_shared_host) and main's exact internal-tool → class
// mapping replace #16's coarse single "infra". Where #16 and #56 disagreed on a
// source's class, #56 WON — see the tier-disagreement log in the PR report.

/** Source-class taxonomy used for confidence caps and corroboration counting.
 *  Superset: post-#56 main's split internal-tool classes are preserved (so the
 *  caps + tests stay valid) PLUS the public-record / directory / listing classes
 *  that free-text provider labels map to (from mirror #16). */
export type SourceClass =
  // ── original internal-tool classes (do not rename: TOOL_CLASS + tests rely on these)
  | "breach"
  | "username_sweep"
  | "social_profile_passive"
  | "social_profile_active"
  | "news"
  | "court_record"
  | "official_profile_match"
  | "independent_public"
  | "ai_summary"
  // ── infrastructure (post-#56 SPLIT sub-classes — the integrity contract).
  // Coarse "infra" is retained for legacy/free-text mapping but the tool slugs
  // resolve to specific sub-classes so cross-tool corroboration can count.
  | "infra"
  | "infra_registry"
  | "infra_dns"
  | "infra_scan"
  | "infra_reputation"
  | "infra_passive"
  | "infra_shared_host"
  // ── public-record / directory / listing classes (free-text provider labels)
  | "government_property_record"
  | "government_business_registry"
  | "government_business_license"
  | "business_directory"
  | "real_estate_listing"
  | "property_aggregator"
  | "professional_profile"
  | "social_review"
  | "public_record"
  | "web_search"
  | "archive"
  | "unknown";

/** Internal tool slug → SourceClass. The slug is what the orchestrator passes
 *  as `source` when it records a tool result directly.
 *
 *  Infra slugs map to post-#56 main's SPLIT sub-classes (NOT #16's coarse
 *  "infra"). This is the integrity contract: cross-tool infra corroboration and
 *  the per-sub-class caps depend on these exact values. */
const TOOL_CLASS: Record<string, SourceClass> = {
  // breach / leak
  breach_check: "breach",
  leakcheck_lookup: "breach",
  hibp_lookup: "breach",
  oathnet_lookup: "breach",
  intelbase_email_lookup: "breach",
  stolentax_footprint: "breach",
  deepfind_reverse_email: "breach",
  deepfind_disposable_email: "breach",
  deepfind_email_breach: "breach",
  deepfind_dark_web_link: "breach",
  deepfind_ransomware_exposure: "breach",
  serus_darkweb_scan: "breach",
  leakcheck: "breach", // bare alias of leakcheck_lookup seen in compound source strings
  // ── Phase 1 free tools — mapped to the closest EXISTING source class.
  // TODO(integrity): no "threat_intel" class exists; ransomware-victim exposure
  // is mapped to "breach" (same class as the dead deepfind_ransomware_exposure it
  // replaces). Confirm whether a dedicated threat-intel class/cap is warranted.
  ransomwarelive_lookup: "breach",
  // k-anonymity password-exposure check — breach corpus by nature.
  hibp_pwned_passwords_kanon: "breach",
  // username sweeps
  username_sweep: "username_sweep",
  socialfetch_lookup: "social_profile_passive",
  // search/summary
  minimax_web_search: "ai_summary",
  exa_search: "ai_summary",
  gemini_deep_dork: "ai_summary",
  google_dorks: "ai_summary",
  dork_harvest: "ai_summary",
  jina_reader_scrape: "independent_public",
  exa_get_contents: "independent_public",
  // infra — split into sub-classes so cross-tool corroboration counts (#56)
  whois_lookup: "infra_registry",
  hunter_domain_search: "infra_registry",
  hunter_email_verifier: "infra_registry",
  hunter_combined: "infra_registry",
  dns_records: "infra_dns",
  crtsh_subdomains: "infra_dns",
  ip_intel: "infra_scan",
  ipgeolocation_lookup: "infra_scan",
  shodan_internetdb: "infra_scan",
  http_fingerprint: "infra_scan",
  hackertarget: "infra_scan",
  synapsint_lookup: "infra_scan",
  virustotal_lookup: "infra_reputation",
  ipqualityscore_lookup: "infra_reputation",
  emailrep: "infra_reputation",
  emailrep_lookup: "infra_reputation",
  // certificate transparency — DNS/infra perspective
  crtsh_lookup: "infra_dns",
  // geocoders — address-existence public records
  census_geocode: "public_record",
  nominatim_geocode: "public_record",
  // corporate registry search. TODO(integrity): free-text "opencorporates" maps
  // to "business_directory" (line ~214); the Phase-1 proposal classifies the
  // slug as "public_record" (an OFFICIAL_CLASS). Mapped to public_record per the
  // proposal — confirm the intended class for the slug vs the free-text label.
  opencorporates_search: "public_record",
  // GLEIF LEI registry — official corporate registry, same class as the other
  // company-registry sources. (LEIs are issued by accredited LOUs.)
  gleif_lei_search: "public_record",
  // passive / historical — observe the past, not the live asset
  urlscan_search: "infra_passive",
  wayback_snapshots: "infra_passive",
  wayback_cdx_search: "archive",
  archive_url: "infra_passive",
  passive_dns: "infra_passive",
  gravatar_profile: "social_profile_passive",
  gravatar_lookup: "social_profile_passive",
  // phone / people-search aggregators — low-trust aggregators, treat as passive social
  bosint_phone_lookup: "social_profile_passive",
  bosint_email_lookup: "breach",
  "usphonesearch.net": "social_profile_passive",
  "nomorobo.com": "social_profile_passive",
  // memory / agent
  memory_recall: "unknown",
};

/** Wrapper labels that carry no provenance of their own — the real sources are
 *  in `metadata.sources`. Classifying these as `unknown` is the bug that capped
 *  "Multiple sources" / "Investigation" artifacts at 50. */
const WRAPPER_LABEL_RE =
  /^(multiple sources?|several sources?|various(?: sources?)?|combined(?: sources?)?|investigation|analysis|synthesis|aggregated|cross-?referenced?)$/i;

export function isWrapperLabel(label: string | null | undefined): boolean {
  return WRAPPER_LABEL_RE.test((label ?? "").trim());
}

/** Lowercase, expand `&`→` and `, drop parens, collapse whitespace. */
export function normalizeSourceLabel(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Split a mixed source string into provider parts. Excludes `&` so "D&B" stays
// intact; splits on `/ | , ;`, the word "and", and `+`.
const MIXED_SOURCE_SPLIT_RE = /\s*(?:\/|\||,|;|\band\b|\+)\s*/i;

export function splitSourceLabels(label: string | null | undefined): string[] {
  const normalized = (label ?? "").trim();
  if (!normalized) return [];
  if (isWrapperLabel(normalized)) return [];
  return normalized
    .split(MIXED_SOURCE_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Classify ONE source token (internal slug or a single free-text label) into a
 *  single SourceClass. Returns "unknown" only when nothing matches.
 *
 *  Order is load-bearing:
 *   1. internal-slug fast path (TOOL_CLASS, split-infra) — post-#56 contract;
 *   2. shared-host / reverse-IP free-text → infra_shared_host (#56 guard);
 *   3. #56's court / news free-text regexes (keep their exact behavior);
 *   4. #16's richer free-text provider regexes (gov/registry/directory/etc.);
 *   5. #16's coarse infra free-text → "infra" (only for free-text, never slugs). */
export function classifySource(toolOrSource: string | null | undefined): SourceClass {
  if (!toolOrSource) return "unknown";
  // Internal-slug fast path: strip a trailing parenthetical qualifier
  // ("socialfetch_lookup (instagram)" → "socialfetch_lookup") so the slug lookup
  // still hits — without this, breach/passive-social hits leaked to unknown.
  const slug = toolOrSource.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (TOOL_CLASS[slug]) return TOOL_CLASS[slug];

  // Reverse-IP / shared-host lookups describe co-tenants on a shared/CDN IP —
  // they never prove ownership and must not corroborate identity (#56). Matched
  // on the raw-ish slug form so "hackertarget/reverseiplookup" is caught.
  if (/reverse[\s._-]?ip|reverseiplookup|shared[\s._-]?host|co[\s._-]?hosted/.test(slug)) {
    return "infra_shared_host";
  }

  // Free-text provider-label path.
  const s = normalizeSourceLabel(toolOrSource);

  // ── #56's court / news free-text (preserve exact behavior + tests) ──
  // pacer_docket → court_record; nytimes_article → news; etc.
  if (/court|docket|legal_record|justice|cdc|cdcr|bop|pacer/.test(slug)) return "court_record";

  // Government / official public records (highest authority) — #16.
  if (/\b(secretary of state|sec of state|ca sos|cal sos|bizfile|business entity search|business search|statement of information)\b/.test(s)) {
    return "government_business_registry";
  }
  if (/\bbusiness licen[cs]e\b|\b(city|county|municipal) licen[cs]e\b/.test(s)) {
    return "government_business_license";
  }
  if (/\b(county assessor|assessor(?:'s)? office|parcel|apn|county recorder|recorder(?:'s)? office|grant deed|quitclaim|register of deeds|deed of trust)\b/.test(s)) {
    return "government_property_record";
  }
  if (/\b(court|docket|pacer|justice|cdc|cdcr|\bbop\b|case no|superior court|county clerk)\b/.test(s)) {
    return "court_record";
  }

  // Directories / listings / profiles — #16.
  if (/\b(dnb|d b|dun and bradstreet|d and b|dun bradstreet|d b credibility|business directory|yellow ?pages|manta|bizapedia|opencorporates|corporationwiki)\b/.test(s)) {
    return "business_directory";
  }
  if (/\b(redfin|zillow|realtor\.?com|realtor|trulia|homes\.?com|movoto|compass\.com|loopnet|homesnap)\b/.test(s)) {
    return "real_estate_listing";
  }
  if (/\b(property records? search|property record|property records|real property|tax assessor|propertyshark|property data|property report)\b/.test(s)) {
    return "property_aggregator";
  }
  if (/\b(linkedin|xing|zoominfo|rocketreach|apollo\.io)\b/.test(s)) {
    return "professional_profile";
  }
  if (/\b(houzz|yelp|angi|angie'?s list|google reviews?|trustpilot|bbb|better business bureau)\b/.test(s)) {
    return "social_review";
  }

  // Public-record aggregators (people-search / OSINT property+person providers) — #16.
  if (/\b(oathnet|whitepages|thatsthem|fastpeoplesearch|truepeoplesearch|beenverified|radaris|spokeo|intelius|peoplefinders|public records?)\b/.test(s)) {
    return "public_record";
  }

  // Infra free-text (whois/dns/cert/asn/reputation) — #16 coarse "infra".
  // NOTE: only reachable for FREE-TEXT labels; the split-infra slugs above
  // already short-circuited via TOOL_CLASS, so #56's per-sub-class behavior is
  // never weakened by these.
  if (/\b(whois|registrar|registration)\b/.test(s)) return "infra";
  if (/\b(dns|mx record|txt record|a record|aaaa record|cname|name ?server)\b/.test(s)) return "infra";
  if (/\b(certificate transparency|crt\.sh|ssl cert|tls cert|x509)\b/.test(s)) return "infra";
  if (/\b(shodan|censys|asn|reverse dns|rdns|ipinfo|ip intel|geolocation)\b/.test(s)) return "infra";
  if (/\b(virustotal|urlscan|malwarebytes|safe browsing|reputation|phishing|malware)\b/.test(s)) return "infra";

  // Breach / leak free-text — #16.
  if (/\b(breach|hibp|have i been pwned|leak|paste|combolist|stealer log|dehashed)\b/.test(s)) return "breach";

  // Archive — #16.
  if (/\b(wayback|web archive|archive\.org|archive\.is|archive\.today|cachedview)\b/.test(s)) return "archive";

  // News / media — #16 (superset of #56's `/news|times|.../`).
  if (/\b(news|times|herald|tribune|press|gazette|magazine|article|reuters|associated press|\bap\b)\b/.test(s)) return "news";

  // Generic web search (discovery, not verification) — #16.
  if (/\b(web search|google(?: search)?|bing|duckduckgo|ddg|search engine|exa|minimax|gemini(?: deep dork)?|deep dork|serp)\b/.test(s)) {
    return "web_search";
  }

  return "unknown";
}

/** Classify a source string into ALL of its source classes. Splits mixed labels
 *  ("D&B / Redfin" → ["business_directory","real_estate_listing"]) and returns
 *  [] for wrapper labels (so the caller falls back to metadata.sources). */
export function classifySourceLabel(label: string | null | undefined): SourceClass[] {
  if (!label || !label.trim()) return [];
  if (isWrapperLabel(label)) return [];
  const parts = splitSourceLabels(label);
  const tokens = parts.length ? parts : [label.trim()];
  const out = new Set<SourceClass>();
  for (const t of tokens) out.add(classifySource(t));
  const known = [...out].filter((c) => c !== "unknown");
  if (known.length) return known;
  // Splitting may have broken a multi-word provider ("Dun and Bradstreet" →
  // ["Dun","Bradstreet"]). Try the whole label once before giving up.
  const whole = classifySource(label);
  return whole !== "unknown" ? [whole] : ["unknown"];
}

/** Authoritative classification for a recorded artifact: top-level `source`
 *  plus `metadata.sources`. Wrapper labels ("Multiple sources") contribute
 *  nothing themselves; their members come from metadata.sources. */
export function classifySourceInput(input: {
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}): SourceClass[] {
  const out = new Set<SourceClass>();
  for (const c of classifySourceLabel(input.source)) out.add(c);
  const metaSources = input.metadata?.sources;
  if (Array.isArray(metaSources)) {
    for (const ms of metaSources) {
      if (typeof ms === "string") {
        for (const c of classifySourceLabel(ms)) out.add(c);
      }
    }
  }
  const known = [...out].filter((c) => c !== "unknown");
  if (known.length) return known;
  return out.size ? [...out] : ["unknown"];
}

// Infrastructure sub-classes (post-#56). These count as independent
// perspectives when corroborating an INFRASTRUCTURE claim (domain exists,
// resolves, has footprint) — but never when corroborating identity/ownership.
const INFRA_SUBCLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "infra_registry",
  "infra_dns",
  "infra_scan",
  "infra_reputation",
  "infra_passive",
  "infra_shared_host",
  "infra",
]);

export function isInfraClass(c: SourceClass): boolean {
  return INFRA_SUBCLASSES.has(c);
}

/** Classes that do NOT, by themselves, constitute independent corroboration of
 *  an identity/association claim (discovery + low-trust aggregators + single
 *  AI summaries). Used by the status layer to count *independent* source
 *  classes. (infra_shared_host is also non-corroborating — see #56.) */
export const NON_CORROBORATING_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "unknown",
  "web_search",
  "ai_summary",
  "username_sweep",
  "social_profile_passive",
  "social_review",
  "infra_shared_host",
]);

/** Count distinct source classes that can independently corroborate. */
export function countIndependentClasses(classes: readonly SourceClass[]): number {
  return new Set(classes.filter((c) => !NON_CORROBORATING_CLASSES.has(c))).size;
}

/** Classes that are official/government public records (highest source quality). */
export const OFFICIAL_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "government_property_record",
  "government_business_registry",
  "government_business_license",
  "court_record",
  "public_record",
  "official_profile_match",
]);

export function hasOfficialClass(classes: readonly SourceClass[]): boolean {
  return classes.some((c) => OFFICIAL_CLASSES.has(c));
}
