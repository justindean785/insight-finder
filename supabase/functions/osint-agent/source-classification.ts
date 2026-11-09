// Central source-classification layer (edge runtime — source of truth).
//
// The recording paths persist `metadata.source_category` and the confidence
// engine caps on it, so the entity that maps a raw `source` to a SourceClass
// MUST live here and be the only home for that logic.
//
// Two kinds of input flow in:
//   1. internal tool slugs  — e.g. "minimax_web_search", "oathnet_lookup"
//   2. free-text provider labels — e.g. "D&B", "D&B / Redfin", "Houzz review",
//      "Property records search", "Web search", "LinkedIn", "Multiple sources"
//
// Historically (1) was handled by TOOL_CLASS and (2) fell through to `unknown`
// (cap 50) — the exact bug seen in the 1677 Iroquois Rd trace where every
// artifact carried `source_category: ["unknown"]`. This module classifies both,
// splits mixed labels ("D&B / Redfin" → two classes), and recognises wrapper
// labels ("Multiple sources" / "Investigation") so the real provenance is read
// from `metadata.sources` instead.
//
// ── Merge note (backport mirror #16 PR2) ────────────────────────────────────
// This module is the merged single classifier. It adopts mirror #16's
// architecture (one classifier, free-text label support, mixed-label splitting,
// wrapper-label handling, OFFICIAL_CLASSES / countIndependentClasses helpers)
// BUT preserves post-#56 main's BEHAVIOR verbatim: the SPLIT infrastructure
// sub-class taxonomy (infra_registry / infra_dns / infra_scan / infra_reputation
// / infra_passive / infra_shared_host) and main's exact internal-tool → class
// mapping replace #16's coarse single "infra". Where #16 and #56 disagreed on a
// source's class, #56 WON — see the tier-disagreement log in the PR report.

import { TOOL_CATALOG } from "./catalog.ts";

/** Source-class taxonomy used for confidence caps and corroboration counting.
 *  Superset: post-#56 main's split internal-tool classes are preserved (so the
 *  caps + tests stay valid) PLUS the public-record / directory / listing classes
 *  that free-text provider labels map to (from mirror #16). */
export type SourceClass =
  // ── original internal-tool classes (do not rename: TOOL_CLASS + tests rely on these)
  | "breach"
  // People-search / data-broker aggregators (Indicia person|address|phone, PDL).
  // SPLIT OUT OF `breach` 2026-07-26. These carry byte-identical caps to breach
  // (CLASS_CAP 60 + NEVER_HIGH) — the integrity contract is unchanged — but they
  // are NOT breach corpora, and labelling them as such made the UI assert that
  // uninvolved third parties' data "appeared in a breach". On a live case eleven
  // people pulled in by one address lookup were each rendered
  // "Breach/exposure · single-source"; one was a bank-fraud investigator, in a
  // bank-fraud case. A broker association is "this record was filed near that
  // record", never a breach disclosure. Same weight, honest name.
  | "data_broker"
  // Ransomware-victim / threat-intel exposure (ransomware.live etc.). Distinct
  // from "breach": it reports that an ORGANIZATION was hit, which is weak as a
  // signal about a PERSON's identity. Capped below breach + NEVER_HIGH so it can
  // never read as a verified identity claim.
  | "threat_intel"
  | "username_sweep"
  | "social_profile_passive"
  | "social_profile_active"
  | "news"
  | "court_record"
  | "official_profile_match"
  | "independent_public"
  | "ai_summary"
  // ── infrastructure (post-#56 SPLIT sub-classes — the integrity contract).
  // Coarse "infra" is retained for legacy/free-text mapping but the tool slugs
  // resolve to specific sub-classes so cross-tool corroboration can count.
  | "infra"
  | "infra_registry"
  | "infra_dns"
  | "infra_scan"
  | "infra_reputation"
  | "infra_passive"
  | "infra_shared_host"
  // ── public-record / directory / listing classes (free-text provider labels)
  | "government_property_record"
  | "government_business_registry"
  | "government_business_license"
  | "business_directory"
  | "real_estate_listing"
  | "property_aggregator"
  | "professional_profile"
  | "social_review"
  | "public_record"
  | "web_search"
  | "archive"
  | "unknown";

/** Internal tool slug → SourceClass. The slug is what the orchestrator passes
 *  as `source` when it records a tool result directly.
 *
 *  Infra slugs map to post-#56 main's SPLIT sub-classes (NOT #16's coarse
 *  "infra"). This is the integrity contract: cross-tool infra corroboration and
 *  the per-sub-class caps depend on these exact values. */
