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
  // "Pivot", not "Targeted pivot": the runtime token names an internal state;
  // the analyst word for following a selector is the one JD's own playbooks use.
  TARGETED_PIVOT: "Pivot",
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
  const full = DISPLAY[toolName] ?? fallbackDisplay(toolName);
  const idx = full.indexOf(" — ");
  return idx >= 0 ? full.slice(idx + 3) : full;
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

/** A real tool name is an identifier. */
const TOOL_IDENT_RE = /^[a-z0-9_]+$/i;

function titleCaseTool(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Leaked call markup: angle brackets, JSON punctuation, or GLM's arg tags. */
const CALL_MARKUP_RE = /[<>{}[\]"]|arg_(?:key|value)/i;

/** Longest free-text source label shown before it is cut with an ellipsis. */
const SOURCE_LABEL_MAX = 60;

/**
 * A name carrying call MARKUP is a malformed call, and is labelled as one.
 * Production 2026-10-01: GLM wrote its `<arg_key>/<arg_value>` call markup into
 * the tool NAME; the server sank the call, but the stored part kept the name
 * and this fallback title-cased it into
 * "Minimax Correlate</Arg Value>Artifacts</Arg Key>…" — model markup, and the
 * case's selectors, shown as a cycle label.
 *
 * Free text WITHOUT markup is not a call at all. The report's Tool Coverage and
 * Source Appendix group evidence by its recorded source, and a model-recorded
 * source is prose like "FBI Wanted (fbi.gov/wanted/cac)". Treating every
 * non-identifier as malformed printed that as "Malformed call (Fbi)" — measured
 * on a production report 2026-10-01, 14 of 36 coverage lines. Such a label is
 * shown as written, whitespace-collapsed and length-capped.
 */
function fallbackDisplay(name: string): string {
  if (TOOL_IDENT_RE.test(name)) return `Analyst — ${titleCaseTool(name)}`;
  if (CALL_MARKUP_RE.test(name)) {
    const head = name.match(/^[a-z0-9_]+/i)?.[0];
    return `Analyst — Malformed call${head ? ` (${titleCaseTool(head)})` : ""}`;
  }
  const text = name.replace(/\s+/g, " ").trim();
  if (!text) return "Analyst — Unknown source";
  return `Analyst — ${text.length > SOURCE_LABEL_MAX ? `${text.slice(0, SOURCE_LABEL_MAX - 1)}…` : text}`;
}

/**
 * The name to label a `buildToolAudit` entry with. Its `tool` is a GROUPING key
 * (`primaryToolSlug`): exact for a tool slug, but lossy for free text — it is
 * lowercased and cut at the parenthesis, so "FBI Wanted (fbi.gov/wanted/cac)"
 * keys as "fbi wanted". A real tool is labelled by its key; a free-text source
 * by the first link of the chain it was RECORDED under.
 */
export function auditEntryToolName(entry: { tool: string; variants?: readonly string[] }): string {
  if (DISPLAY[entry.tool] || entry.tool.includes("_")) return entry.tool;
  const recorded = entry.variants?.find((v) => v.trim());
  return recorded ? recorded.split(/\s+\+\s+/)[0].trim() : entry.tool;
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
 * Internal (non-provider) tools, as a cycle's purpose line names them. SHORT_SOURCE
 * covers providers; these are the run's own bookkeeping steps, phrased as what
 * the step did rather than which sub-agent "role" did it.
 */
const CONCISE_INTERNAL: Record<string, string> = {
  list_tools: "capability check",
  triage_seed: "seed triage",
  memory_recall: "memory recall",
  memory_save: "memory save",
  record_artifacts: "artifacts recorded",
  record_artifact: "artifact recorded",
  record_finding: "finding recorded",
  record_evidence: "evidence recorded",
  minimax_correlate: "correlation pass",
  coverage_audit: "coverage audit",
  detect_contradictions: "contradiction check",
  tool_audit: "tool audit",
  finalize_no_findings: "no findings to record",
  finalize_skip_memory: "memory step skipped",
  minimax_plan_pivots: "pivot planning",
  minimax_extract: "entity extraction",
  minimax_web_search: "public-source search",
  socialfetch_lookup: "profile lookup",
  socialfetch_web_read: "page read",
  gravatar_profile: "Gravatar lookup",
  github_code_search: "code search",
  exa_search: "semantic web search",
  opsis_search: "account sweep",
  opsis_results: "account sweep results",
};

/**
 * A short, lower-case label for a tool, for a cycle's purpose line ("breach
 * lookup · username sweep"). Provider tools come from SHORT_SOURCE, the run's
 * own steps from CONCISE_INTERNAL, anything else from the action label; a raw
 * `snake_case` id is never returned.
 */
export function conciseToolLabel(toolName: string): string {
  const name = (toolName ?? "").trim();
  if (!name) return "";
  const known = SHORT_SOURCE[name] ?? CONCISE_INTERNAL[name];
  if (known) return known;
  // A registry action ("Searching semantic web index") keeps its casing after the
  // first letter; a label title-cased from a bare id ("Hunter Verify") is
  // lower-cased whole, or the purpose line reads "hunter Verify".
  if (DISPLAY[name]) {
    const action = toolActionLabel(name);
    return action.charAt(0).toLowerCase() + action.slice(1);
  }
  return toolActionLabel(name).toLowerCase();
}

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

/**
 * Secondary detail line for a Tools-activity row, or null when there is nothing
 * to add.
 *
 * A `reason` (error / gate / degradation text) always earns the line. Without
 * one the caller falls back to `actionLabel` — but that is DERIVED from
 * `toolDisplayName` (the slice after " — ", or the whole string when there is
 * no dash), so for every tool in the registry it is already contained in the
 * title. Rendering it unconditionally made each succeeded row restate itself:
 * "Analyst — Socialfetch" above "Analyst — Socialfetch".
 */
export function toolSecondaryLine(e: {
  reason?: string | null;
  actionLabel?: string | null;
  displayName?: string | null;
}): string | null {
  if (e.reason) return e.reason;
  const action = e.actionLabel?.trim();
  if (!action) return null;
  return e.displayName?.toLowerCase().includes(action.toLowerCase()) ? null : action;
}
