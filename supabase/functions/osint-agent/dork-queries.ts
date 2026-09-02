/**
 * dork-queries.ts — pure helpers for the google_dorks tool.
 *
 * Three jobs, all side-effect free so they are unit-testable in isolation:
 *
 *  1. `searchUrl` / `canonicalizeDorks` — ONE encoder for every emitted URL.
 *     The hand-written dork table pairs a displayed `query` with a
 *     hand-written `url` that usually encodes only the first few terms, so
 *     clicking a dork ran a DIFFERENT search than the one on screen.
 *     Canonicalizing regenerates every `url` from its own `query`.
 *
 *  2. `resolveDorkKind` — the model-supplied `kind` is UNTRUSTED input.
 *     The domain family interpolates the seed into `site:`, `site:*.`, `%.`,
 *     certificate, secret and infrastructure templates; those are only
 *     meaningful for a hostname. A postal address arriving as kind:"domain"
 *     produced `site:79 Waverly Ave Cincinnati OH 45215` in production.
 *
 *  3. `buildAddressDorks` — the address query family: exact-address,
 *     property/parcel/assessor/auditor/recorder, deed/ownership,
 *     address+person and address+business disambiguation, public records,
 *     documents, archives and real-estate references. Deliberately contains
 *     NO domain-infrastructure, secret-exposure, admin-panel, certificate,
 *     subdomain or source-code template.
 */

import {
  flattenAddress,
  isAddressLike,
  parseUsAddress,
} from "./address.ts";

export interface Dork {
  category: string;
  query: string;
  url: string;
}

// ---- One encoder for every search URL ---------------------------------------

export type SearchEngine =
  | "google"
  | "bing"
  | "duckduckgo"
  | "yandex"
  | "crtsh"
  | "googlecache";

const ENGINES: Record<SearchEngine, { base: string; param: string }> = {
  google: { base: "https://www.google.com/search", param: "q" },
  bing: { base: "https://www.bing.com/search", param: "q" },
  duckduckgo: { base: "https://duckduckgo.com/", param: "q" },
  yandex: { base: "https://yandex.com/search/", param: "text" },
  crtsh: { base: "https://crt.sh/", param: "q" },
  googlecache: { base: "https://webcache.googleusercontent.com/search", param: "q" },
};

/**
 * Build a search URL that executes EXACTLY the query string it is given.
 * `decodeURIComponent(new URL(url).searchParams.get(param))` round-trips to
 * the displayed query — that is the contract the tests pin.
 */
export function searchUrl(engine: SearchEngine, query: string): string {
  const { base, param } = ENGINES[engine] ?? ENGINES.google;
  return `${base}?${param}=${encodeURIComponent(query)}`;
}

const HOSTNAME_ENGINE: Record<string, SearchEngine> = {
  "www.bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "yandex.com": "yandex",
  "crt.sh": "crtsh",
  "webcache.googleusercontent.com": "googlecache",
};

/**
 * Which engine an already-written dork URL points at — from its HOSTNAME, never
 * a substring of the whole URL. A whole-string `.includes()` misclassified any
 * Google URL whose QUERY happened to contain another engine's domain as text:
 * the "Cert Transparency" Google dorks embed `site:crt.sh` in their query string,
 * so `.includes("crt.sh")` matched and canonicalizeDorks rewrote a Google search
 * into an actual crt.sh lookup (wrong destination, and crt.sh's endpoint doesn't
 * understand a Google boolean query). The same shape misfires on any seed whose
 * value contains another engine's domain as a substring (e.g. an email at
 * bing.com turns its own Google dorks into Bing URLs).
 */
export function engineOfUrl(url: string): SearchEngine {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "google";
  }
  return HOSTNAME_ENGINE[hostname] ?? "google";
}

/**
 * Regenerate every dork's `url` from its own `query`, keeping the engine the
 * original URL targeted. Applied to EVERY kind, not just address — the
 * displayed-query/clickable-URL divergence was table-wide.
 */
export function canonicalizeDorks(dorks: Dork[]): Dork[] {
  return dorks.map((d) => ({ ...d, url: searchUrl(engineOfUrl(d.url), d.query) }));
}

// ---- Untrusted-kind resolution ----------------------------------------------

/**
 * RFC-1123-ish hostname: dot-separated labels, alphabetic TLD of 2+.
 * Rejects anything with whitespace, and rejects bare IPv4 (numeric TLD) —
 * an IP belongs to the `ip` family, not the domain templates.
 */
export function isHostname(seed: string | null | undefined): boolean {
  const s = (seed ?? "").trim().replace(/^\*\./, "").replace(/\.$/, "");
  if (!s || s.length > 253 || /\s/.test(s)) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) return false;
  }
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
}

