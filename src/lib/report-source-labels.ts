/**
 * Humanize raw OSINT tool/source identifiers for analyst-facing REPORT / EXPORT
 * prose (the generated markdown, .md, and PDF).
 *
 * Presentation-only. The raw `source` stays in the artifact data model
 * (`metadata.sources`, machine-readable export fields) for provenance/debugging
 * — this only formats the visible "via …" / Source-column text so a generated
 * report never shows `oathnet_lookup+serus_darkweb_scan+…`. It NEVER changes
 * confidence, source classification, status derivation, or any claim strength.
 *
 * Labels are deliberately conservative: they name the *kind* of lookup, never
 * its strength (e.g. "breach check", not "confirmed breach").
 */

// Known tool/slug → conservative human-readable label.
const SOURCE_LABELS: Record<string, string> = {
  // breach / exposure
  oathnet_lookup: "breach/profile lookup",
  serus_darkweb_scan: "dark-web scan",
  deepfind_dark_web_link: "dark-web reference check",
  deepfind_email_breach: "email breach lookup",
  breach_check: "breach check",
  leakcheck_lookup: "credential exposure lookup",
  leakcheck: "credential exposure lookup",
  hibp_lookup: "breach check",
  hibp_pwned_passwords_kanon: "password exposure check",
  intelbase_email_lookup: "email exposure lookup",
  deepfind_reverse_email: "reverse email lookup",
  deepfind_disposable_email: "disposable-address check",
  // threat intel (conservative — org/victim-level, not the subject)
  ransomwarelive_lookup: "threat-intel lookup",
  deepfind_ransomware_exposure: "threat-intel exposure lookup",
  // email intelligence
  bosint_email_lookup: "email intelligence lookup",
  bosint_phone_lookup: "phone intelligence lookup",
  gravatar_profile: "avatar/profile lookup",
  gravatar_lookup: "avatar/profile lookup",
  hunter_email_verifier: "email verification",
  hunter_email_finder: "email discovery",
  hunter_domain_search: "domain email search",
  hunter_combined: "email reconnaissance",
  // social / identity
  username_sweep: "username sweep",
  username_search: "username search",
  socialfetch_lookup: "social profile lookup",
  github_user: "developer profile lookup",
  github_code_search: "code search",
  reddit_user: "community activity review",
  hackernews_user: "community footprint review",
  // search / enrichment
  minimax_web_search: "web search",
  exa_search: "web search",
  gemini_deep_dork: "AI-assisted deep search",
  google_dorks: "search-query build",
  dork_harvest: "search-result harvest",
  jina_reader_scrape: "source page review",
  exa_get_contents: "source page review",
  // infrastructure
  whois_lookup: "domain registration lookup",
  crtsh_subdomains: "certificate transparency lookup",
  crtsh_lookup: "certificate transparency lookup",
  dns_records: "DNS lookup",
  shodan_internetdb: "exposed-service scan",
  ip_intel: "IP intelligence",
  ipgeolocation_lookup: "IP geolocation",
  ipqualityscore_lookup: "IP/reputation lookup",
  http_fingerprint: "web-server fingerprint",
  hackertarget: "network recon",
  virustotal_lookup: "threat-intel feed check",
  urlscan_search: "URL scan history",
  wayback_snapshots: "web archive lookup",
  wayback_cdx_search: "web archive lookup",
  archive_url: "archive snapshot",
  // public records / registries
  census_geocode: "address geocode",
  nominatim_geocode: "address geocode",
  opencorporates_search: "company registry search",
  gleif_lei_search: "company registry search",
  // analysis / recording (diagnostic, but still readable)
  detect_contradictions: "contradiction analysis",
  coverage_audit: "coverage audit",
  record_artifacts: "artifact recorder",
  record_artifact: "artifact recorder",
  record_finding: "finding recorder",
  record_evidence: "evidence recorder",
  memory_save: "case memory",
  memory_recall: "case memory recall",
  triage_seed: "seed triage",
  list_tools: "capability load",
};

/** A snake_case tool slug (≥1 underscore), e.g. `username_sweep`. */
const SLUG_RE = /[a-z0-9]+(?:_[a-z0-9]+)+/gi;

/** Map one snake_case slug to its label (known map, else de-underscored). */
function labelSlug(slug: string): string {
  const k = slug.toLowerCase();
  return SOURCE_LABELS[k] ?? k.replace(/_/g, " ");
}

/**
 * Map a single source token to a readable label. Handles the common backend
 * shape where a slug carries a trailing descriptor — e.g. "username_sweep
 * analysis" — by replacing the embedded slug while leaving the rest. Free text
 * with no slug (a domain, "LinkedIn", "scrape analysis") is left untouched.
 */
function labelToken(token: string): string {
  const t = token.trim();
  if (!t) return "";
  const key = t.toLowerCase();
  if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
  // Replace every embedded snake_case slug; never leave a raw tool id behind.
  return t.replace(SLUG_RE, (slug) => labelSlug(slug));
}

/**
 * Convert a raw source string or array (possibly a `+` / `,` / `/`-joined chain
 * of tool slugs) into analyst-readable, deduplicated " + "-joined labels.
 * Returns `fallback` (default "tool") when there is nothing to show — never an
 * empty string.
 */
export function tokenizeSourceChain(
  raw: string | string[] | null | undefined,
): string[] {
  const elements = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of elements.flatMap((s) => String(s).split(/[+,/]/))) {
    const value = token.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function humanizeSourceChain(
  raw: string | string[] | null | undefined,
  fallback = "tool",
): string {
  const tokens = tokenizeSourceChain(raw)
    .map(labelToken)
    .filter(Boolean);
  // Dedupe case-insensitively, preserving first-seen order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out.join(" + ") : fallback;
}
