// Coverage audit. After the orchestrator drafts a report, this scores
// 12 investigative categories as done|partial|skipped|n/a so the agent
// cannot claim "investigation complete" while strong APIs remain unused.

import { playbookFor, type SeedType } from "./playbooks.ts";
import { tierOf } from "./tiers.ts";

export type CoverageStatus = "done" | "partial" | "skipped" | "n/a";

export interface CoverageReport {
  seedType: string;
  complete: boolean;
  categories: Record<string, { status: CoverageStatus; reason: string }>;
  missingOpportunities: string[];
}

const CATEGORY_TOOLS: Record<string, string[]> = {
  identity: ["oathnet_lookup", "osintnova_lookup", "deepfind_reverse_email", "intelbase_email_lookup", "socialfetch_lookup", "exa_search"],
  email: ["breach_check", "leakcheck_lookup", "hibp_lookup", "intelbase_email_lookup", "hunter_email_verifier", "emailrep", "gravatar_profile"],
  username: ["socialfetch_lookup", "username_sweep", "github_user", "stolentax_footprint", "deepfind_reverse_email"],
  phone: ["oathnet_lookup", "osintnova_phone_lookup", "leakcheck_lookup"],
  domain: ["whois_lookup", "dns_records", "crtsh_subdomains", "hunter_domain_search", "deepfind_ssl_inspect"],
  infrastructure: ["ip_intel", "ipgeolocation_lookup", "shodan_internetdb", "virustotal_lookup", "urlscan_search", "http_fingerprint"],
  social: ["socialfetch_lookup", "github_user", "reddit_user", "hackernews_user", "exa_find_similar"],
  breach: ["breach_check", "leakcheck_lookup", "hibp_lookup", "oathnet_lookup", "intelbase_email_lookup", "deepfind_ransomware_exposure"],
  location: ["ipgeolocation_lookup", "oathnet_lookup", "exa_search"],
  employment: ["hunter_domain_search", "exa_search", "gemini_deep_dork"],
  relationships: ["socialfetch_lookup", "exa_find_similar", "gemini_deep_dork"],
  timeline: ["wayback_snapshots", "archive_url"],
  // Property / public-record + business-registry pivots for address/business
  // cases — these must be attempted before such an investigation is "complete"
  // (the 1677 Iroquois Rd gap: assessor/recorder/SOS/license never ran). The
  // runtime has no dedicated county-assessor tool, so these are satisfied by
  // OATHNET + targeted property/registry dorks via the search tools.
  property: ["oathnet_lookup", "minimax_web_search", "exa_search", "gemini_deep_dork", "google_dorks", "jina_reader_scrape"],
  business_registry: ["minimax_web_search", "exa_search", "gemini_deep_dork", "google_dorks", "jina_reader_scrape"],
};

export function auditCoverage(
  seedType: string,
  toolsCalled: string[],          // names of tools actually invoked
  toolsAvailable: Set<string>,    // names of tools whose API keys are configured
): CoverageReport {
  const pb = playbookFor(seedType as SeedType);
  const calledSet = new Set(toolsCalled);
  const required = new Set(pb.coverage);
  const categories: CoverageReport["categories"] = {};
  const missing: string[] = [];

  for (const [cat, tools] of Object.entries(CATEGORY_TOOLS)) {
    const isRequired = required.has(cat);
    const available = tools.filter((t) => toolsAvailable.has(t));
    const called = tools.filter((t) => calledSet.has(t));
    if (available.length === 0) {
      categories[cat] = { status: "n/a", reason: "no configured tools for this category" };
      continue;
    }
    let status: CoverageStatus;
    let reason: string;
    if (called.length === 0) {
      status = isRequired ? "skipped" : "n/a";
      reason = isRequired ? `required for ${seedType} but no tools ran` : "not required for this seed";
    } else if (called.length >= Math.min(2, available.length)) {
      status = "done";
      reason = `ran ${called.length}/${available.length} (${called.join(", ")})`;
    } else {
      status = "partial";
      reason = `only ${called.join(", ")} — other available: ${available.filter((t) => !calledSet.has(t)).join(", ")}`;
    }
    categories[cat] = { status, reason };

    if (isRequired && status === "skipped") {
      for (const t of available) {
        if (tierOf(t) !== "C") missing.push(`${cat}: ${t}`);
      }
    }
    if (isRequired && status === "partial") {
      for (const t of available) {
        if (!calledSet.has(t) && tierOf(t) !== "C") missing.push(`${cat}: ${t}`);
      }
    }
  }

  const complete = Object.entries(categories).every(([cat, v]) => {
    if (!required.has(cat)) return true;
    return v.status === "done" || v.status === "n/a";
  });

  return {
    seedType,
    complete,
    categories,
    missingOpportunities: missing,
  };
}
