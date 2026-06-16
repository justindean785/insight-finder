// Strict artifact type taxonomy. Replaces the loose freeform `kind` list.
// The orchestrator MUST pick a value from STRICT_KINDS — `other` is rejected.

export const STRICT_KINDS = [
  "person",
  "alias",
  "username",
  "social_profile",
  "email",
  "phone",
  "address",
  "domain",
  "subdomain",
  "ip",
  "organization",
  "employer",
  "law_enforcement_unit",
  "court_case",
  "criminal_case_event",
  "media_report",
  "music_profile",
  "account_id",
  "hash",
  "crypto_wallet",
  "breach_exposure",
  "threat_reputation",
  "reputation_signal",
  "contradiction",
  "weak_lead",
  "excluded_collision",
  // legacy compat — still accepted but discouraged
  "name",
  "social",
  "avatar",
  "case",
  "legal_record",
  "infrastructure",
  "event",
] as const;

export type StrictKind = typeof STRICT_KINDS[number];

const STRICT_SET = new Set<string>(STRICT_KINDS);

export function isStrictKind(k: string): k is StrictKind {
  return STRICT_SET.has(k);
}

/** Pattern-based inference: bump obvious mis-typed kinds into the right slot. */
export function inferKind(rawKind: string, value: string): { kind: string; reclassified_from?: string } {
  const v = value.trim();
  const k = (rawKind || "").toLowerCase();
  if (/^0x[a-fA-F0-9]{40}$/.test(v) || /^[13][a-km-zA-HJ-NP-Z0-9]{25,34}$/.test(v) || /^bc1[a-z0-9]{20,80}$/.test(v)) {
    return k === "crypto_wallet" ? { kind: "crypto_wallet" } : { kind: "crypto_wallet", reclassified_from: rawKind };
  }
  if (/\b(LAPD|NYPD|FBI|DEA|ATF|sheriff('s)? office|police dept|police department|robbery-?homicide)\b/i.test(v)) {
    return { kind: "law_enforcement_unit", reclassified_from: rawKind };
  }
  if (/^(People|United States|State|Commonwealth|In re)\s+v\.?\s+/i.test(v) || /\b(case no\.?|docket|b\d{6})\b/i.test(v)) {
    return { kind: "court_case", reclassified_from: rawKind };
  }
  if (/\b(compassionate release|sentencing|parole|arraign(ment|ed)|indict(ment|ed)|verdict|conviction|charged with)\b/i.test(v)) {
    return { kind: "criminal_case_event", reclassified_from: rawKind };
  }
  if (/spotify\.com\/artist|music\.apple\.com\/artist|soundcloud\.com|tidal\.com\/browse\/artist/i.test(v)) {
    return { kind: "music_profile", reclassified_from: rawKind };
  }
  // A "username" with whitespace is never a valid handle — it's almost always a
  // person name the model mis-kinded. Reclassify instead of hard-rejecting at
  // validation (the 2026-06-13 trace lost 3 record_artifact calls to
  // "username must not contain whitespace").
  if (k === "username" && /\s/.test(v)) {
    return { kind: "name", reclassified_from: "username" };
  }
  if (k === "other") return { kind: "weak_lead", reclassified_from: "other" };
  return { kind: rawKind };
}

/** Source-class for confidence caps. */
export type SourceClass =
  | "breach"
  | "username_sweep"
  | "social_profile_passive"
  | "social_profile_active"
  | "news"
  | "court_record"
  | "official_profile_match"
  | "independent_public"
  | "ai_summary"
  | "infra"
  | "infra_registry"
  | "infra_dns"
  | "infra_scan"
  | "infra_reputation"
  | "infra_passive"
  | "infra_shared_host"
  | "unknown";

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
  // infra — split into sub-classes so cross-tool corroboration counts
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
  // passive / historical — observe the past, not the live asset
  urlscan_search: "infra_passive",
  wayback_snapshots: "infra_passive",
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

export function classifySource(toolOrSource: string | null | undefined): SourceClass {
  if (!toolOrSource) return "unknown";
  // Normalize: lowercase, strip a trailing parenthetical qualifier
  // (e.g. "socialfetch_lookup (instagram)" → "socialfetch_lookup",
  // "bosint_email_lookup (drizly.com breach)" → "bosint_email_lookup").
  // Without this, the parenthetical defeats the TOOL_CLASS lookup and the
  // artifact silently falls through to "unknown" (cap 50) — a loophole that
  // lets passive-social and breach hits score higher than their class allows.
  const s = toolOrSource.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (TOOL_CLASS[s]) return TOOL_CLASS[s];
  // Reverse-IP / shared-host lookups describe co-tenants on a shared/CDN IP —
  // they never prove ownership and must not corroborate identity.
  if (/reverse[\s._-]?ip|reverseiplookup|shared[\s._-]?host|co[\s._-]?hosted/.test(s)) return "infra_shared_host";
  if (/court|docket|legal_record|justice|cdc|cdcr|bop|pacer/.test(s)) return "court_record";
  if (/news|times|herald|tribune|press|magazine|article/.test(s)) return "news";
  return "unknown";
}
