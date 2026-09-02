/**
 * address.ts — US postal-address recognition, normalization and parsing.
 *
 * Single source of truth for "is this seed a street address?" on the edge
 * runtime. Two consumers with deliberately different strictness:
 *
 *   detectSeedServer (validation.ts) uses the STRICT test — a house number,
 *     a 2-letter state and a ZIP. That decides a thread's seed kind, so a
 *     false positive would mis-route a whole investigation.
 *
 *   the google_dorks kind guard (dork-queries.ts) uses the LOOSE test — a
 *     house number plus a street suffix, ZIP optional. That decides only
 *     whether a seed may enter the domain template, where the cost of a
 *     false negative (site:"79 Waverly Ave") is far higher than the cost of
 *     a false positive (an address-family query set).
 *
 * The normalizer MUST mirror `normalizeAddressValue` in src/lib/seed.ts —
 * the client computes the same cache key and there is no shared module
 * between src/ and supabase/functions/.
 */

/** Street-type suffixes, as whole words. Kept in step with query-type-router.ts's STREET_RE. */
const STREET_SUFFIX =
  "(?:ave|avenue|st|street|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|cir|circle|" +
  "pl|place|ter|terrace|hwy|highway|pkwy|parkway|loop|trl|trail|sq|square|pike|run|row|walk|" +
  "path|xing|crossing|bnd|bend|cv|cove|holw|hollow|aly|alley|plz|plaza|blf|bluff|est|estates)";

const STREET_SUFFIX_RE = new RegExp(`\\b${STREET_SUFFIX}\\b\\.?`, "i");

/** House number at the head of the value: "79", "79A", "1600", "12-14". */
const HOUSE_NUMBER_RE = /^\d{1,6}(?:-\d{1,6})?[A-Za-z]?\b/;

/**
 * USPS two-letter state/territory/military codes. The strict matcher requires
 * one of THESE in the state position, not merely `[A-Za-z]{2}` — an unconstrained
 * 2-letter class let a plain "<house> <street> <suffix> <zip>" with no state at
 * all false-positive ("123 Main St 90210": the street suffix "St" was consumed
 * as the "state"), and let a degenerate two-token value false-positive too
 * ("5 AB CD 12345": neither "AB" nor "CD" is a real state).
 */
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "AS", "GU", "MP", "PR", "VI",
  "AA", "AE", "AP",
]);
const US_STATE_CODE_RE = "(?:" + [...US_STATE_CODES].join("|") + ")";

/**
 * STRICT: house number … <2-letter USPS state code> <ZIP>.
 *
 * Runs against the whitespace-flattened value, so a pasted two-line address
 * ("79 WAVERLY AVE\nCINCINNATI OH, 45215") is the same input as its one-line
 * form. `[\s,]+` before the state and the ZIP accepts the comma placements
 * people actually type: "OH, 45215", "Cincinnati, OH 45215", "Cincinnati OH 45215".
 */
const US_POSTAL_RE = new RegExp(
  `^\\d{1,6}(?:-\\d{1,6})?[A-Za-z]?\\s+\\S.*?[\\s,]+(${US_STATE_CODE_RE})[\\s,]+\\d{5}(?:-\\d{4})?$`,
  "i",
);

/** Parsing form of the strict pattern, anchored on a street suffix so street/city split correctly. */
const US_POSTAL_PARSE_RE = new RegExp(
  `^(\\d{1,6}(?:-\\d{1,6})?[A-Za-z]?\\s+.*?\\b${STREET_SUFFIX}\\b\\.?` +
    `(?:\\s+(?:NE|NW|SE|SW|N|S|E|W|North|South|East|West)\\b)?)` +
    `[\\s,]+([A-Za-z][A-Za-z.'\\- ]*?)[\\s,]+(${US_STATE_CODE_RE})[\\s,]+(\\d{5}(?:-\\d{4})?)$`,
  "i",
);

export interface ParsedUsAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

/** Collapse newlines/tabs/runs of spaces to single spaces. Does NOT change casing or punctuation. */
export function flattenAddress(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Cache/classification key for an address seed. Lowercased, punctuation that
 * carries no meaning ("," ".") dropped, whitespace collapsed — so every
 * formatting of the same address maps to one key while `raw` keeps the
 * analyst's original text for display.
 *
 * MUST match normalizeAddressValue in src/lib/seed.ts.
 */
export function normalizeAddressValue(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** STRICT: house number + 2-letter state + ZIP. Used for seed-kind detection. */
export function looksLikePostalAddress(raw: string | null | undefined): boolean {
  const flat = flattenAddress(raw);
  if (!flat || flat.length > 200) return false;
  const m = US_POSTAL_RE.exec(flat);
  if (!m) return false;
  // The state token must be written in the conventional uppercase form. Real
  // addresses always capitalize the state abbreviation; two of the 57 codes
  // (IN, OR) are also ordinary lowercase English words ("called him back in
  // 12345", "apples or 90210"), so a case-insensitive-only match false-
  // positived on plain sentences that happen to end in a 5-digit number.
  return m[1] === m[1].toUpperCase();
}

/**
 * LOOSE: house number + a street-type suffix somewhere, ZIP optional.
 * Quotes are stripped first so a compound selector like
 * `"79 Waverly Ave" Cincinnati "Patrick Damon"` is still recognised.
 */
export function looksLikeStreetAddress(raw: string | null | undefined): boolean {
  const flat = flattenAddress((raw ?? "").replace(/["']/g, " "));
  if (!flat || flat.length > 200) return false;
  if (!HOUSE_NUMBER_RE.test(flat)) return false;
  return STREET_SUFFIX_RE.test(flat);
}

/** Either test. The guard a non-hostname seed must clear before it is treated as an address. */
export function isAddressLike(raw: string | null | undefined): boolean {
  return looksLikePostalAddress(raw) || looksLikeStreetAddress(raw);
}

/** Best-effort component split. Returns null when the value does not parse cleanly. */
export function parseUsAddress(raw: string | null | undefined): ParsedUsAddress | null {
  const flat = flattenAddress(raw);
  // Same 200-char cap as looksLikePostalAddress/looksLikeStreetAddress. Unlike
  // those two call sites, this one is reachable directly with a raw, unbounded
  // model-supplied seed: resolveDorkKind() only re-validates the seed when the
  // model claims kind:"domain"; a model that sends kind:"address" outright
  // skips straight to buildAddressDorks() -> addressTerms() -> here with no
  // length check at all. US_POSTAL_PARSE_RE backtracks two lazy groups
  // (street, city) against each other on a non-matching tail, so an unbounded
  // adversarial-length input is cheap insurance to cut off before the regex
  // runs, not just a cosmetic bound.
  if (flat.length > 200) return null;
  const m = US_POSTAL_PARSE_RE.exec(flat);
  if (!m) return null;
  return {
    street: m[1].replace(/[,\s]+$/, "").trim(),
    city: m[2].replace(/[,\s]+$/, "").trim(),
    state: m[3].toUpperCase(),
    zip: m[4],
  };
}