const TOOL_CLASS: Record<string, SourceClass> = {
  // breach / leak
  breach_data: "breach",
  breach_check: "breach",
  rapidapi_breach_search: "breach",
  leakcheck_lookup: "breach",
  hibp_lookup: "breach",
  oathnet_lookup: "breach",
  // OathNet v2 stealer/victim surface — infostealer credential/manifest dumps are
  // breach-class LEADS (CLASS_CAP 60, NEVER_HIGH): a single stealer/victim hit can
  // never alone reach Confirmed. oathnet_subdomains is infrastructure (mirrors
  // crtsh_subdomains → infra_dns), not identity. The helper tools (ai_filter,
  // breach_dbnames, scanner, victim_archive) don't produce recorded artifacts.
  oathnet_stealer_search: "breach",
  oathnet_victims_search: "breach",
  oathnet_victim_manifest: "breach",
  oathnet_victim_file: "breach",
  oathnet_subdomains: "infra_dns",
  intelbase_email_lookup: "breach",
  deepfind_reverse_email: "breach",
  deepfind_disposable_email: "breach",
  deepfind_email_breach: "breach",
  deepfind_dark_web_link: "breach",
  serus_darkweb_scan: "breach",
  // Indicia (api.indicia.app). The SIX split by what they actually query, not by
  // vendor. Both classes cap at 60 and sit in NEVER_HIGH, so a single Indicia hit
  // is still a LEAD that can never alone reach Confirmed — the caps are identical
  // and unchanged. Only the label differs, because the label is a factual claim.
  //   person|address|phone → people-search/broker records ("who else is filed
  //     near this address"). Reporting these as breach data asserts a disclosure
  //     that never happened, about people who are usually not the subject.
  //   email|web_dbs|hudsonrock → genuinely query breach/stealer corpora.
  indicia_person: "data_broker",
  indicia_address: "data_broker",
  indicia_phone: "data_broker",
  indicia_email: "breach",
  indicia_web_dbs: "breach",
  indicia_hudsonrock: "breach",
  // People Data Labs — data-broker person aggregator (profiles/employment/emails).
  // Now has a class that says so; weight is unchanged (same cap as breach).
  pdl_person_enrich: "data_broker",
  // Context.dev people search: candidate profiles from a people index — broker/lead tier.
  contextdev_people_search: "data_broker",
  // SocQ: a third-party read of a public profile/post, like socialfetch_lookup (cap 40, never high).
  socq_instagram_profile: "social_profile_passive",
  socq_x_profile: "social_profile_passive",
  socq_linkedin_profile: "social_profile_passive",
  socq_instagram_posts: "social_profile_passive",
  socq_instagram_post_info: "social_profile_passive",
  socq_instagram_followers_count: "social_profile_passive",
  socq_x_user_posts: "social_profile_passive",
  socq_linkedin_company: "social_profile_passive",
  socq_linkedin_posts: "social_profile_passive",
  socq_instagram_search: "social_profile_passive",
  socq_x_search: "social_profile_passive",
  socq_task_result: "social_profile_passive",
  leakcheck: "breach", // bare alias of leakcheck_lookup seen in compound source strings
  // ── Threat-intel / ransomware-victim exposure ──
  // ransomware.live and the dead deepfind_ransomware_exposure report that an
  // ORGANIZATION was hit by ransomware — that is threat intelligence, not a
  // credential breach of the subject. A dedicated `threat_intel` class (cap 50,
  // NEVER_HIGH; see confidence.ts) keeps this weak identity signal from carrying
  // breach-level weight or ever confirming an identity. (Resolved TODO.)
  ransomwarelive_lookup: "threat_intel",
  deepfind_ransomware_exposure: "threat_intel",
  // URLScanner.online combines threat-blocklist (URLhaus/Spamhaus/SURBL) +
  // infra checks + an AI risk summary. Treat as infra_reputation (peer of
  // virustotal_lookup / urlscan_search) — strong corroboration, not identity.
  urlscanner_scan: "infra_reputation",
  // k-anonymity password-exposure check — breach corpus by nature.
  hibp_pwned_passwords_kanon: "breach",
  // username sweeps
  username_sweep: "username_sweep",
  socialfetch_lookup: "social_profile_passive",
  // Active readers / profile fetchers. These retrieve identity-bearing content
  // directly from a live profile page. Classed `social_profile_active` (cap 70)
  // — strong enough to corroborate but a single active social read must NEVER
  // alone push a REAL-IDENTITY claim to Confirmed. Corroboration of REAL-NAME
  // still requires a TRUSTED_NON_INFRA class (official/court/news/independent
  // public/government) — see confidence.ts.
  socialfetch_web_read: "social_profile_active",
  github_user: "social_profile_active",
  reddit_user: "social_profile_active",
  hackernews_user: "social_profile_active",
  cordcat_discord_lookup: "social_profile_active",
  deepfind_telegram_channel: "social_profile_active",
  // username_search is the deprecated alias of username_sweep.
  username_search: "username_sweep",
  // minimax_extract fetches/extracts structured content from a URL — a direct
  // observation of a public page, on par with jina_reader_scrape/exa_get_contents.
  minimax_extract: "independent_public",
  // search/summary
  minimax_web_search: "ai_summary",
  exa_search: "ai_summary",
  exa_find_similar: "ai_summary",
  // discovery/synthesis — never counts as new independent corroboration.
  minimax_correlate: "ai_summary",
  deepfind_telegram_search: "ai_summary",
  // Navigator query/search endpoints — aggregator/search surface. If a future
  // review shows these actually resolve to a breach/record lookup, reclassify.
  osint_navigator_query: "ai_summary",
  osint_navigator_search: "ai_summary",
  gemini_deep_dork: "ai_summary",
  gemini_vision: "ai_summary",
  // GeoSeer geolocation is AI inference over pixels — LEAD-tier, capped ≤55.
  geoseer_geolocate: "ai_summary",
  google_dorks: "ai_summary",
  dork_harvest: "ai_summary",
  jina_reader_scrape: "independent_public",
  // Context.dev scrape is a fetcher like jina: the content is the public page itself.
  contextdev_scrape: "independent_public",
  exa_get_contents: "independent_public",
  // RapidAPI multi-breach aggregator — breach class.
  rapidapi_all_breaches: "breach",
  // infra — split into sub-classes so cross-tool corroboration counts (#56)
  whois_lookup: "infra_registry",
  hunter_domain_search: "infra_registry",
  hunter_email_finder: "infra_registry",
  hunter_email_verifier: "infra_registry",
  hunter_combined: "infra_registry",
  dns_records: "infra_dns",
  crtsh_subdomains: "infra_dns",
  deepfind_ssl_inspect: "infra_dns",
  ip_intel: "infra_scan",
  ipgeolocation_lookup: "infra_scan",
  shodan_internetdb: "infra_scan",
  http_fingerprint: "infra_scan",
  hackertarget: "infra_scan",
  deepfind_tech_stack: "infra_scan",
  deepfind_mac_lookup: "infra_scan",
  deepfind_url_unshorten: "infra_passive",
  virustotal_lookup: "infra_reputation",
  ipqualityscore_lookup: "infra_reputation",
  // certificate transparency — DNS/infra perspective
  crtsh_lookup: "infra_dns",
  // geocoders — address-existence public records
  census_geocode: "public_record",
  nominatim_geocode: "public_record",
  // corporate registry search. TODO(integrity): free-text "opencorporates" maps
  // to "business_directory" (line ~214); the Phase-1 proposal classifies the
  // slug as "public_record" (an OFFICIAL_CLASS). Mapped to public_record per the
  // proposal — confirm the intended class for the slug vs the free-text label.
  opencorporates_search: "public_record",
  // GLEIF LEI registry — official corporate registry, same class as the other
  // company-registry sources. (LEIs are issued by accredited LOUs.)
  gleif_lei_search: "public_record",
  // Public-record / on-chain observations
  deepfind_vin_lookup: "public_record",
  deepfind_aircraft_lookup: "public_record",
  deepfind_vessel_lookup: "public_record",
  crypto_wallet: "independent_public",
  deepfind_transaction_viewer: "independent_public",
  // passive / historical — observe the past, not the live asset
  urlscan_search: "infra_passive",
  wayback_snapshots: "infra_passive",
  wayback_cdx_search: "archive",
  archive_url: "infra_passive",
  passive_dns: "infra_passive",
  gravatar_profile: "social_profile_passive",
  gravatar_lookup: "social_profile_passive",
  // phone / people-search aggregators — low-trust aggregators, treat as passive social
  bosint_phone_lookup: "social_profile_passive",
  bosint_email_lookup: "breach",
  "usphonesearch.net": "social_profile_passive",
  "nomorobo.com": "social_profile_passive",
  // memory / agent
  memory_recall: "unknown",
};

/** Wrapper labels that carry no provenance of their own — the real sources are
 *  in `metadata.sources`. Classifying these as `unknown` is the bug that capped
 *  "Multiple sources" / "Investigation" artifacts at 50. */
const WRAPPER_LABEL_RE =
  /^(multiple sources?|several sources?|various(?: sources?)?|combined(?: sources?)?|investigation|analysis|synthesis|aggregated|cross-?referenced?)$/i;

export function isWrapperLabel(label: string | null | undefined): boolean {
  return WRAPPER_LABEL_RE.test((label ?? "").trim());
}

/** Lowercase, expand `&`→` and `, drop parens, collapse whitespace. */
export function normalizeSourceLabel(input: string): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Split a mixed source string into provider parts. Excludes `&` so "D&B" stays
// intact; splits on `/ | , ;`, the word "and", and `+`.
const MIXED_SOURCE_SPLIT_RE = /\s*(?:\/|\||,|;|\band\b|\+)\s*/i;

// Explicit label aliases for one canonical tool identity. This does not merge
// provider families: separate endpoints remain separate executions unless the
// repository explicitly identifies an alias, as it does for leakcheck.
const SOURCE_TOOL_IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  leakcheck: "leakcheck_lookup",
};

export function canonicalSourceToolIdentity(label: string): string {
  const normalized = label.trim().toLowerCase();
  return SOURCE_TOOL_IDENTITY_ALIASES[normalized] ?? normalized;
}

export function splitSourceLabels(label: string | null | undefined): string[] {
  const normalized = (label ?? "").trim();
  if (!normalized) return [];
  if (isWrapperLabel(normalized)) return [];
  // A URL qualifier belongs to ONE source, so the "/" in its path is not a
  // delimiter. Split, "jina_reader_scrape (fbi.gov/news/stories/x)" became four
  // fragments and took `news` from the word in the path, while the cap engine,
  // which classifies the whole label first, said otherwise. Other parentheticals
  // ("exa_search (DOJ release + CBS SF)") split exactly as before.
  const kept: string[] = [];
  const masked = sourceOriginRulesDisabled()
    ? normalized
    : normalized.replace(/\(([^()]*)\)/g, (group: string, inner: string) =>
      qualifierHost(inner) ? `\uE000${kept.push(group) - 1}\uE000` : group);
  return masked
    .split(MIXED_SOURCE_SPLIT_RE)
    .map((part) => part.replace(/\uE000(\d+)\uE000/g, (_m: string, i: string) => kept[Number(i)]).trim())
    .filter(Boolean);
}

