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
  // infra
  whois_lookup: "infra",
  dns_records: "infra",
  crtsh_subdomains: "infra",
  ip_intel: "infra",
  ipgeolocation_lookup: "infra",
  shodan_internetdb: "infra",
  urlscan_search: "infra",
  http_fingerprint: "infra",
  hackertarget: "infra",
  virustotal_lookup: "infra",
  synapsint_lookup: "infra",
  hunter_domain_search: "infra",
  hunter_email_verifier: "infra",
  hunter_combined: "infra",
  emailrep: "infra",
  gravatar_profile: "social_profile_passive",
  // memory / agent
  memory_recall: "unknown",
};

/**
 * Source-class is keyed SOLELY on the canonical originating TOOL name (T-H4).
 *
 * Previously a free-text `source` string was regex-matched, so model prose like
 * "bx_on_x tweet, DOJ press release" inflated the class to `news`/`court_record`
 * even when the cited record was about a *different* person. We no longer infer
 * class from arbitrary prose: an unrecognized source is `unknown`. The only way
 * to reach the high-trust `court_record`/`news` classes is via a *verified URL*
 * whose host is a recognized court/news domain — see classifySourceWithUrl.
 */
export function classifySource(toolOrSource: string | null | undefined): SourceClass {
  if (!toolOrSource) return "unknown";
  const s = toolOrSource.toLowerCase().trim();
  if (TOOL_CLASS[s]) return TOOL_CLASS[s];
  return "unknown";
}

// Recognized court/government-record hosts and news hosts. Class is only granted
// when a *verified URL* (not model prose) resolves to one of these.
const COURT_HOST_RE =
  /(^|\.)(courtlistener\.com|pacer\.gov|justia\.com|justice\.gov|uscourts\.gov|bop\.gov|cdcr\.ca\.gov|law\.justia\.com)$/i;
const NEWS_HOST_RE =
  /(^|\.)(nytimes\.com|washingtonpost\.com|reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|theguardian\.com|wsj\.com|bloomberg\.com|npr\.org|cnn\.com|latimes\.com)$/i;

/**
 * Class a source given its canonical tool name AND, optionally, a verified URL.
 * Court_record / news are reachable ONLY through a verified URL whose host is a
 * recognized court/news domain — never through the free-text source string.
 */
export function classifySourceWithUrl(
  toolOrSource: string | null | undefined,
  verifiedUrl?: string | null,
): SourceClass {
  const base = classifySource(toolOrSource);
  if (base !== "unknown") return base;
  if (verifiedUrl) {
    let host = "";
    try {
      host = new URL(verifiedUrl).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (host) {
      if (COURT_HOST_RE.test(host)) return "court_record";
      if (NEWS_HOST_RE.test(host)) return "news";
    }
  }
  return base;
}
