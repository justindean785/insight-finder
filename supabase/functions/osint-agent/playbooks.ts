// Per-seed-type investigation playbooks. The Lead Investigator (orchestrator)
// reads the playbook for the detected seed and is required to attempt the
// `required` tools (or explicitly record why each was skipped) before any
// final findings are written.
//
// `pivots` maps an artifact kind discovered mid-run to a list of tools that
// should be queued automatically. The pivot engine ranks/queues these.

export type SeedType =
  | "email"
  | "username"
  | "phone"
  | "domain"
  | "ip"
  | "name"
  | "company"
  | "address"
  | "url"
  | "crypto_wallet"
  | "hash"
  | "unknown";

export interface Playbook {
  required: string[];      // Tier-A/B tools that MUST be attempted.
  recommended: string[];   // Strongly suggested follow-ups.
  coverage: string[];      // Coverage categories that must end as done|n/a.
  pivots: Record<string, string[]>; // artifactKind → tools to queue.
}

const EMAIL_PIVOTS: Record<string, string[]> = {
  email: ["rapidapi_breach_search", "breach_check", "deepfind_reverse_email", "hibp_lookup", "leakcheck_lookup", "oathnet_lookup", "gravatar_profile", "hunter_email_verifier", "deepfind_disposable_email"],
  domain: ["whois_lookup", "dns_records", "virustotal_lookup", "urlscan_search", "crtsh_subdomains", "hunter_domain_search", "deepfind_ssl_inspect"],
  username: ["socialfetch_lookup", "github_user", "reddit_user", "hackernews_user", "username_sweep", "stolentax_footprint", "deepfind_reverse_email"],
  phone: ["oathnet_lookup", "osintnova_phone_lookup", "leakcheck_lookup"],
  ip: ["ip_intel", "ipgeolocation_lookup", "shodan_internetdb", "virustotal_lookup", "urlscan_search"],
};