// ── Negative-result qualifiers are not evidence ────────────────────────────────
// A model-written source string routinely lists every tool it TRIED, with a
// parenthetical saying what came back: "shodan_internetdb (404)",
// "oathnet_stealer_search (0 hits)", "hackertarget (no PTR)". Classifying every
// token unioned those classes, so a lookup that found NOTHING supplied the second
// "independent" class: 11 of 14 IP rows on a live case (2026-10-06) read
// "corroborated across 2 source classes: breach, infra_scan" at confidence 75-80
// on the strength of a 404 and a 0-hit search. Nothing "checked and empty" can
// corroborate anything.
//
// Deliberately DEFLATIONARY: a mis-parse can only under-count, never over-count.
// A label with no negative token is returned byte-identical; a label that is
// ENTIRELY negative keeps ONE head token so the row still carries a provenance
// class (it just can never corroborate itself). The lasting fix is
// call-to-artifact lineage (join to the call's real outcome); this is the interim
// guard. Kill switch, read at CALL TIME: NEGATIVE_QUALIFIER_CLASS_DISABLED=true.
// NOTE: this file is also imported by the FRONTEND (src/lib/confidence-tier.ts, intel.ts), whose
// typecheck has no `Deno` global — so the env read goes through readEnvSafe (globalThis, try/catch),
// never `Deno.env` directly. In the browser it reads nothing, so the rule stays ON, which is the
// intended default.
export function negativeSourceQualifierRuleDisabled(
  env: (k: string) => string | undefined = readEnvSafe,
): boolean {
  return (env("NEGATIVE_QUALIFIER_CLASS_DISABLED") ?? "").trim().toLowerCase() === "true";
}

// Anchored to the START of the qualifier on purpose. An UNANCHORED "blocked"/"timeout"/"no" matched positive
// observations whose parenthetical merely contained the word — "(VPN exit node, blocked by 3 blocklists)",
// "(timeout on 1 of 4 sources, 2 breaches found)", "(no longer registered)" — and stripped their class, which is
// a false deflation of a real finding (found in review of #693). Only the SHAPES a failed lookup actually writes
// are matched: a leading count of zero, an HTTP 404/410, "no <result-noun>", a bare "not found", and the
// pipeline's own markers.
const NEGATIVE_QUALIFIER_BODY_RE = new RegExp(
  [
    String.raw`^(?:0(?![\d.,])|zero\b|nil\b|none\b)`, // "0 hits", "none found"; NOT "0.92 match"
    String.raw`^no\s+(?:hits?|results?|match(?:es)?|records?|data|ptr|open\b|findings?|entries|accounts?|subdomains?|snapshots?|breach(?:es)?)\b`, // "no PTR"; NOT "no longer registered"
    String.raw`^(?:http\s*)?(?:404|410)\b`, // "404", "404 — no open ports"
    String.raw`\bnot[ -]?found\b`,
    String.raw`\bnot completed\b`,
    String.raw`\bcircuit[- ]?broken\b`,
    String.raw`\bfinalize window\b`,
    String.raw`^(?:timed? ?out|timeout)\b`, // "(timeout)", "(timed out after 25s)"
    String.raw`^(?:blocked|captcha)\s*(?:$|[—–:,;-])`, // "(blocked)", "(captcha)"; NOT "(blocked by 3 blocklists)"
  ].join("|"),
  "i",
);

/** A qualifier that ALSO reports something found is a mixed result, not a negative one:
 *  "(timeout on 1 of 4 sources, 2 breaches found)". The positive part keeps the token. */
const POSITIVE_COUNT_IN_QUALIFIER_RE = /\b[1-9]\d*\s+(?:hits?|breach(?:es)?|results?|matches?|accounts?|records?|profiles?)\b/i;

/** Split on top-level source separators only — a separator inside a parenthetical
 *  ("exa_search (DOJ release + CBS SF)") belongs to ONE token. */
function splitSourceTopLevel(label: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of label) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "+" || ch === "|" || ch === ";" || ch === ",")) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** True when a source token's trailing parenthetical says the lookup found nothing.
 *  A URL/host qualifier ("jina_reader_scrape (example.gov/not-found)") is a page
 *  address, not a result, and is never negative. */
export function isNegativeSourceToken(token: string): boolean {
  const m = token.match(/\(([^()]*)\)\s*$/);
  if (!m) return false;
  const body = m[1].trim();
  if (!body || qualifierHost(body)) return false;
  if (POSITIVE_COUNT_IN_QUALIFIER_RE.test(body)) return false;
  return NEGATIVE_QUALIFIER_BODY_RE.test(body);
}

const stripQualifier = (token: string): string => token.replace(/\s*\([^()]*\)\s*$/, "").trim();

/** Drop negative-result tokens from a set of source labels (compound labels, several
 *  labels, or metadata labels alike). Identity when nothing is negative or the kill
 *  switch is on; when EVERY token is negative, returns the single head token. */
export function sanitizeSourceLabelsForEvidence(labels: readonly string[]): string[] {
  const list = [...labels];
  if (negativeSourceQualifierRuleDisabled()) return list;
  const perLabel = list.map((l) => (typeof l === "string" && l ? splitSourceTopLevel(l) : []));
  const anyNegative = perLabel.some((tokens) => tokens.some(isNegativeSourceToken));
  if (!anyNegative) return list;
  const anyPositive = perLabel.some((tokens) => tokens.some((t) => !isNegativeSourceToken(t)));
  if (!anyPositive) {
    const head = perLabel.flat().map(stripQualifier).find(Boolean);
    return head ? [head] : list;
  }
  const out: string[] = [];
  list.forEach((original, i) => {
    const tokens = perLabel[i];
    if (!tokens.length) { out.push(original); return; }
    if (!tokens.some(isNegativeSourceToken)) { out.push(original); return; }
    const kept = tokens.filter((t) => !isNegativeSourceToken(t));
    if (kept.length) out.push(kept.join(" + "));
  });
  return out;
}

export function sanitizeSourceLabelForEvidence(label: string): string {
  if (typeof label !== "string" || !label) return label;
  const [only] = sanitizeSourceLabelsForEvidence([label]);
  return only ?? label;
}

/** /health self-test: the rule engages on the measured production shapes and
 *  leaves positive observations alone. Pure. PRESENCE of the key proves the build. */
export function negativeSourceQualifierSelfTest(): { ok: boolean; detail: string } {
  if (negativeSourceQualifierRuleDisabled()) {
    return { ok: true, detail: "LEGACY via NEGATIVE_QUALIFIER_CLASS_DISABLED" };
  }
  const cases: Array<[string[], string[]]> = [
    [["ip_intel + shodan_internetdb (404) + oathnet_stealer_search (0 hits)"], ["ip_intel"]],
    [["ip_intel + hackertarget (no PTR)"], ["ip_intel"]],
    [["shodan_internetdb (404) + oathnet_stealer_search (0 hits)"], ["shodan_internetdb"]],
    [["serus_darkweb_scan (iMesh 2013 breach on user@example.test) + ip_intel"], ["serus_darkweb_scan (iMesh 2013 breach on user@example.test) + ip_intel"]],
    [["ip_intel + oathnet_lookup (0.92 match)"], ["ip_intel + oathnet_lookup (0.92 match)"]],
  ];
  const wrong = cases
    .filter(([input, want]) => JSON.stringify(sanitizeSourceLabelsForEvidence(input)) !== JSON.stringify(want))
    .map(([input]) => input.join(" | "));
  return wrong.length
    ? { ok: false, detail: `mis-sanitized: ${wrong.join(" ;; ")}` }
    : {
      ok: true,
      detail: "tokens qualified (0 hits)/(404)/(no PTR)/(circuit-broken)/(not completed) contribute no source class; an all-negative label keeps one head token",
    };
}

