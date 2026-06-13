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
  breach_check: 3000,         // 3 stolen.tax calls in parallel
  stolentax_footprint: 1500,
  leakcheck_lookup: 5000,     // 200/day → ~$0.005/call equiv
  hibp_lookup: 3000,          // ~$3.95/mo Pwned 1 plan, ~1300 req/mo → ~$0.003
  intelbase_email_lookup: 2000,
  oathnet_lookup: 10000,      // 100/day cap, expensive — reserve
  deepfind_reverse_email: 2000,
  deepfind_telegram_channel: 2000,
  // Serus darkweb scan: serus_core charges 0.25 credits/scan. No public USD
  // rate, so we use a conservative ~$0.01/credit estimate (in line with peer
  // darkweb/breach tools like oathnet $0.01, leakcheck $0.005). Explicit on
  // purpose — a darkweb scan must never fall through to the $0.0002 default.
  serus_darkweb_scan: 2500,
  emailrep: 0,
  gravatar_profile: 0,

  // ---- OSINTNova / Bosint (1000/day shared quota, ~$2/mo plan share) ----
  bosint_email_lookup: 2000,
  bosint_phone_lookup: 2000,

  // ---- Hunter.io ----
  hunter_domain_search: 4000,
  hunter_email_finder: 4000,
  hunter_email_verifier: 1000,
  hunter_combined: 5000,

  // ---- Firecrawl (1 credit ≈ $0.002 on growth plan) ----
  firecrawl_search: 4000,     // ~2 credits avg
  firecrawl_scrape: 2000,
  firecrawl_map: 2000,

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

  // ---- CordCat (Discord OSINT) ----
  // Free plan: 60 req/hour. Treat each successful call as ~$0.002.
  cordcat_discord_lookup: 2000,

  // ---- URL/web infra ----
  urlscan_search: 1000,
  whois_lookup: 1000,
  ip_intel: 1000,
  ipgeolocation_lookup: 1000,
  virustotal_lookup: 2000,
  dork_harvest: 3000,         // wraps several web searches
  gemini_deep_dork: 2000,     // 1 Gemini 2.5 Flash call w/ google_search grounding

  // ---- OSINT Navigator (tool-recommendation meta service) ----
  osint_navigator_query: 500,
  osint_navigator_search: 200,

  // ---- Synapsint (multi-endpoint OSINT aggregator, free tier) ----
  synapsint_lookup: 500,

  // ---- Recording / storage (free) ----
  record_artifact: 0,
  record_artifacts: 0,
  record_evidence: 0,
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