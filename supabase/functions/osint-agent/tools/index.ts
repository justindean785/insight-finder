/**
 * tools/index.ts — Barrel that re-exports all tool definitions.
 * Import this to get the full tools registry.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";

// Meta tools
import { list_tools, triage_seed } from "./meta.ts";

// MiniMax reasoning
import { minimax_web_search, minimax_extract, minimax_correlate, minimax_plan_pivots } from "./minimax.ts";

// IntelBase
import { intelbase_email_lookup } from "./intelbase.ts";

// OSINT Navigator + OathNet
import { osint_navigator_query, osint_navigator_search, oathnet_lookup } from "./osint_navigator.ts";

// Serus darkweb scan
import { serus_darkweb_scan } from "./serus.ts";

// Social
import { socialfetch_lookup, cordcat_discord_lookup, username_sweep, username_search,
  github_user, github_code_search, reddit_user, hackernews_user,
  deepfind_profile_analyzer, deepfind_telegram_channel, deepfind_telegram_search } from "./social.ts";

// Email
import { gravatar_profile, hunter_domain_search, hunter_email_finder,
  hunter_email_verifier, hunter_combined, bosint_email_lookup, bosint_phone_lookup,
  deepfind_reverse_email, deepfind_disposable_email } from "./email.ts";

// Breach
import { breach_check, leakcheck_lookup, hibp_lookup } from "./breach.ts";

// Infrastructure
import { whois_lookup, crtsh_subdomains, dns_records, shodan_internetdb,
  ip_intel, ipgeolocation_lookup, http_fingerprint, virustotal_lookup,
  hackertarget, urlscan_search, wayback_snapshots, archive_url,
  deepfind_ssl_inspect, deepfind_tech_stack, deepfind_url_unshorten,
  deepfind_mac_lookup, deepfind_dark_web_link } from "./infrastructure.ts";

// Search
import { google_dorks, dork_harvest, gemini_deep_dork,
  exa_search, exa_find_similar, exa_get_contents,
  jina_reader_scrape, minimax_web_search as minimax_ws } from "./search.ts";

// Crypto
import { crypto_wallet } from "./crypto.ts";

// DeepFind special
import { deepfind_ransomware_exposure, deepfind_vin_lookup,
  deepfind_aircraft_lookup, deepfind_vessel_lookup } from "./deepfind_special.ts";

// Phase 1 free / no-required-key tools
import { ransomwarelive_lookup, wayback_cdx_search, crtsh_lookup,
  census_geocode, nominatim_geocode, hibp_pwned_passwords_kanon,
  gleif_lei_search, opencorporates_search, urlscanner_scan } from "./phase1_free.ts";

// Recording
import { record_artifacts, record_artifact, record_evidence } from "./recording.ts";

// Disabled
import { firecrawl_search, firecrawl_scrape, firecrawl_map } from "./disabled.ts";

// Assemble static tool registry
export const ALL_STATIC_TOOLS = {
  // Meta
  list_tools, triage_seed,
  // MiniMax
  minimax_web_search, minimax_extract, minimax_correlate, minimax_plan_pivots,
  // IntelBase
  intelbase_email_lookup,
  // Navigator + OathNet
  osint_navigator_query, osint_navigator_search, oathnet_lookup,
  // Serus
  serus_darkweb_scan,
  // Social
  socialfetch_lookup, cordcat_discord_lookup, username_sweep, username_search,
  github_user, github_code_search, reddit_user, hackernews_user,
  deepfind_profile_analyzer, deepfind_telegram_channel, deepfind_telegram_search,
  // Email
  gravatar_profile, hunter_domain_search, hunter_email_finder,
  hunter_email_verifier, hunter_combined, bosint_email_lookup, bosint_phone_lookup,
  deepfind_reverse_email, deepfind_disposable_email,
  // Breach
  breach_check, leakcheck_lookup, hibp_lookup,
  // Infrastructure
  whois_lookup, crtsh_subdomains, dns_records, shodan_internetdb,
  ip_intel, ipgeolocation_lookup, http_fingerprint, virustotal_lookup,
  hackertarget, urlscan_search, wayback_snapshots, archive_url,
  deepfind_ssl_inspect, deepfind_tech_stack, deepfind_url_unshorten,
  deepfind_mac_lookup, deepfind_dark_web_link,
  // Search
  google_dorks, dork_harvest, gemini_deep_dork,
  exa_search, exa_find_similar, exa_get_contents,
  jina_reader_scrape,
  // Crypto
  crypto_wallet,
  // DeepFind special
  deepfind_ransomware_exposure, deepfind_vin_lookup,
  deepfind_aircraft_lookup, deepfind_vessel_lookup,
  // Phase 1 free / no-required-key tools
  ransomwarelive_lookup, wayback_cdx_search, crtsh_lookup,
  census_geocode, nominatim_geocode, hibp_pwned_passwords_kanon,
  gleif_lei_search, opencorporates_search, urlscanner_scan,
  // Recording
  record_artifacts, record_artifact, record_evidence,
  // Disabled
  firecrawl_search, firecrawl_scrape, firecrawl_map,
};

// Re-export minimax_web_search from search under its original name  
// (it was imported as minimax_ws to avoid conflict with providers)
ALL_STATIC_TOOLS.minimax_web_search = ALL_STATIC_TOOLS.minimax_web_search ?? minimax_ws;

export default ALL_STATIC_TOOLS;