// Slash/slug-style breach provider labels are common in recorded artifacts
// ("breach_data/memory", "breach_check/fling_com", "username_sweep/breach_data",
// "serus_darkweb_scan (reveal:true)"). Classify them as breach BEFORE the generic
// public-record / news free-text aliases, so a mixed "breach_check/oathnet/serus"
// source can't be upgraded to public_record.
const BREACH_SLUG_RE =
  /(?:^|[/+|,;\s])(?:breach(?:[_-]?(?:check|data|exposure))?|leakcheck|hibp|serus[_-]?darkweb[_-]?scan|deepfind[_-]?(?:email[_-]?breach|dark[_-]?web[_-]?link|ransomware[_-]?exposure)|stolentax[_-]?footprint)(?:$|[/+|,;\s])/i;

// ── Origin identity vs source reliability (PR: source classification by origin) ──
//
// ORIGIN INDEPENDENCE and SOURCE RELIABILITY are two different questions and
// this module deliberately keeps them on separate axes:
//   - origin identity  = WHERE the content came from (a hostname: asec.ahnlab.com,
//     x.com). Used for INDEPENDENCE counting (countIndependentClasses below) so
//     the same origin reached through different tools/wrappers, or on two
//     different pages, never manufactures corroboration.
//   - source reliability = WHAT KIND of evidence it is (a SourceClass: breach,
//     independent_public, social_profile_active, …). Used for confidence CAPS.
// A new hostname is never, by itself, a new trustworthy corroboration class —
// only origins EXPLICITLY mapped below get a reliability override; every other
// origin "fails conservatively" through to the existing tool-slug/free-text
// classification unchanged.
//
// THE DEFECT THIS CLOSES. classifySource's slug fast path strips a trailing
// parenthetical qualifier BEFORE classifying, so "socialfetch_web_read
// (asec.ahnlab.com/en/94918)" and "socialfetch_web_read (x.com/DarkWebInformer/…)"
// both reduced to the bare tool slug and classified identically as
// social_profile_active — a security vendor's published threat report read the
// same as viewing an active social media profile, purely because a generic
// web-read tool fetched both.

/** Extract a normalized origin (hostname) from a URL-bearing parenthetical
 *  qualifier at the END of a source string, e.g. "socialfetch_web_read
 *  (asec.ahnlab.com/en/94918)" -> "asec.ahnlab.com". Returns null when there is
 *  no trailing parenthetical, or its content is not a URL / bare hostname —
 *  e.g. "socialfetch_lookup (instagram)" or "serus_darkweb_scan (reveal:true)"
 *  both -> null, which is what PRESERVES today's tool-slug classification for
 *  those shapes (a required behavior, not an oversight). */
function extractOriginId(source: string): string | null {
  const match = source.match(/\(([^)]*)\)\s*$/);
  if (!match) return null;
  return qualifierHost(match[1]);
}

/** The normalized host a parenthetical qualifier's content names, or null when
 *  it is not a URL / bare hostname. */
function qualifierHost(content: string): string | null {
  const inner = content.trim();
  if (!inner) return null;
  const withScheme = /^https?:\/\//i.test(inner) ? inner : `https://${inner}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null; // not a parseable URL/host — e.g. "reveal:true" (invalid port)
  }
  // Same shape as BARE_DOMAIN_RE further down this file: at least one
  // dot-separated label plus an alphabetic TLD of 2+ chars. Rejects bare
  // words ("instagram"), IP addresses, and junk that happened to parse as a
  // URL host without looking like a real domain.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) return null;
  return host.replace(/^www\./, "");
}

/** Explicit ORIGIN -> SourceClass overrides, consulted BEFORE the tool-slug
 *  fallback in classifySource. Hand-curated and deliberately small: an origin
 *  NOT listed here is UNMAPPED and falls straight through to today's
 *  classification (the "fail conservatively" requirement) — this map only
 *  ever RAISES precision for origins someone has actually vetted, it never
 *  invents a class from an unrecognized hostname. */
const ORIGIN_CLASS_MAP: Readonly<Record<string, SourceClass>> = {
  // AhnLab ASEC — a security vendor's published threat research. Distinct in
  // kind from an active social-media profile view, even when both are
  // fetched by the same generic web-read tool.
  "asec.ahnlab.com": "independent_public",
};

// ── Authoritative hosts: law-enforcement / court .gov sites and news outlets ──
//
// Production 2026-10-01: a finding resting on a federal wanted notice, a DOJ
// release and ~20 news reports sat at 45–50 because none of those sources had a
// class. "Agency notice (fbi.gov/…)" and "Regional Paper (paper.example)" carry
// no keyword the label regexes know, so they fell to `unknown` (cap 50), while
// "Some News (…)" — the same kind of source — reached `news` only because the
// outlet happens to have "news" in its name. artifact_hygiene_test.ts recorded
// the same gap from the other side: the signal is in the URL HOST, and the
// label path cannot see it.
//
// These rules read only the host of a trailing URL/hostname qualifier
// (extractOriginId). Both lists are hand-curated, the same discipline as
// ORIGIN_CLASS_MAP: an unlisted host changes nothing. `.gov` is used as the
// authority signal because registration is restricted to US government bodies;
// `.us` and `.org` are not, so they are deliberately absent.
//
// They apply to (a) a page a FETCH tool actually read and (b) a free-text label
// whose own class is no stronger than a page observation. They never apply to
// a search/summary tool — "minimax_web_search (justice.gov/…)" is a search
// snippet that cites the host, not a read of it, and stays ai_summary — nor to a
// breach, broker, sweep, archive or shared-host label. A fetched news page is
// classed `news`, so the existing #17 rule (a name from news alone is a lead,
// cap 55) now reaches it too; it used to escape as `independent_public` (75).
//
// Kill switch, read at call time: SOURCE_ORIGIN_RULES_DISABLED=true.

/** Federal law-enforcement and court hosts. A subdomain matches its parent
 *  (`cand.uscourts.gov`, `oig.justice.gov`). */
const LAW_ENFORCEMENT_COURT_HOSTS: readonly string[] = [
  "fbi.gov", "ic3.gov", "justice.gov", "usdoj.gov", "ojp.gov", "bop.gov",
  "usmarshals.gov", "dea.gov", "atf.gov", "ice.gov", "secretservice.gov",
  "uscourts.gov", "supremecourt.gov",
];

/** A state or local `.gov` host whose name says it is a court, judiciary,
 *  sheriff or police body (`courts.ca.gov`, `nycourts.gov`). */
const GOV_LAW_LABEL_RE = /(?:court|judiciary|sheriff|police)/;

/** News outlets: wire services, national titles, and large regional papers and
 *  broadcast stations. A subdomain matches its parent. */
