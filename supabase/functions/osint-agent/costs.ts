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
  youtube_oembed: 0,        // YouTube oEmbed — free, unauth
  roblox_user: 0,           // users.roblox.com public API — free, unauth
  steam_profile: 0,         // steamcommunity.com ?xml=1 — free, unauth
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
  pdl_person_enrich: 50000,

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
  socialfetch_web_read: 3000, // /v1/web/markdown — ~1 credit/URL, same pool as a lookup
  socialfetch_whoami: 0,      // /v1/whoami — free, zero credits
  socialfetch_balance: 0,     // /v1/balance — free, zero credits
  // Opsis (useopsis.com/docs/api, 2026-10-01): a search is 1 credit (premium username
  // search 2); credit packs run $0.40 down to $0.25 per credit. Mid-range figure.
  // Reading a run, /v1/credits and /v1/me are free.
  opsis_search: 300_000,
  opsis_results: 0,
  opsis_balance: 0,
  opsis_status: 0,

  // ---- CordCat (Discord OSINT) ----
  // Free plan: 60 req/hour. Treat each successful call as ~$0.002.
  cordcat_discord_lookup: 2000,

  // ---- URL/web infra ----
  urlscan_search: 1000,
  whois_lookup: 1000,
  ip_intel: 1000,
  ipgeolocation_lookup: 1000,
  virustotal_lookup: 2000,
  // FOFA — points-metered (fpoints per returned row, ~free-tier 1000/mo pool).
  // Treat a default size:20 query as ~$0.004.
  fofa_search: 4000,
  // markdown.new — free, no auth (500/day per IP).
  markdown_extract: 0,
  dork_harvest: 3000,         // wraps several web searches (+ up to 3 Gemini reads)
  gemini_deep_dork: 2000,     // 1 Gemini 2.5 Flash call w/ google_search grounding
  gemini_vision: 2000,        // 1 Gemini Flash multimodal call (image or PDF page)
  // GeoSeer AI image geolocation — paid per analyzed media item (credit pool).
  // Treat one `fast` analysis as ~$0.02.
  geoseer_geolocate: 20000,

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
  finalize_no_findings: 0, // internal finalize decision; no external call
  finalize_skip_memory: 0, // internal finalize decision; no external call
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

/**
 * Kill switch, read at call time: `INDICIA_MISSING_FIRST_NAME_DISABLED=true` makes `allowMissingFirstName` inert — it is
 * not sent to the provider and does not raise the logged cost.
 */
export function indiciaMissingFirstNameDisabled(): boolean {
  // globalThis.Deno, not bare `Deno`: the frontend bundle/typecheck imports this module (lessons.md, 2026-10-13).
  const deno = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return (deno?.env.get("INDICIA_MISSING_FIRST_NAME_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/**
 * Multiplier on indicia_person's list price when the opt-in is set. 1 = no surcharge: Indicia's GET /v1/pricing (read
 * 2026-10-23) lists `person: 1` and no separate entry for allowMissingFirstName. The seam stays so a published surcharge
 * is a one-constant change that the ledger picks up.
 */
export const INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER = 1;

/**
 * The list price of ONE call, given its input. Only indicia_person with an explicit boolean `allowMissingFirstName: true`
 * differs from the per-tool price; everything else is `costForTool`. Used for the usage-log cost/charge so the ledger
 * carries the real cost of an opted-in search. (Admission/budget tiering still uses the base price.)
 */
export function costForToolCall(name: string, input: unknown): number {
  const base = costForTool(name);
  if (name === "indicia_person" && !indiciaMissingFirstNameDisabled() && (input as { allowMissingFirstName?: unknown } | null)?.allowMissingFirstName === true) {
    return base * INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER;
  }
  return base;
}

/** /health → checks.indicia_person_opt_in. Pure; presence proves this build. */
export function indiciaPersonOptInSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "INDICIA_MISSING_FIRST_NAME_DISABLED";
  if (indiciaMissingFirstNameDisabled()) return { ok: true, switch: `${sw}=true`, detail: `LEGACY via ${sw} (the flag is ignored and never sent)` };
  const base = costForTool("indicia_person");
  const ok = costForToolCall("indicia_person", {}) === base &&
    costForToolCall("indicia_person", { allowMissingFirstName: false }) === base &&
    costForToolCall("indicia_person", { allowMissingFirstName: "true" }) === base &&
    costForToolCall("indicia_person", { allowMissingFirstName: true }) === base * INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER &&
    costForToolCall("indicia_email", { allowMissingFirstName: true }) === costForTool("indicia_email");
  return ok
    ? { ok: true, switch: `${sw}=false`, detail: "indicia_person accepts a missing first name only on an explicit boolean allowMissingFirstName (default off, never auto-set); an opted-in call is ledgered at list price x INDICIA_MISSING_FIRST_NAME_COST_MULTIPLIER (1 per /v1/pricing)" }
    : { ok: false, switch: `${sw}=false`, detail: "indicia opt-in costing misbehaving" };
}

export function microUsdToDollars(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ---- Anthropic (Claude API) orchestrator pricing --------------------------------------
//
// The orchestrator's own LLM spend is metered per step (index.ts onStepFinish) into the
// same run-cost / credit ledger as the other orchestrators. Units: micro-USD per token,
// which is numerically identical to USD per MTok ($2/MTok === 2 micro-USD/token).
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-13.
// `cacheWrite` is the 5-minute ephemeral write price (1.25x input) — the only TTL this
// integration requests. Cache-read multiplier differs by model (0.1x by default, 0.05x on
// Sonnet 5.5 / Opus 5.5, 0.025x on Fable 5.1), so each row states it explicitly rather
// than deriving it. ⚠️ An earlier cached copy of this table listed Sonnet 5.5 cache reads at
// $0.20; the live page says $0.10. Re-check against the pricing page when adding a model.
export interface AnthropicRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ANTHROPIC_RATES_MICRO_USD_PER_TOKEN: Record<string, AnthropicRates> = {
  "claude-sonnet-5":   { input: 2,  output: 10, cacheRead: 0.2,  cacheWrite: 2.5 },
  "claude-sonnet-5-5": { input: 2,  output: 10, cacheRead: 0.1,  cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-opus-5":     { input: 5,  output: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  "claude-opus-5-5":   { input: 4,  output: 20, cacheRead: 0.2,  cacheWrite: 5 },
  "claude-fable-5-1":  { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/**
 * Rates for a model id the table does not list: the most expensive known row with the
 * priciest cache-read multiplier ($1/MTok, as on Fable 5). Deliberately pessimistic — an
 * unknown or mistyped ANTHROPIC_MODEL_ID must OVER-meter the finite credit balance, never
 * under-meter it. /health reports `pricing_known: false` so the operator sees it.
 */
export const ANTHROPIC_UNKNOWN_MODEL_RATES: AnthropicRates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export function anthropicRatesFor(modelId: string): AnthropicRates & { known: boolean } {
  const key = modelId.trim().toLowerCase().replace(/-\d{8}$/, "");
  const row = ANTHROPIC_RATES_MICRO_USD_PER_TOKEN[key];
  return row ? { ...row, known: true } : { ...ANTHROPIC_UNKNOWN_MODEL_RATES, known: false };
}

/** The four billable token buckets of one request (see extractAnthropicUsage). */
export interface AnthropicUsageTokens {
  /** Uncached input remainder only — NOT the SDK's total inputTokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Micro-USD for one request, rounded to the nearest micro-USD. */
export function anthropicCostMicroUsd(modelId: string, u: AnthropicUsageTokens): number {
  const r = anthropicRatesFor(modelId);
  return Math.round(u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite);
}