export type DorkKindResolution =
  | { ok: true; kind: string; corrected?: { from: string; to: string; reason: string } }
  | {
    ok: false;
    error: "kind_mismatch";
    seed: string;
    requested_kind: string;
    reason: string;
    hint: string;
    dorks: Dork[];
  };

/**
 * Decide which query family a call may use.
 *
 * Only `domain` is gated, because only the domain family interpolates the
 * seed into host-shaped operators. A seed that is not a hostname either
 * resolves to the address family (when it is recognisably a street address)
 * or is refused outright.
 *
 * The refusal is `ok: false` on purpose. A silent `ok: true` empty result is
 * how a disabled tool once reached a chain-of-custody record as
 * "completed" — a quarantine refusal must read as a refusal.
 */
export function resolveDorkKind(seed: string, kind: string): DorkKindResolution {
  if (kind !== "domain") return { ok: true, kind };
  if (isHostname(seed)) return { ok: true, kind };
  if (isAddressLike(seed)) {
    return {
      ok: true,
      kind: "address",
      corrected: {
        from: "domain",
        to: "address",
        reason:
          "seed is a postal address, not a hostname — domain templates " +
          "(site:, site:*., %., certificate/secret/admin) would be meaningless here",
      },
    };
  }
  return {
    ok: false,
    error: "kind_mismatch",
    seed,
    requested_kind: "domain",
    reason:
      "kind:'domain' requires a valid hostname (e.g. example.com). This seed is " +
      "not a hostname, so the domain dork family was NOT generated.",
    hint:
      "Re-call google_dorks with the kind that matches the selector: " +
      "address for a street address, name for a person, email/username/phone/ip/hash/crypto_wallet otherwise.",
    dorks: [],
  };
}

// ---- Address query family ----------------------------------------------------

/**
 * Split a selector into its already-quoted phrases and its loose tokens.
 * `"79 Waverly Ave" Cincinnati "Patrick Damon"` →
 *   phrases: ["79 Waverly Ave", "Patrick Damon"], loose: ["Cincinnati"]
 *
 * This is what keeps compound selectors from being re-quoted into
 * `""79 Waverly Ave" Cincinnati "Patrick Damon""`.
 */
export function splitQuotedSeed(seed: string): { phrases: string[]; loose: string[] } {
  const phrases: string[] = [];
  const rest = (seed ?? "").replace(/"([^"]*)"/g, (_m, p: string) => {
    const v = p.trim();
    if (v) phrases.push(v);
    return " ";
  });
  const loose = rest.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  return { phrases, loose };
}