const NEWS_HOSTS: readonly string[] = [
  // wires and national
  "apnews.com", "reuters.com", "upi.com", "nytimes.com", "washingtonpost.com",
  "wsj.com", "usatoday.com", "latimes.com", "npr.org", "cnn.com", "nbcnews.com",
  "cbsnews.com", "abcnews.go.com", "foxnews.com", "nypost.com", "newsweek.com",
  "time.com", "politico.com", "axios.com", "bloomberg.com", "theguardian.com",
  "bbc.com", "bbc.co.uk", "theatlantic.com", "propublica.org", "thehill.com",
  // regional papers
  "sfchronicle.com", "sfgate.com", "mercurynews.com", "eastbaytimes.com",
  "sacbee.com", "fresnobee.com", "modbee.com", "ocregister.com", "sandiegouniontribune.com",
  "chicagotribune.com", "suntimes.com", "bostonglobe.com", "miamiherald.com",
  "dallasnews.com", "houstonchronicle.com", "expressnews.com", "statesman.com",
  "seattletimes.com", "oregonlive.com", "startribune.com", "denverpost.com",
  "azcentral.com", "reviewjournal.com", "sltrib.com", "ajc.com", "inquirer.com",
  "baltimoresun.com", "courant.com", "nj.com", "newsday.com", "cleveland.com",
  "freep.com", "detroitnews.com", "jsonline.com", "indystar.com", "tennessean.com",
  "courier-journal.com", "cincinnati.com", "dispatch.com", "post-gazette.com",
  "tampabay.com", "orlandosentinel.com", "sun-sentinel.com", "kansascity.com",
  "star-telegram.com", "charlotteobserver.com", "newsobserver.com", "nola.com",
  "al.com", "mlive.com", "masslive.com", "pennlive.com", "stltoday.com",
  // broadcast
  // Measured 2026-10-15 (Caraotta): six rows cited this Placerville outlet.
  "mtdemocrat.com",
  "kcra.com", "kron4.com", "ktvu.com", "abc7news.com", "nbcbayarea.com",
  "abc7.com", "nbclosangeles.com", "ktla.com", "abc7ny.com", "nbcnewyork.com",
  "abc7chicago.com", "nbcchicago.com", "6abc.com", "fox5ny.com", "wral.com",
];

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The class an authoritative host implies, or null for any host not listed. */
export function classifyOriginHost(host: string): SourceClass | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (hostMatches(h, LAW_ENFORCEMENT_COURT_HOSTS)) return "court_record";
  if (h.endsWith(".gov") && GOV_LAW_LABEL_RE.test(h.slice(0, -4))) return "court_record";
  if (hostMatches(h, NEWS_HOSTS)) return "news";
  return null;
}

/** Tools that READ the page at the URL they are given (as opposed to searching
 *  for it or summarising results that cite it). */
const PAGE_FETCH_TOOLS: ReadonlySet<string> = new Set([
  "jina_reader_scrape",
  "exa_get_contents",
  "minimax_extract",
  "socialfetch_web_read",
]);

/** Label classes an authoritative host may replace: no stronger than a page
 *  observation, and not a discovery, breach, broker or archive signal. */
const HOST_REPLACEABLE: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "unknown",
  "news",
  "court_record",
  "independent_public",
]);

function readEnvSafe(key: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);
  } catch {
    return undefined;
  }
}

// ── Breach-material origin (E1) ──────────────────────────────────────────────
//
// A page-fetch tool reading a user-supplied breach export labels its rows
// "jina_reader_scrape (FloeIntel breach PDF)". The slug strip below discards the
// parenthetical, so the row classified as `independent_public` and escaped the
// breach cap (60): measured 75 on production thread 7a2968e1. The parenthetical
// IS the provenance. Only ever LOWERS a cap (class becomes `breach`).
// Lookarounds, not \b: filenames use underscores ("FloeIntel_Breach_Search.pdf").
const BREACH_ORIGIN_QUALIFIER_RE =
  /\([^)]*(?<![a-z])(?:breach(?:es|ed)?|leaked?|stealer[ _-]?logs?)(?![a-z])[^)]*(?<![a-z])(?:pdf|file|dump|export|attachment|csv|spreadsheet|compilation|database|list)(?![a-z])[^)]*\)\s*$/i;

export function breachOriginCapDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("BREACH_ORIGIN_CAP_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export function isBreachOriginLabel(label: string): boolean {
  return !breachOriginCapDisabled() && BREACH_ORIGIN_QUALIFIER_RE.test(label);
}

/** /health self-test for the E1 rule. */
export function breachOriginCapSelfTest(): { ok: boolean; detail: string } {
  if (breachOriginCapDisabled()) return { ok: true, detail: "LEGACY via BREACH_ORIGIN_CAP_DISABLED" };
  const breachy = ["jina_reader_scrape (FloeIntel breach PDF)", "user_supplied (FloeIntel_Breach_Search.pdf)"];
  const clean = ["jina_reader_scrape (https://www.fbi.gov/wanted/example)", "exa_search (athletics roster)"];
  const wrong = [
    ...breachy.filter((s) => classifySource(s) !== "breach"),
    ...clean.filter((s) => classifySource(s) === "breach"),
  ];
  return wrong.length
    ? { ok: false, detail: `misclassified: ${wrong.join(" | ")}` }
    : { ok: true, detail: "breach-material qualifier (pdf/file/dump/export…) -> breach class; cap 60 applies" };
}

// ── Archived pages read by a page-fetch tool ────────────────────────────────
//
// Measured 2026-10-15 (Caraotta): "socialfetch_web_read (INEDC/Placerville NewsWire
// archived)" and "socialfetch_web_read (Wayback Machine archived copy)" classified as
// `social_profile_active` — the generic web reader's slug class — so an archived news
// article counted as a live social-profile observation, including toward the
// cross-platform social-cluster rule. It is archive evidence: a captured copy of a
// page at a past date. `archive` caps at 70, the same number, so no confidence rises;
// only the KIND of evidence is corrected. Scoped to page-fetch tools (they read the
// page the qualifier names) and to an explicit archive qualifier — the word
// archived/Wayback or a web.archive.org / archive.today / archive.ph URL.
// Kill switch ARCHIVE_ORIGIN_RULE_DISABLED=true restores the slug class.
const ARCHIVE_QUALIFIER_RE = /\b(archiv(?:ed|e)|wayback)\b|web\.archive\.org|archive\.(?:today|ph|is|org)/i;

export function archiveOriginRuleDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("ARCHIVE_ORIGIN_RULE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export function isArchivedPageFetch(label: string): boolean {
  if (archiveOriginRuleDisabled()) return false;
  const m = label.match(/^\s*([a-z0-9_]+)\s*\(([^)]*)\)\s*$/i);
  if (!m) return false;
  return PAGE_FETCH_TOOLS.has(m[1].toLowerCase()) && ARCHIVE_QUALIFIER_RE.test(m[2]);
}

/** /health → checks.archive_origin_rule. Pure; presence proves this build. */
export function archiveOriginRuleSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "ARCHIVE_ORIGIN_RULE_DISABLED";
  if (archiveOriginRuleDisabled()) return { ok: true, switch: `${sw}=true`, detail: "LEGACY: archived page reads keep the tool's slug class" };
  const cases: Array<[string, SourceClass]> = [
    ["socialfetch_web_read (Wayback Machine archived copy)", "archive"],
    ["socialfetch_web_read (web.archive.org/web/2025/https://inedc.com/x)", "archive"],
    ["socialfetch_web_read (instagram.com/someone)", "social_profile_active"],
    ["exa_search (archived)", "ai_summary"],
    ["jina_reader_scrape (mtdemocrat.com/news/x)", "news"],
  ];
  const wrong = cases.filter(([l, want]) => classifySource(l) !== want).map(([l, want]) => `${l} -> ${classifySource(l)} (want ${want})`);
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : { ok: true, switch: `${sw}=false`, detail: "an archived copy read by a page-fetch tool is archive evidence (cap 70, unchanged), never a live social-profile view" };
}

