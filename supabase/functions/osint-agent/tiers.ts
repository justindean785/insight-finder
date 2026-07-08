// Tier classification for OSINT tools.
// Tier-A: identity / attribution heavyweights. High signal.
// Tier-B: infra / verification. Solid, narrow.
// Tier-C: discovery only — never the SOLE source of a high-confidence finding.

export const TIER_A: ReadonlyArray<string> = [
  "oathnet_lookup",
  "osintnova_lookup",
  "osintnova_email_lookup",
  "osintnova_phone_lookup",
  "deepfind_reverse_email",
  "deepfind_disposable_email",
  "deepfind_telegram_channel",
  "deepfind_telegram_search",
  "leakcheck_lookup",
  "hibp_lookup",
  "socialfetch_lookup",
  "exa_search",
  "exa_get_contents",
  "exa_find_similar",
  "hunter_combined",
  "hunter_email_verifier",
  "hunter_domain_search",
  "gemini_deep_dork",
  "breach_check",
];

export const TIER_B: ReadonlyArray<string> = [
  "virustotal_lookup",
  "cordcat_lookup",
  "parallax_lookup",
  "urlscan_search",
  "wayback_snapshots",
  "archive_url",
  "crtsh_subdomains",
  "dns_records",
  "whois_lookup",
  "ip_intel",
  "ipgeolocation_lookup",
  "shodan_internetdb",
  "hackertarget",
  "http_fingerprint",
  "deepfind_ssl_inspect",
  "deepfind_tech_stack",
  "gravatar_profile",
  // Indicia — broker/lead tier (reliability ~65). New, unproven aggregator whose
  // data is data-broker + breach-dump; kept below the established TIER_A breach
  // sources. Paired with the `breach` source-class (CLASS_CAP 60, NEVER_HIGH) so a
  // single Indicia hit can never reach Confirmed.
  "indicia_email",
  "indicia_phone",
  "indicia_person",
  "indicia_address",
  "indicia_web_dbs",
  "indicia_hudsonrock",
];

export const TIER_C: ReadonlyArray<string> = [
  "google_dorks",
  "dork_harvest",
  "username_sweep",
  "github_user",
  "github_code_search",
  "reddit_user",
  "hackernews_user",
  "jina_reader_scrape",
  "minimax_web_search",
];

export type Tier = "A" | "B" | "C" | "U";

const A = new Set(TIER_A);
const B = new Set(TIER_B);
const C = new Set(TIER_C);

export function tierOf(toolName: string): Tier {
  if (A.has(toolName)) return "A";
  if (B.has(toolName)) return "B";
  if (C.has(toolName)) return "C";
  return "U";
}

// Baseline source reliability per tier — used by the confidence engine.
export const TIER_SOURCE_RELIABILITY: Record<Tier, number> = {
  A: 80,
  B: 65,
  C: 40,
  U: 50,
};

// Hard cap on case-level confidence when only Tier-C evidence exists.
export const TIER_C_ONLY_CONFIDENCE_CAP = 50;
