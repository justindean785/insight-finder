/**
 * Human-readable display labels for OSINT tool calls.
 *
 * Format: "[Agent Role] — [Action Label]"
 *
 * Collapsed tool cards show the display name. The raw tool identifier
 * (e.g. "breach_check") is revealed only in the expanded detail pane.
 */

const DISPLAY: Record<string, string> = {
  // ── Orchestration ──
  list_tools:    "Case Manager — Loading available capabilities",
  triage_seed:   "Lead Analyst — Triaging seed intelligence",

  // ── Breach & exposure (sensitive — no raw tool names in collapsed UI) ──
  breach_check:          "Risk Signal Analyst — Reviewing restricted indicators",
  hibp_lookup:           "Risk Signal Analyst — Checking known exposure records",
  leakcheck_lookup:      "Risk Signal Analyst — Querying credential exposure index",
  oathnet_lookup:        "Risk Signal Analyst — Deep-scanning credential signals",
  serus_darkweb_scan:    "Risk Signal Analyst — Scanning restricted-source indicators",

  // ── Email intelligence ──
  gravatar_profile:      "Profile Analyst — Checking linked avatar data",
  hunter_domain_search:  "Data Hunter — Enumerating domain-linked contacts",
  hunter_email_finder:   "Data Hunter — Locating associated email addresses",
  hunter_email_verifier: "Evidence Triage — Verifying email deliverability",
  hunter_combined:       "Data Hunter — Running combined email reconnaissance",
  bosint_email_lookup:   "Evidence Triage — Checking internal correlation signals",
  bosint_phone_lookup:   "Evidence Triage — Checking phone correlation signals",
  deepfind_reverse_email:"Signal Reviewer — Evaluating email ownership traces",
  deepfind_disposable_email: "Evidence Triage — Checking disposable address status",
  intelbase_email_lookup:"Signal Reviewer — Evaluating sensitive-source indicators",

  // ── Social & identity ──
  socialfetch_lookup:    "Profile Analyst — Checking public account associations",
  cordcat_discord_lookup:"Profile Analyst — Searching messaging platform links",
  username_sweep:        "Data Hunter — Sweeping platforms for handle matches",
  username_search:       "Data Hunter — Searching username variations",
  github_user:           "Profile Analyst — Checking developer profile traces",
  github_code_search:    "Data Hunter — Searching public code repositories",
  reddit_user:           "Profile Analyst — Reviewing community activity history",
  hackernews_user:       "Profile Analyst — Reviewing tech community footprint",
  deepfind_profile_analyzer: "Profile Analyst — Analyzing social profile depth",
  deepfind_telegram_channel: "Data Hunter — Scanning messaging channel records",
  deepfind_telegram_search:  "Data Hunter — Searching messaging platform content",

  // ── Infrastructure ──
  whois_lookup:          "Infrastructure Analyst — Querying domain registration",
  crtsh_subdomains:      "Infrastructure Analyst — Enumerating certificate transparency",
  dns_records:           "Infrastructure Analyst — Resolving DNS records",
  shodan_internetdb:     "Infrastructure Analyst — Fingerprinting exposed services",
  ip_intel:              "Infrastructure Analyst — Gathering IP intelligence",
  ipgeolocation_lookup:  "Infrastructure Analyst — Geolocating network address",
  http_fingerprint:      "Infrastructure Analyst — Fingerprinting web server",
  virustotal_lookup:     "Risk Signal Analyst — Checking threat intelligence feeds",
  hackertarget:          "Infrastructure Analyst — Running network reconnaissance",
  urlscan_search:        "Infrastructure Analyst — Scanning URL threat history",
  wayback_snapshots:     "Source Analyst — Searching archived page snapshots",
  archive_url:           "Source Analyst — Archiving source for chain of custody",
  deepfind_ssl_inspect:  "Infrastructure Analyst — Inspecting SSL certificate chain",
  deepfind_tech_stack:   "Infrastructure Analyst — Detecting technology stack",
  deepfind_url_unshorten:"Infrastructure Analyst — Resolving redirect chain",
  deepfind_mac_lookup:   "Infrastructure Analyst — Identifying hardware vendor",
  deepfind_dark_web_link:"Risk Signal Analyst — Checking restricted-source references",

  // ── Search & enrichment ──
  google_dorks:          "Data Hunter — Building targeted search queries",
  dork_harvest:          "Data Hunter — Harvesting search engine results",
  gemini_deep_dork:      "Lead Analyst — Running AI-assisted deep search",
  exa_search:            "Data Hunter — Searching semantic web index",
  exa_find_similar:      "Data Hunter — Finding related source material",
  exa_get_contents:      "Source Analyst — Extracting page contents",
  jina_reader_scrape:    "Source Analyst — Reviewing source material",
  minimax_web_search:    "Data Hunter — Gathering public-source leads",
  minimax_extract:       "Source Analyst — Extracting structured data",
  minimax_correlate:     "Lead Analyst — Correlating cross-source data points",
  minimax_plan_pivots:   "Lead Analyst — Planning next investigation pivots",

  // ── Crypto ──
  crypto_wallet:         "Financial Analyst — Tracing blockchain activity",

  // ── Special lookups ──
  deepfind_ransomware_exposure: "Risk Signal Analyst — Checking ransomware exposure signals",
  ransomwarelive_lookup: "Risk Signal Analyst — Checking ransomware-victim exposure",
  deepfind_vin_lookup:   "Data Hunter — Running vehicle identification lookup",
  deepfind_aircraft_lookup: "Data Hunter — Searching aircraft registry records",
  deepfind_vessel_lookup:"Data Hunter — Searching vessel registry records",
  osint_navigator_query: "Lead Analyst — Querying intelligence navigator",
  osint_navigator_search:"Data Hunter — Searching intelligence source catalog",

  // ── Recording & analysis ──
  record_artifacts:      "Case Manager — Organizing case artifacts",
  record_artifact:       "Case Manager — Logging artifact to case file",
  record_evidence:       "Case Manager — Securing evidence to custody chain",
  record_finding:        "Case Manager — Documenting key finding",
  memory_recall:         "Lead Analyst — Recalling prior case intelligence",
  memory_save:           "Lead Analyst — Storing intelligence for future recall",
  coverage_audit:        "Quality Control — Auditing investigation coverage",
  detect_contradictions: "Quality Control — Checking for conflicts",
  tool_audit:            "Quality Control — Reviewing execution quality",
};