export function sourceOriginRulesDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("SOURCE_ORIGIN_RULES_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** Classify ONE source token (internal slug or a single free-text label) into a
 *  single SourceClass. Returns "unknown" only when nothing matches.
 *
 *  Order is load-bearing:
 *   0. origin identity (ORIGIN_CLASS_MAP), BEFORE slug stripping — see above;
 *   1. internal-slug fast path (TOOL_CLASS, split-infra) — post-#56 contract;
 *   2. shared-host / reverse-IP free-text → infra_shared_host (#56 guard);
 *   3. #56's court / news free-text regexes (keep their exact behavior);
 *   4. #16's richer free-text provider regexes (gov/registry/directory/etc.);
 *   5. #16's coarse infra free-text → "infra" (only for free-text, never slugs).
 *
 *  `classifySource` below runs this and then applies the authoritative-host
 *  rules on top. */
function classifySourceByLabel(toolOrSource: string | null | undefined): SourceClass {
  // TYPE guard, not just a falsy guard. The declared parameter type is a lie at
  // runtime: `metadata` reaches here from a `z.record(z.unknown())` blob the
  // model authors, so an array, object or number arrives truthy and then
  // `.toLowerCase()` below throws `toolOrSource.toLowerCase is not a function`,
  // which fails the WHOLE record_artifacts batch.
  //
  // #463 fixed the two routes in tool-registry.ts by type-guarding at the CALL
  // SITES. That was necessary but not sufficient: the crash recurred in
  // production on 2026-08-16 03:59, after #463 was live, because six other call
  // sites still hand this function unvalidated values — confidence.ts:332 in
  // particular reads model-authored metadata labels. Guarding the boundary is
  // what actually closes the class.
  //
  // Fails to "unknown", which is the conservative direction: an unclassifiable
  // source grants no evidence class and therefore no cap increase.
  if (typeof toolOrSource !== "string") return "unknown";
  if (!toolOrSource) return "unknown";

  // Origin identity, BEFORE the slug strip below. Only fires when (a) the
  // parenthetical is a real URL/hostname (a bare word like "instagram" or a
  // non-URL qualifier like "reveal:true" -> extractOriginId returns null, so
  // behavior for those is UNCHANGED) AND (b) that origin is explicitly
  // mapped. An unmapped origin — including one nobody has vetted yet — falls
  // straight through to the tool-slug fast path below, unchanged.
  const originId = extractOriginId(toolOrSource);
  if (originId && ORIGIN_CLASS_MAP[originId]) return ORIGIN_CLASS_MAP[originId];

  // E1: a breach-material qualifier is provenance, not decoration.
  if (isBreachOriginLabel(toolOrSource)) return "breach";

  // An ARCHIVED copy read by a page-fetch tool is archive evidence, not a live
  // social-profile view (lib note at isArchivedPageFetch).
  if (isArchivedPageFetch(toolOrSource)) return "archive";

  // Internal-slug fast path: strip a trailing parenthetical qualifier
  // ("socialfetch_lookup (instagram)" → "socialfetch_lookup") so the slug lookup
  // still hits — without this, breach/passive-social hits leaked to unknown.
  const slug = toolOrSource.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (TOOL_CLASS[slug]) return TOOL_CLASS[slug];

  // Slash/slug breach labels classify as breach before the public-record aliases
  // below, so a mixed breach source can't launder up to public_record.
  if (BREACH_SLUG_RE.test(slug)) return "breach";

  // Reverse-IP / shared-host lookups describe co-tenants on a shared/CDN IP —
  // they never prove ownership and must not corroborate identity (#56). Matched
  // on the raw-ish slug form so "hackertarget/reverseiplookup" is caught.
  if (/reverse[\s._-]?ip|reverseiplookup|shared[\s._-]?host|co[\s._-]?hosted/.test(slug)) {
    return "infra_shared_host";
  }

  // Free-text provider-label path.
  const s = normalizeSourceLabel(toolOrSource);

  // ── #56's court / news free-text (preserve exact behavior + tests) ──
  // pacer_docket → court_record; nytimes_article → news; etc.
  if (/court|docket|legal_record|justice|cdc|cdcr|bop|pacer/.test(slug)) return "court_record";

  // Government / official public records (highest authority) — #16.
  if (/\b(secretary of state|sec of state|ca sos|cal sos|bizfile|business entity search|business search|statement of information)\b/.test(s)) {
    return "government_business_registry";
  }
  if (/\bbusiness licen[cs]e\b|\b(city|county|municipal) licen[cs]e\b/.test(s)) {
    return "government_business_license";
  }
  if (/\b(county assessor|assessor(?:'s)? office|parcel|apn|county recorder|recorder(?:'s)? office|grant deed|quitclaim|register of deeds|deed of trust)\b/.test(s)) {
    return "government_property_record";
  }
  if (/\b(court|docket|pacer|justice|cdc|cdcr|\bbop\b|case no|superior court|county clerk)\b/.test(s)) {
    return "court_record";
  }

  // Directories / listings / profiles — #16.
  if (/\b(dnb|d b|dun and bradstreet|d and b|dun bradstreet|d b credibility|business directory|yellow ?pages|manta|bizapedia|opencorporates|corporationwiki)\b/.test(s)) {
    return "business_directory";
  }
  if (/\b(redfin|zillow|realtor\.?com|realtor|trulia|homes\.?com|movoto|compass\.com|loopnet|homesnap)\b/.test(s)) {
    return "real_estate_listing";
  }
  if (/\b(property records? search|property record|property records|real property|tax assessor|propertyshark|property data|property report)\b/.test(s)) {
    return "property_aggregator";
  }
  if (/\b(linkedin|xing|zoominfo|rocketreach|apollo\.io)\b/.test(s)) {
    return "professional_profile";
  }
  if (/\b(houzz|yelp|angi|angie'?s list|google reviews?|trustpilot|bbb|better business bureau)\b/.test(s)) {
    return "social_review";
  }

  // Public-record aggregators (people-search / OSINT property+person providers) — #16.
  if (/\b(whitepages|thatsthem|fastpeoplesearch|truepeoplesearch|beenverified|radaris|spokeo|intelius|peoplefinders|public records?)\b/.test(s)) {
    return "public_record";
  }

  // Infra free-text (whois/dns/cert/asn/reputation) — #16 coarse "infra".
  // NOTE: only reachable for FREE-TEXT labels; the split-infra slugs above
  // already short-circuited via TOOL_CLASS, so #56's per-sub-class behavior is
  // never weakened by these.
  if (/\b(whois|registrar|registration)\b/.test(s)) return "infra";
  if (/\b(dns|mx record|txt record|a record|aaaa record|cname|name ?server)\b/.test(s)) return "infra";
  if (/\b(certificate transparency|crt\.sh|ssl cert|tls cert|x509)\b/.test(s)) return "infra";
  if (/\b(shodan|censys|asn|reverse dns|rdns|ipinfo|ip intel|geolocation)\b/.test(s)) return "infra";
  if (/\b(virustotal|urlscan|malwarebytes|safe browsing|reputation|phishing|malware)\b/.test(s)) return "infra";

  // Breach / leak free-text — #16.
  // OathNet is a breach/leaked-data aggregator (TOOL_CLASS.oathnet_lookup = "breach",
  // catalog "leaked-data … v2 breach search"). It was previously listed in the
  // public_record people-search regex above and — because that branch runs first —
  // any "oathnet"-containing free-text provenance mis-classified as public_record
  // (cap 75) instead of breach (cap 60). Classify it as breach here. (The `oathnet`
  // token alone is correct: the clean `oathnet_lookup` slug is already resolved by
  // TOOL_CLASS, and inside a compound free-text string it is reached via splitting —
  // adding `oathnet_lookup` to this regex would instead make the whole compound
  // match here and suppress the split that the two-breach nudge depends on.)
  if (/\b(breach|hibp|have i been pwned|leak|paste|combolist|stealer log|dehashed|oathnet|peopledatalabs|pdl)\b/.test(s)) return "breach";

  // Archive — #16.
  if (/\b(wayback|web archive|archive\.org|archive\.is|archive\.today|cachedview)\b/.test(s)) return "archive";

  // News / media — #16 (superset of #56's `/news|times|.../`).
  if (/\b(news|times|herald|tribune|press|gazette|magazine|article|reuters|associated press|\bap\b)\b/.test(s)) return "news";

  // Generic web search (discovery, not verification) — #16.
  if (/\b(web search|google(?: search)?|bing|duckduckgo|ddg|search engine|exa|minimax|gemini(?: deep dork)?|deep dork|serp)\b/.test(s)) {
    return "web_search";
  }

  return "unknown";
}

/** Classify ONE source token (internal slug or a single free-text label) into a
 *  single SourceClass. Returns "unknown" only when nothing matches.
 *
 *  The label classification above, then the authoritative-host rules: a page a
 *  fetch tool read, or a weak free-text label, takes the class its host implies.
 *  See LAW_ENFORCEMENT_COURT_HOSTS for what may and may not be replaced. */
export function classifySource(toolOrSource: string | null | undefined): SourceClass {
  const byLabel = classifySourceByLabel(toolOrSource);
  if (typeof toolOrSource !== "string" || !toolOrSource) return byLabel;
  const originId = extractOriginId(toolOrSource);
  if (!originId) return byLabel;
  const byHost = classifyOriginHost(originId);
  if (!byHost || byHost === byLabel || sourceOriginRulesDisabled()) return byLabel;
  const head = toolOrSource.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const slug = head.toLowerCase();
  if (TOOL_CLASS[slug]) return PAGE_FETCH_TOOLS.has(slug) ? byHost : byLabel;
  // "A (x.example) + B (fbi.gov/…)" is two sources: the host names only the last.
  if (splitSourceLabels(head).length > 1) return byLabel;
  return HOST_REPLACEABLE.has(byLabel) ? byHost : byLabel;
}

/** /health self-test: the rules engage for a fetched official page and a news
 *  outlet's label, and leave search snippets and unlisted hosts alone. */
export function sourceOriginRulesSelfTest(): { ok: boolean; detail: string } {
  if (sourceOriginRulesDisabled()) {
    return { ok: true, detail: "LEGACY via SOURCE_ORIGIN_RULES_DISABLED" };
  }
  const cases: Array<[string, SourceClass]> = [
    ["jina_reader_scrape (https://www.fbi.gov/wanted/example)", "court_record"],
    ["Agency notice (fbi.gov/wanted/example)", "court_record"],
    ["State portal (courts.example-state.gov)", "court_record"],
    ["Daily (latimes.com/example)", "news"],
    ["minimax_web_search (justice.gov/usao/pr/example)", "ai_summary"],
    ["Example Blog (unvetted-example.org/post)", "unknown"],
    ["breach_check (nytimes.com)", "breach"],
  ];
  const wrong = cases.filter(([s, want]) => classifySource(s) !== want).map(([s]) => s);
  return wrong.length
    ? { ok: false, detail: `misclassified: ${wrong.join(" | ")}` }
    : {
      ok: true,
      detail: `${LAW_ENFORCEMENT_COURT_HOSTS.length} law-enforcement/court + .gov court/police hosts -> court_record, ` +
        `${NEWS_HOSTS.length} news hosts -> news; search tools unchanged`,
    };
}

/** Classify ONE source token AND capture its origin identity in one pass, for
 *  callers that count INDEPENDENT corroboration rather than reliability alone.
 *
 *  `countIndependentClasses` takes these objects directly and dedups on the
 *  origin when one is present, so the same hostname reached through two
 *  different tools/wrappers — or on two different pages of the same site —
 *  collapses to ONE independent source instead of manufacturing corroboration.
 *  `originId` is null for every source without a URL-bearing trailing
 *  parenthetical (the overwhelming majority); those keep dedup-by-class
 *  exactly as before. */
export function classifySourceWithOrigin(
  toolOrSource: string | null | undefined,
): { originId: string | null; sourceClass: SourceClass } {
  return {
    originId: typeof toolOrSource === "string" && toolOrSource
      ? extractOriginId(toolOrSource)
      : null,
    sourceClass: classifySource(toolOrSource),
  };
}

/** Classify a source string into ALL of its source classes. Splits mixed labels
 *  ("D&B / Redfin" → ["business_directory","real_estate_listing"]) and returns
 *  [] for wrapper labels (so the caller falls back to metadata.sources). */
export function classifySourceLabel(rawLabel: string | null | undefined): SourceClass[] {
  // Negative-result tokens contribute no class (see sanitizeSourceLabelsForEvidence).
  const label = typeof rawLabel === "string" ? sanitizeSourceLabelForEvidence(rawLabel) : rawLabel;
  if (!label || !label.trim()) return [];
  if (isWrapperLabel(label)) return [];
  const parts = splitSourceLabels(label);
  const tokens = parts.length ? parts : [label.trim()];
  const out = new Set<SourceClass>();
  for (const t of tokens) out.add(classifySource(t));
  const known = [...out].filter((c) => c !== "unknown");
  if (known.length) return known;
  // Splitting may have broken a multi-word provider ("Dun and Bradstreet" →
  // ["Dun","Bradstreet"]). Try the whole label once before giving up.
  const whole = classifySource(label);
  return whole !== "unknown" ? [whole] : ["unknown"];
}

/** Authoritative classification for a recorded artifact: top-level `source`
 *  plus `metadata.sources`. Wrapper labels ("Multiple sources") contribute
 *  nothing themselves; their members come from metadata.sources. */
export function classifySourceInput(input: {
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}): SourceClass[] {
  const out = new Set<SourceClass>();
  for (const c of classifySourceLabel(input.source)) out.add(c);
  const metaSources = input.metadata?.sources;
  if (Array.isArray(metaSources)) {
    for (const ms of metaSources) {
      if (typeof ms === "string") {
        for (const c of classifySourceLabel(ms)) out.add(c);
      }
    }
  }
  const known = [...out].filter((c) => c !== "unknown");
  if (known.length) return known;
  return out.size ? [...out] : ["unknown"];
}

// Infrastructure sub-classes (post-#56). These count as independent
// perspectives when corroborating an INFRASTRUCTURE claim (domain exists,
// resolves, has footprint) — but never when corroborating identity/ownership.
const INFRA_SUBCLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "infra_registry",
  "infra_dns",
  "infra_scan",
  "infra_reputation",
  "infra_passive",
  "infra_shared_host",
  "infra",
]);

export function isInfraClass(c: SourceClass): boolean {
  return INFRA_SUBCLASSES.has(c);
}

/** Classes that do NOT, by themselves, constitute independent corroboration of
 *  an identity/association claim (discovery + low-trust aggregators + single
 *  AI summaries). Used by the status layer to count *independent* source
 *  classes. (infra_shared_host is also non-corroborating — see #56.) */
export const NON_CORROBORATING_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "unknown",
  "web_search",
  "ai_summary",
  "username_sweep",
  "social_profile_passive",
  "social_review",
  "infra_shared_host",
  // Threat-intel (org-was-ransomwared) does not independently corroborate that a
  // PERSON is the subject — it must not count toward the ≥2-class confirm path.
  "threat_intel",
]);

