// Estimated cost per tool call, in micro-USD (1e-6 USD).
// Numbers are rough — sourced from each provider's published per-call
// pricing or a conservative ceiling for unmetered/local tools. The point
// is to give the user an HONEST $-per-investigation figure in the sidebar
// rather than an opaque "credits" counter.
//
// Update these numbers when a plan/quota changes. Default for any tool
// not listed below is DEFAULT_TOOL_COST_MICRO_USD (a small floor cost
// covering the orchestrator LLM round-trip that drove the call).

export const DEFAULT_TOOL_COST_MICRO_USD = 200; // $0.0002 per orchestrator step

// Cost in micro-USD per successful (non-cached) call.
export const TOOL_COSTS_MICRO_USD: Record<string, number> = {
  // ---- Free / local tools ----
  list_tools: 0,
  google_dorks: 0,
  username_sweep: 0,
  username_search: 0,   // deprecated alias of username_sweep — same edge-native sweep, keep at 0 so the alias never bills the default floor
  http_fingerprint: 0,
  dns_records: 50,
  wayback_snapshots: 0,
  reddit_user: 0,
  github_code_search: 0, // unauth — rate-limited but free
  shodan_internetdb: 0,  // free tier endpoint

  // ---- Phase 1 free / no-required-key tools ----
  ransomwarelive_lookup: 0, // api.ransomware.live — free, unauth
  wayback_cdx_search: 0,    // web.archive.org CDX — free, unauth
  crtsh_lookup: 0,          // crt.sh — free, unauth
  census_geocode: 0,        // US Census geocoder — free, unauth
  nominatim_geocode: 0,     // OSM Nominatim — free, unauth (1 req/sec policy)
  hibp_pwned_passwords_kanon: 0, // pwnedpasswords range API — free, no key
  gleif_lei_search: 0,           // api.gleif.org LEI registry — free, no key
  opencorporates_search: 50,     // registry search; now key-required (keyless 401s)

  // ---- URLScanner.online (private URL scanner — combined DNS/SSL/HTTP/WHOIS/threats/AI) ----
  // Solo plan 100/day; treat each sync scan as ~$0.02 (peer of virustotal_lookup
  // which bundles similar reputation+modules into one call).
  urlscanner_scan: 2000,

  // ---- Triage + smart reasoning (LLM costs) ----
  triage_seed: 800,           // 4 sub-tool calls bundled
  minimax_correlate: 4000,    // smart-tier LLM
  minimax_plan_pivots: 4000,  // smart-tier LLM
  minimax_extract: 1500,
  // Perplexity Sonar estimate: ~$0.001/call
  minimax_web_search: 1000,
  memory_recall: 200,
  memory_save: 200,

  // ---- Breach / leak sources ----
  rapidapi_breach_search: 1250, // RapidAPI Email Breach Search — ~8000/mo plan
  rapidapi_all_breaches: 1000,  // RapidAPI corpus catalog (reference, same plan)
  breach_check: 3000,         // 3 stolen.tax calls in parallel
  leakcheck_lookup: 5000,     // 200/day → ~$0.005/call equiv
  hibp_lookup: 3000,          // ~$3.95/mo Pwned 1 plan, ~1300 req/mo → ~$0.003
  oathnet_lookup: 10000,      // 500/day POOLED cap (all oathnet_* share it), expensive — reserve
  // OathNet v2 expansion — all draw the same 500/day pool. Search-class calls match
  // oathnet_lookup ($0.01); manifest/file reads + autocomplete + scanner-mgmt are cheaper
  // reads; victim_archive never hits the API (reference only). None fall to the default.
  oathnet_stealer_search: 10000,   // pooled search-class (stealer credentials)
  oathnet_victims_search: 10000,   // pooled search-class (victim manifests)
  oathnet_subdomains: 10000,       // pooled search-class (v2 stealer subdomain)
  oathnet_victim_manifest: 500,    // single-log manifest read
  oathnet_victim_file: 500,        // single-file read (redacted)
  oathnet_victim_archive: 200,     // reference only — never downloads bytes
  oathnet_breach_dbnames: 200,     // db-name autocomplete helper
  oathnet_ai_filter: 1000,         // NL→structured filter creation
  oathnet_scanner: 500,            // scanner quota/list/create management
  deepfind_reverse_email: 2000,
  deepfind_telegram_channel: 2000,
  // Serus darkweb scan: serus_core charges 0.25 credits/scan. No public USD
  // rate, so we use a conservative ~$0.01/credit estimate (in line with peer
  // darkweb/breach tools like oathnet $0.01, leakcheck $0.005). Explicit on
  // purpose — a darkweb scan must never fall through to the $0.0002 default.
  serus_darkweb_scan: 2500,
  gravatar_profile: 0,

  // ---- OSINTNova / Bosint (1000/day quota, ~$2/mo plan share) ----
  bosint_email_lookup: 2000,

  // ---- Indicia (api.indicia.app) — token-metered, ~$0.002/token estimate.
  // Explicit (never the $0.0002 default). hudsonrock is free (0 tokens);
  // web-dbs spans 1-2 tokens depending on services selected.
  indicia_email: 2000,
  indicia_phone: 2000,
  indicia_person: 2000,
  indicia_address: 2000,
  indicia_web_dbs: 3000,
  indicia_hudsonrock: 0,

  // ---- Hunter.io ----
  hunter_domain_search: 4000,
  hunter_email_finder: 4000,
  hunter_email_verifier: 1000,
  hunter_combined: 5000,

  // ---- Exa ----
  // Real billing observed: $0.005 keyword, $0.007 neural search, +$0.001
  // per result when contents are requested. We use the typical case.
  exa_search: 8000,           // ~$0.008/search w/ contents
  exa_find_similar: 8000,
  exa_get_contents: 4000,     // ~$0.001/url, batched up to 10

  // ---- Jina Reader (free tier r.jina.ai — 20 req/min unauth, much higher w/ key) ----
  jina_reader_scrape: 0,

  // ---- Social ----
  socialfetch_lookup: 3000,
  // Pre-stream anchor reads — truthful operation names; priced at the underlying
  // provider's cost so the metered spend matches what was actually called.
  anchor_profile_read: 3000, // SocialFetch profile read (same pool as socialfetch_lookup)
  anchor_serp_read: 1000,    // Perplexity SERP read (same as minimax_web_search)
  socialfetch_web_read: 3000, // /v1/web/markdown — ~1 credit/URL, same pool as a lookup
  socialfetch_whoami: 0,      // /v1/whoami — free, zero credits
  socialfetch_balance: 0,     // /v1/balance — free, zero credits

  // ---- CordCat (Discord OSINT) ----
  // Free plan: 60 req/hour. Treat each successful call as ~$0.002.
  cordcat_discord_lookup: 2000,

  // ---- URL/web infra ----
  urlscan_search: 1000,
  whois_lookup: 1000,
  ip_intel: 1000,
  ipgeolocation_lookup: 1000,
  virustotal_lookup: 2000,
  dork_harvest: 3000,         // wraps several web searches (+ up to 3 Gemini reads)
  gemini_deep_dork: 2000,     // 1 Gemini 2.5 Flash call w/ google_search grounding
  gemini_vision: 2000,        // 1 Gemini Flash multimodal call (image or PDF page)

  // ---- OSINT Navigator (tool-recommendation meta service) ----
  osint_navigator_query: 500,
  osint_navigator_search: 200,

  // ---- Recording / storage (free) ----
  record_artifact: 0,
  record_artifacts: 0,
  record_evidence: 0,

  // ---- Analytical / bookkeeping tools (no external API — free) ----
  // These operate purely over already-recorded artifacts/DB state, so a call
  // makes no billable provider request. Explicit 0 (not the default floor) so
  // an in-run audit/finding never inflates the honest $-per-investigation figure.
  coverage_audit: 0,        // advisory coverage-gap audit over recorded artifacts
  detect_contradictions: 0, // examines recorded artifacts for identity/infra conflicts
  tool_audit: 0,            // advisory tool health/utilization summary
  record_finding: 0,        // persists a source-backed finding (bookkeeping)
  unknown_tool_ignored: 0,  // internal sink for hallucinated tool names (#211) — no external call

  // ---- Previously-uncosted registered tools (2026-06-27 audit) ----
  // These 21 tools were registered in tool-registry.ts but absent from this
  // map, so every call silently billed the $0.0002 default floor instead of an
  // honest figure. Free/public unauthenticated endpoints → 0; paid/keyed
  // providers priced in line with their peers above.
  archive_url: 0,              // web.archive.org/save — free
  crtsh_subdomains: 0,         // crt.sh — free, unauth (peer of crtsh_lookup)
  crypto_wallet: 0,            // blockstream.info public explorer — free
  github_user: 0,              // api.github.com unauth — free (peer of github_code_search)
  hackernews_user: 0,          // HN firebase API — free
  hackertarget: 0,             // api.hackertarget.com — free tier
  ipqualityscore_lookup: 1000, // IPQualityScore — paid (peer of ip_intel/urlscan)
  // DeepFind (deepfind.me, DEEPFIND_API_KEY) — single paid provider, priced to
  // match the already-listed deepfind_reverse_email / deepfind_telegram_channel (2000).
  deepfind_aircraft_lookup: 2000,
  deepfind_dark_web_link: 2000,
  deepfind_disposable_email: 2000,
  deepfind_email_breach: 2000,
  deepfind_mac_lookup: 2000,
  deepfind_ssl_inspect: 2000,
  deepfind_tech_stack: 2000,
  deepfind_telegram_search: 2000,
  deepfind_transaction_viewer: 2000,
  deepfind_url_unshorten: 2000,
  deepfind_vessel_lookup: 2000,
  deepfind_vin_lookup: 2000,
};

export function costForTool(name: string): number {
  return TOOL_COSTS_MICRO_USD[name] ?? DEFAULT_TOOL_COST_MICRO_USD;
}

export function microUsdToDollars(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}