export const PLAYBOOKS: Record<SeedType, Playbook> = {
  email: {
    // rapidapi_breach_search is the PRIMARY/FIRST breach call. breach_check is the
    // fallback when RAPIDAPI_KEY is absent. leakcheck_lookup + oathnet_lookup are
    // CORROBORATION-ONLY (scarce 200/day & 100/day budgets) — demoted to recommended
    // so they are never the opening breach move. emailrep + gravatar_profile (~85%
    // no-value in prod) are likewise demoted out of the required fan-out.
    required: ["rapidapi_breach_search", "breach_check", "hibp_lookup", "deepfind_reverse_email", "hunter_email_verifier"],
    recommended: ["leakcheck_lookup", "oathnet_lookup", "emailrep", "gravatar_profile", "stolentax_footprint", "socialfetch_lookup", "gemini_deep_dork", "exa_search", "google_dorks", "dork_harvest"],
    coverage: ["identity", "email", "username", "breach", "social"],
    pivots: EMAIL_PIVOTS,
  },
  username: {
    required: ["socialfetch_lookup", "username_sweep", "github_user", "stolentax_footprint", "deepfind_reverse_email", "oathnet_lookup", "leakcheck_lookup", "breach_check"],
    recommended: ["reddit_user", "hackernews_user", "exa_search", "exa_find_similar", "gemini_deep_dork", "google_dorks"],
    coverage: ["identity", "username", "social", "breach"],
    pivots: EMAIL_PIVOTS,
  },
  phone: {
    required: ["oathnet_lookup", "osintnova_phone_lookup", "leakcheck_lookup", "breach_check"],
    recommended: ["deepfind_reverse_email", "gemini_deep_dork", "google_dorks"],
    coverage: ["identity", "phone", "breach", "location"],
    pivots: EMAIL_PIVOTS,
  },
  domain: {
    required: ["whois_lookup", "dns_records", "crtsh_subdomains", "virustotal_lookup", "urlscan_search", "wayback_snapshots", "hunter_domain_search", "http_fingerprint", "oathnet_lookup", "leakcheck_lookup"],
    recommended: ["shodan_internetdb", "deepfind_ssl_inspect", "deepfind_tech_stack", "hackertarget", "synapsint_lookup", "exa_search"],
    coverage: ["domain", "infrastructure", "email"],
    pivots: EMAIL_PIVOTS,
  },
  ip: {
    required: ["ip_intel", "ipgeolocation_lookup", "shodan_internetdb", "virustotal_lookup", "urlscan_search", "oathnet_lookup"],
    recommended: ["synapsint_lookup", "hackertarget"],
    coverage: ["infrastructure", "location"],
    pivots: EMAIL_PIVOTS,
  },
  name: {
    required: ["exa_search", "minimax_web_search", "oathnet_lookup", "google_dorks", "dork_harvest"],
    recommended: ["gemini_deep_dork", "exa_find_similar", "socialfetch_lookup", "hunter_domain_search"],
    coverage: ["identity", "social", "location", "employment", "relationships"],
    pivots: EMAIL_PIVOTS,
  },
  company: {
    required: ["exa_search", "minimax_web_search", "oathnet_lookup", "gemini_deep_dork", "google_dorks", "hunter_domain_search", "whois_lookup"],
    recommended: ["dns_records", "crtsh_subdomains", "urlscan_search", "virustotal_lookup", "exa_find_similar", "dork_harvest"],
    // business_registry (Secretary of State / license) + property are REQUIRED
    // for completeness — a company at an address can't be "done" without them.
    coverage: ["identity", "business_registry", "property", "employment", "relationships", "domain"],
    pivots: EMAIL_PIVOTS,
  },
  address: {
    required: ["oathnet_lookup", "minimax_web_search", "exa_search", "gemini_deep_dork", "google_dorks", "jina_reader_scrape"],
    recommended: ["dork_harvest", "exa_get_contents", "hunter_domain_search"],
    // property + business_registry pivots (assessor/recorder/parcel, SOS/license)
    // gate completeness for an address/business investigation.
    coverage: ["property", "business_registry", "identity", "location", "relationships"],
    pivots: EMAIL_PIVOTS,
  },
  url: {
    required: ["urlscan_search", "virustotal_lookup", "http_fingerprint", "wayback_snapshots", "archive_url"],
    recommended: ["deepfind_ssl_inspect", "deepfind_tech_stack", "jina_reader_scrape", "exa_get_contents"],
    coverage: ["domain", "infrastructure"],
    pivots: EMAIL_PIVOTS,
  },
  crypto_wallet: {
    required: ["crypto_wallet", "exa_search", "google_dorks"],
    recommended: ["gemini_deep_dork", "dork_harvest"],
    coverage: ["identity", "relationships"],
    pivots: EMAIL_PIVOTS,
  },
  hash: {
    required: ["leakcheck_lookup", "google_dorks"],
    recommended: ["virustotal_lookup", "exa_search"],
    coverage: ["breach"],
    pivots: EMAIL_PIVOTS,
  },
  unknown: {
    required: ["exa_search", "google_dorks"],
    recommended: ["minimax_web_search", "gemini_deep_dork"],
    coverage: ["identity"],
    pivots: EMAIL_PIVOTS,
  },
};

export function playbookFor(seedType: string | null | undefined): Playbook {
  const raw = (seedType ?? "unknown").toLowerCase();
  const k = (raw === "person" ? "name" : raw) as SeedType;
  return PLAYBOOKS[k] ?? PLAYBOOKS.unknown;
}

// Human-readable summary the Lead Investigator embeds into its plan.
export function renderPlaybookForPrompt(seedType: string | null | undefined): string {
  const pb = playbookFor(seedType);
  const t = (seedType ?? "unknown").toUpperCase();
  const lines: string[] = [];
  lines.push(`## Playbook for seed type: ${t}`);
  lines.push(`Suggested Tier-A/B baseline tools (advisory, never a blocking gate):`);
  lines.push(`  ${pb.required.join(", ")}`);
  lines.push(`RECOMMENDED follow-ups:`);
  lines.push(`  ${pb.recommended.join(", ")}`);
  lines.push(`COVERAGE categories required for completeness:`);
  lines.push(`  ${pb.coverage.join(", ")}`);
  return lines.join("\n");
}