/** One entry for `countIndependentClasses`: either a bare class (deduped by
 *  class — the historical behavior every pre-existing caller relies on) or a
 *  class carrying the origin it came from (deduped by origin — see
 *  `classifySourceWithOrigin`). */
export type IndependentSourceEntry =
  | SourceClass
  | { originId: string | null; sourceClass: SourceClass };

/** Count distinct source classes that can independently corroborate.
 *
 *  Entries carrying an `originId` are deduped BY ORIGIN rather than by class:
 *  two reads of the same hostname through different tools are ONE source,
 *  however each one happened to classify. That asymmetry is the point — an
 *  unmapped origin (one nobody has vetted into ORIGIN_CLASS_MAP) still must not
 *  corroborate itself just because two different tools fetched it and resolved
 *  to two different default classes.
 *
 *  Direction of the change is deliberately DEFLATIONARY: origin tracking may
 *  only ever collapse sources together, never split one apart into two. Hence
 *  `covered` — a class already represented by an origin-keyed entry does not
 *  also get counted through an origin-less entry, which would let the same
 *  site counted once by hostname reappear as a second "class" and inflate
 *  corroboration. Plain `SourceClass` input (no origin objects at all) is
 *  byte-identical to the pre-origin behavior.
 *
 *  NON_CORROBORATING_CLASSES is filtered FIRST in both cases, so a
 *  non-corroborating class is excluded no matter which origin produced it. */