/**
 * Returns a professional display label for a tool call.
 * Format: "[Agent Role] — [Action Label]"
 */
export function toolDisplayName(toolName: string): string {
  return DISPLAY[toolName] ?? fallbackDisplay(toolName);
}

/**
 * Plain-language names for the runtime's investigation stages. The orchestrator
 * emits raw tokens (TRIAGE, REVIEW, TARGETED_PIVOT, VERIFY, REPORT — see
 * `runtime-policy.ts` `InvestigationStage`); the chat timeline must never show
 * a raw `SNAKE_CASE` token to an analyst.
 */
const STAGE_LABELS: Record<string, string> = {
  TRIAGE: "Triage",
  REVIEW: "Review",
  TARGETED_PIVOT: "Targeted pivot",
  VERIFY: "Verify",
  REPORT: "Report",
};

/**
 * Maps a runtime stage token to a human-readable stage name. Unknown/legacy
 * tokens are de-cased into Title-case plain words rather than leaked verbatim,
 * so a `SNAKE_CASE` value can never reach the UI. Empty input → "Review" (the
 * grouping default).
 */
export function humanizeStage(stage: string | null | undefined): string {
  const raw = (stage ?? "").trim();
  if (!raw) return "Review";
  const known = STAGE_LABELS[raw.toUpperCase()];
  if (known) return known;
  const cleaned = raw.replace(/[_-]+/g, " ").toLowerCase().trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Review";
}

/**
 * Returns just the action portion (after the " — ") for use in reports
 * and prose where the full role prefix would be redundant.
 */
export function toolActionLabel(toolName: string): string {
  const full = DISPLAY[toolName];
  if (full) {
    const idx = full.indexOf(" — ");
    return idx >= 0 ? full.slice(idx + 3) : full;
  }
  return fallbackDisplay(toolName);
}

/**
 * Returns the agent role portion (before the " — ").
 */
export function toolAgentRole(toolName: string): string {
  const full = DISPLAY[toolName];
  if (full) {
    const idx = full.indexOf(" — ");
    return idx >= 0 ? full.slice(0, idx) : "Analyst";
  }
  return "Analyst";
}

function fallbackDisplay(name: string): string {
  const action = name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `Analyst — ${action}`;
}

/**
 * Short, plain-English source labels for primary card summaries (Next Steps,
 * pivot details). Raw tool IDs must never appear in a card summary — only in an
 * expandable provenance/detail pane. Concise on purpose, unlike the verbose
 * role-prefixed `toolDisplayName` used in the Tools activity feed.
 */
const SHORT_SOURCE: Record<string, string> = {
  oathnet_lookup: "breach/profile lookup",
  breach_check: "breach lookup",
  hibp_lookup: "breach lookup",
  leakcheck_lookup: "credential-exposure lookup",
  serus_darkweb_scan: "restricted-source scan",
  bosint_email_lookup: "email correlation",
  bosint_phone_lookup: "phone correlation",
  deepfind_email_breach: "breach lookup",
  username_sweep: "username sweep",
  username_search: "username search",
  jina_reader_scrape: "source page review",
  minimax_web_search: "public-source search",
  gemini_deep_dork: "AI deep search",
  dork_harvest: "search-engine harvest",
  hunter_email_verifier: "email verification",
  whois_lookup: "domain registration lookup",
  dns_records: "DNS lookup",
  ip_intel: "IP intelligence",
  multiple: "multiple sources",
};

/**
 * Returns a concise, human-readable label for a (possibly compound) source
 * string such as "oathnet_lookup+serus_darkweb_scan". Picks the primary token,
 * notes when several tools agreed, and never emits a raw `snake_case` tool id.
 */
export function readableSourceLabel(rawSource: string | null | undefined): string {
  if (!rawSource) return "tool";
  const trimmed = rawSource.trim();
  if (!trimmed) return "tool";
  const tokens = trimmed.split(/[+,/]/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return "tool";
  const primary = tokens[0];
  const readable = SHORT_SOURCE[primary]
    ?? (DISPLAY[primary] ? toolActionLabel(primary).toLowerCase() : null)
    ?? (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(primary)
      ? primary.replace(/_/g, " ")
      : primary);
  return tokens.length > 1 ? `${readable} +${tokens.length - 1} more` : readable;
}