/** Quote a phrase exactly once. Any stray quote inside is dropped, never nested. */
function q(value: string): string {
  const clean = flattenAddress(value.replace(/"/g, " "));
  return clean ? `"${clean}"` : "";
}

interface AddressTerms {
  /** The exact-address expression: one quoted phrase plus any disambiguating extras. */
  exact: string;
  /** The street phrase, quoted once. */
  street: string;
  /** City/state/ZIP terms, safe to append. */
  locality: string;
  /** Extra terms carried by a compound selector (a person or business name). */
  extras: string;
  city: string;
  state: string;
  zip: string;
}

function addressTerms(seed: string): AddressTerms {
  const { phrases, loose } = splitQuotedSeed(seed);

  if (phrases.length === 0) {
    // Plain address seed — the whole value is the exact phrase. When the
    // components parse, the phrase is rebuilt from them so the punctuation the
    // analyst typed ("CINCINNATI OH, 45215") does not end up inside an exact-
    // match phrase, where a stray comma suppresses real hits.
    const flat = flattenAddress(seed);
    const p = parseUsAddress(flat);
    const locality = [p?.city ? q(p.city) : "", p?.state ?? "", p?.zip ?? ""]
      .filter(Boolean)
      .join(" ");
    return {
      exact: q(p ? `${p.street} ${p.city} ${p.state} ${p.zip}` : flat),
      street: q(p?.street ?? flat),
      locality,
      extras: "",
      city: p?.city ?? "",
      state: p?.state ?? "",
      zip: p?.zip ?? "",
    };
  }

  // Compound selector — the first quoted phrase anchors the address, the rest
  // (other phrases + loose tokens) disambiguate it.
  const anchor = phrases[0];
  const extras = [...phrases.slice(1).map(q), ...loose].filter(Boolean).join(" ");
  const p = parseUsAddress(`${anchor} ${loose.join(" ")}`);
  return {
    exact: [q(anchor), extras].filter(Boolean).join(" "),
    street: q(anchor),
    locality: [p?.city ? q(p.city) : loose.map(q).join(" "), p?.state ?? "", p?.zip ?? ""]
      .filter(Boolean)
      .join(" "),
    extras,
    city: p?.city ?? (loose[0] ?? ""),
    state: p?.state ?? "",
    zip: p?.zip ?? "",
  };
}

/**
 * The address dork family.
 *
 * Every query is a public-records / property / people-search question about a
 * physical place. None of them apply a host-shaped operator to the address.
 */
export function buildAddressDorks(seed: string): Dork[] {
  const t = addressTerms(seed);
  const dorks: Dork[] = [];
  // Dedupe on the executed URL: a compound selector can make two categories
  // produce the identical query, and the same exact-address query is emitted
  // once per alternate engine (different URL, legitimately kept).
  const seen = new Set<string>();
  const add = (category: string, query: string, engine: SearchEngine = "google") => {
    const clean = query.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const url = searchUrl(engine, clean);
    if (seen.has(url)) return;
    seen.add(url);
    dorks.push({ category, query: clean, url });
  };

  const street = t.street;
  // Street phrase + locality — the workhorse prefix for record searches.
  const sl = [street, t.locality].filter(Boolean).join(" ");

  // 1) Exact-address discovery
  add("Exact Address", t.exact);
  if (t.locality) add("Exact Address", `${street} ${t.locality}`);
  if (t.zip) add("Exact Address", `${street} ${t.zip}`);
  add("Exact Address", `intext:${street}${t.locality ? ` ${t.locality}` : ""}`);

  // 2) Property / parcel records
  add(
    "Property Records",
    `${sl} ("parcel" OR "parcel number" OR "parcel id" OR "APN" OR "property record" OR "property search")`,
  );
  add(
    "Property Records",
    `${sl} (auditor OR assessor OR recorder OR "county auditor" OR "property appraiser")`,
  );
  add("Property Records", `${sl} (assessor OR auditor OR parcel OR recorder) site:gov`);

  // 3) Ownership / deeds
  add(
    "Ownership / Deeds",
    `${sl} ("owner of record" OR "property owner" OR "owner name" OR "current owner")`,
  );
  add(
    "Ownership / Deeds",
    `${sl} (deed OR grantor OR grantee OR "warranty deed" OR "quit claim" OR "transfer of ownership")`,
  );

  // 4) Who is at the address (address + person disambiguation)
  add(
    "Residents / People",
    `${sl} ("lives at" OR "resident" OR "current resident" OR "previous resident" OR "associated with")`,
  );
  add(
    "Residents / People",
    `${street} (site:whitepages.com OR site:spokeo.com OR site:anywho.com OR site:fastpeoplesearch.com OR site:truepeoplesearch.com)`,
  );
  if (t.extras) {
    add("Address + Person", `${street} ${t.extras}`);
    add(
      "Address + Person",
      `${street} ${t.extras} (address OR resident OR owner OR property OR deed)`,
    );
  }

  // 5) Businesses registered at the address
  add(
    "Address + Business",
    `${sl} (LLC OR Inc OR "registered agent" OR "principal office" OR "business address" OR "mailing address")`,
  );
  add(
    "Address + Business",
    `${street} (site:opencorporates.com OR site:bizapedia.com OR site:manta.com OR site:bbb.org)`,
  );

  // 6) Public records
  add(
    "Public Records",
    `${sl} (lien OR foreclosure OR eviction OR judgment OR "tax lien" OR "tax delinquent" OR "sheriff sale")`,
  );
  add(
    "Public Records",
    `${sl} (permit OR "building permit" OR "code violation" OR inspection OR variance OR rezoning)`,
  );
  add(
    "Public Records",
    `${street} (site:courtlistener.com OR site:justia.com OR site:unicourt.com OR site:docketbird.com)`,
  );

  // 7) Documents
  add("Documents", `${sl} filetype:pdf`);
  add("Documents", `${sl} (filetype:xls OR filetype:xlsx OR filetype:csv)`);
  add("Documents", `${sl} (minutes OR agenda OR "staff report" OR "notice of" OR "legal notice") filetype:pdf`);

  // 8) Archives
  add("Archives", `${t.exact} (site:web.archive.org OR site:archive.is OR site:archive.ph)`);

  // 9) Real estate
  add(
    "Real Estate",
    `${street} (site:zillow.com OR site:redfin.com OR site:realtor.com OR site:trulia.com OR site:homes.com)`,
  );
  add(
    "Real Estate",
    `${sl} ("last sold" OR "sold on" OR "for sale" OR "estimated value" OR "days on market")`,
  );
  add("Real Estate", `${street} (site:loopnet.com OR site:crexi.com OR site:apartments.com OR site:rent.com)`);

  // 10) Alternate engines — same exact-address expression
  add("Alt Search Engines", t.exact, "bing");
  add("Alt Search Engines", t.exact, "duckduckgo");
  add("Alt Search Engines", t.exact, "yandex");

  return dorks;
}