export function countIndependentClasses(
  classes: readonly IndependentSourceEntry[],
): number {
  const keys = new Set<string>();
  const covered = new Set<SourceClass>();
  const originless: SourceClass[] = [];

  for (const entry of classes) {
    const sourceClass = typeof entry === "string" ? entry : entry.sourceClass;
    if (NON_CORROBORATING_CLASSES.has(sourceClass)) continue;
    const originId = typeof entry === "string" ? null : entry.originId;
    if (originId) {
      keys.add(`origin:${originId}`);
      covered.add(sourceClass);
    } else {
      originless.push(sourceClass);
    }
  }
  // Second pass: `covered` must be complete before any origin-less entry is
  // judged, otherwise the answer would depend on input ORDER.
  for (const sourceClass of originless) {
    if (covered.has(sourceClass)) continue;
    keys.add(`class:${sourceClass}`);
  }
  return keys.size;
}

/** Attribute an ALREADY-DECIDED set of source classes to the origins they came
 *  from, so a downstream independence count honours the origin boundary without
 *  re-deciding what the classes are.
 *
 *  WHY THIS EXISTS. `buildFindingRow` has two authority paths over the same
 *  evidence: `computeAxes` takes the origin-aware corroboration count, while the
 *  PERSISTED status goes through the cap engine and `deriveStatus`, which
 *  recounted `cap.source_classes` with no origin information. A same-origin pair
 *  read by two tools that classify differently — `socialfetch_web_read
 *  (x.com/…)` (social_profile_active) and `jina_reader_scrape (x.com/…)`
 *  (independent_public) — counted 1 in the first path and 2 in the second, and
 *  the row persisted as `needs_corroboration` with two authoritative source
 *  categories instead of the single-source `observed`.
 *
 *  DELIBERATELY NOT A CLAMP. The cap engine can legitimately derive MORE classes
 *  than there are source labels — #497's breach-split recovers infra classes from
 *  one joined label, and breach metadata appends a class with no label at all —
 *  so ceiling-ing the cap count by the per-label count would re-break #497.
 *  Instead each cap class keeps its identity and merely gains the origin that
 *  produced it.
 *
 *  STRICTLY DEFLATIONARY, by construction: `capClasses` is already unique, each
 *  one yields exactly one entry, and the only possible effect is two classes
 *  sharing an origin key and collapsing. The count can never rise. A class is
 *  attributed only when the sources producing it name EXACTLY ONE distinct
 *  origin; a class produced from several origins, or from none, stays a bare
 *  class and is counted exactly as it is today. */
export function attributeClassesToOrigins(
  capClasses: readonly SourceClass[],
  sources: readonly string[],
): IndependentSourceEntry[] {
  const originsByClass = new Map<SourceClass, Set<string>>();
  for (const source of sources) {
    const { originId, sourceClass } = classifySourceWithOrigin(source);
    if (!originId) continue;
    let set = originsByClass.get(sourceClass);
    if (!set) originsByClass.set(sourceClass, (set = new Set<string>()));
    set.add(originId);
  }
  return capClasses.map((sourceClass) => {
    const origins = originsByClass.get(sourceClass);
    return origins && origins.size === 1
      ? { originId: [...origins][0], sourceClass }
      : sourceClass;
  });
}

/** Classes that are official/government public records (highest source quality). */
export const OFFICIAL_CLASSES: ReadonlySet<SourceClass> = new Set<SourceClass>([
  "government_property_record",
  "government_business_registry",
  "government_business_license",
  "court_record",
  "public_record",
  "official_profile_match",
]);

export function hasOfficialClass(classes: readonly SourceClass[]): boolean {
  return classes.some((c) => OFFICIAL_CLASSES.has(c));
}

// ── LLM-asserted unverified domain guard (minimal "option A" — #131 follow-up) ─
//
// An artifact's `source` is a free-text string the orchestrator LLM writes; nothing
// validates it. In a live case 9 PII artifacts were attributed to
// `menstoppingviolence.org` — a DV nonprofit that is NOT a wired tool and hosts no
// such data: a fabricated/misattributed citation. It still polluted the case graph,
// the export, and — worst — the tamper-evident chain-of-custody log, laundering a
// hallucination into court-defensible-looking evidence.
//
// This helper detects a `source` that names a BARE DOMAIN component which is neither
// a wired tool nor a provider the classifier recognizes — i.e. a domain the LLM
// asserted as provenance but that no tool actually fetched.
//
// CONSERVATIVE BY DESIGN: it must never flag a real tool slug
// (`oathnet_lookup`, `minimax_web_search`, …), a known provider already in the
// people-search/breach/etc. regexes (whitepages, spokeo, realtor.com, …), or a
// compound source whose every component is recognized. Only a genuinely
// unrecognized bare domain (like `menstoppingviolence.org`) trips it.
//
// This is the MINIMAL string-level guard. The full fetched-domain ledger — which
// would positively confirm a domain WAS fetched instead of inferring it from string
// recognition — is tracked as issue #131. Until then callers may pass
// `recognizedDomains` (e.g. the investigation seed domain, which whois/dns DO fetch)
// to suppress false-positives on domains the case legitimately touched.

// A single token that is *exactly* a bare domain: one or more dot-separated labels
// followed by an alphabetic TLD of 2+ chars (foo.org, a.b.co.uk). Tool slugs use
// underscores and contain no dot, so they never match this.
const BARE_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

// Catalog tool slugs. None currently contain a dot (so none can match
// BARE_DOMAIN_RE today), but a slug must never be mistaken for a fabricated domain
// if one is ever added — checked explicitly per the spec.
const CATALOG_TOOL_SLUGS: ReadonlySet<string> = new Set(
  (TOOL_CATALOG?.tools ?? []).map((t) => t.name.toLowerCase()),
);

/** A source token is "recognized" when it is a wired tool slug (incl. dotted slugs
 *  like `usphonesearch.net`), a catalog tool name, or a provider the classifier
 *  maps to a real (non-"unknown") class (realtor.com, apollo.io, archive.org…). */
function isRecognizedSourceToken(token: string): boolean {
  const t = token.toLowerCase();
  if (TOOL_CLASS[t]) return true;
  if (CATALOG_TOOL_SLUGS.has(t)) return true;
  if (classifySource(token) !== "unknown") return true;
  return false;
}

/** True when `source` contains a bare-domain component that no wired tool or known
 *  provider recognizes — i.e. a domain the orchestrator LLM asserted as provenance
 *  but that nothing actually fetched. Pass `recognizedDomains` (e.g. the seed
 *  domain, which whois/dns legitimately fetch) to whitelist trusted domains. See
 *  issue #131 for the full fetched-domain ledger that supersedes this heuristic. */
export function isLlmAssertedDomainSource(
  source: string | null | undefined,
  recognizedDomains?: Iterable<string>,
): boolean {
  const raw = (source ?? "").trim();
  if (!raw) return false;
  const recognized = new Set<string>();
  if (recognizedDomains) {
    for (const d of recognizedDomains) {
      if (typeof d === "string" && d.trim()) recognized.add(d.trim().toLowerCase());
    }
  }
  // Split on the same delimiters the cap/classifier code uses (MIXED_SOURCE_SPLIT_RE),
  // plus whitespace, so both "a+b.org" and "data from foo.org" surface their tokens.
  const tokens = raw
    .split(MIXED_SOURCE_SPLIT_RE)
    .flatMap((p) => p.split(/\s+/))
    .map((p) => p.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    if (!BARE_DOMAIN_RE.test(tok)) continue; // not a domain component — ignore
    const lower = tok.toLowerCase();
    if (recognized.has(lower)) continue; // seed / legitimately-fetched domain — trusted
    if (isRecognizedSourceToken(tok)) continue; // wired tool slug or known provider
    return true; // unrecognized bare domain → LLM-asserted, unverified provenance
  }
  return false;
}

/** Provenance marker stamped on artifacts whose source trips
 *  `isLlmAssertedDomainSource`, and substituted for the fabricated domain in the
 *  chain-of-custody log so the tamper-evident record never launders it as a real
 *  source. Kept as a shared constant so runtime + mirror stay in sync. */
export const LLM_ASSERTED_PROVENANCE = "llm_asserted_unverified" as const;
