const DISPLAY_NAMES: Record<string, string> = {
  // Orchestration
  list_tools: "Loading tool catalog",
  triage_seed: "Triaging seed intelligence",

  // Breach & exposure
  breach_check: "Scanning breach databases",
  hibp_lookup: "Checking known breach records",
  leakcheck_lookup: "Querying leaked credential indexes",
  oathnet_lookup: "Deep-scanning credential exposures",
  stolentax_footprint: "Mapping digital footprint",
  serus_darkweb_scan: "Probing darkweb exposure",

  // Email intelligence
  emailrep: "Assessing email reputation",
  gravatar_profile: "Pulling linked avatar profile",
  hunter_domain_search: "Enumerating domain contacts",
  hunter_email_finder: "Locating associated emails",
  hunter_email_verifier: "Verifying email deliverability",
  hunter_combined: "Running combined email recon",
  bosint_email_lookup: "Cross-referencing email intelligence",
  bosint_phone_lookup: "Cross-referencing phone intelligence",
  deepfind_reverse_email: "Reverse-searching email ownership",
  deepfind_disposable_email: "Checking disposable email status",
  intelbase_email_lookup: "Querying intelligence archives",

  // Social & identity
  socialfetch_lookup: "Profiling social media presence",
  cordcat_discord_lookup: "Searching Discord connections",
  username_sweep: "Sweeping platforms for username",
  username_search: "Searching username variations",
  github_user: "Pulling developer profile",
  github_code_search: "Searching public code repositories",
  reddit_user: "Analyzing Reddit activity",
  hackernews_user: "Checking Hacker News footprint",
  deepfind_profile_analyzer: "Analyzing social profile depth",
  deepfind_telegram_channel: "Scanning Telegram channels",
  deepfind_telegram_search: "Searching Telegram content",

  // Infrastructure
  whois_lookup: "Querying domain registration",
  crtsh_subdomains: "Enumerating SSL certificates",
  dns_records: "Resolving DNS records",
  shodan_internetdb: "Fingerprinting exposed services",
  ip_intel: "Gathering IP intelligence",
  ipgeolocation_lookup: "Geolocating IP address",
  http_fingerprint: "Fingerprinting web server",
  virustotal_lookup: "Scanning threat intelligence",
  hackertarget: "Running network reconnaissance",
  urlscan_search: "Scanning URL threat history",
  wayback_snapshots: "Searching archived snapshots",
  archive_url: "Archiving source for evidence",
  deepfind_ssl_inspect: "Inspecting SSL certificate chain",
  deepfind_tech_stack: "Detecting technology stack",
  deepfind_url_unshorten: "Unshortening redirect chain",
  deepfind_mac_lookup: "Identifying hardware vendor",
  deepfind_dark_web_link: "Checking dark web references",

  // Search & enrichment
  google_dorks: "Building targeted search queries",
  dork_harvest: "Harvesting search results",
  gemini_deep_dork: "Running AI-powered deep search",
  exa_search: "Searching semantic web index",
  exa_find_similar: "Finding related sources",
  exa_get_contents: "Extracting page contents",
  jina_reader_scrape: "Reading source document",
  minimax_web_search: "Searching the open web",
  minimax_extract: "Extracting structured data",
  minimax_correlate: "Correlating data points",
  minimax_plan_pivots: "Planning next pivots",

  // Crypto
  crypto_wallet: "Tracing wallet activity",

  // Special lookups
  deepfind_ransomware_exposure: "Checking ransomware exposure",
  deepfind_vin_lookup: "Running vehicle identification",
  deepfind_aircraft_lookup: "Searching aircraft registry",
  deepfind_vessel_lookup: "Searching vessel registry",
  osint_navigator_query: "Querying OSINT navigator",
  osint_navigator_search: "Searching OSINT sources",
  synapsint_lookup: "Searching aggregated intelligence",

  // Recording & analysis
  record_artifacts: "Recording investigation findings",
  record_artifact: "Logging artifact to case file",
  record_evidence: "Securing evidence to chain",
  record_finding: "Documenting key finding",
  memory_recall: "Recalling prior intelligence",
  memory_save: "Storing intelligence for future use",
  coverage_audit: "Auditing investigation coverage",
  detect_contradictions: "Checking for contradictions",
  tool_audit: "Reviewing tool execution quality",
};

export function toolDisplayName(toolName: string): string {
  return DISPLAY_NAMES[toolName] ?? formatFallback(toolName);
}

function formatFallback(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
