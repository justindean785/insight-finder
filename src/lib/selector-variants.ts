/**
 * Spelling variants of an already-normalized pivot target, for the
 * "has a tool already run against this?" comparison ONLY.
 *
 * `normalizeTarget` lowercases and collapses punctuation, which already folds
 * "@handle" into "handle" and "O'Brien" into "o brien". It cannot fold:
 *   - phones: "+1 (415) 555-0142" → "1 415 555 0142", but a tool logs "4155550142";
 *   - URLs: "https://www.instagram.com/user/" vs "instagram.com/user".
 * So a pivot the agent HAD run stayed "new" and came back after every report
 * (JD, 2026-11-02). The backend ranker checks every recorded spelling
 * (`next-pivot.ts`, "Check both, or a selector already run reads as
 * unsearched"); this is the browser's equivalent.
 *
 * Never use these keys for dedupe identity: two different leads must stay two
 * rows. They only answer "was this already searched".
 */

const PHONE_SHAPE_RE = /^[0-9 ]+$/;
const URL_PREFIX_RE = /^(?:(?:https?|www|m|mobile)\s+)+/;

/** Phone key: the last 10 digits, so a country code or punctuation cannot hide a match. */
function phoneKey(normalized: string): string | null {
  if (!PHONE_SHAPE_RE.test(normalized)) return null;
  const digits = normalized.replace(/ /g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `#${digits.slice(-10)}`;
}

// Common TLDs and second-level labels. After normalizeTarget a URL's dots are spaces,
// so a domain shows up as a token like "com" after its host token.
const TLD_TOKENS = new Set([
  "com", "net", "org", "io", "co", "me", "app", "dev", "ai", "gg", "tv", "us", "uk", "ca",
  "de", "fr", "ru", "info", "biz", "xyz", "edu", "gov", "site", "online", "link", "page",
]);

/**
 * Is this normalized target a URL? Yes when it opens with an http(s) scheme, or when
 * what follows the www / m / mobile prefix contains a host token then a TLD token
 * ("www instagram com user"). A bare handle or name never qualifies.
 */
function looksLikeUrl(normalized: string, stripped: string): boolean {
  if (/^https?\s/.test(normalized)) return true;
  const tokens = stripped.split(" ");
  return tokens.some((t, i) => i > 0 && TLD_TOKENS.has(t));
}

/** Every key a normalized target may have been logged under. Always includes the input. */
export function searchKeys(normalized: string): string[] {
  const out = new Set<string>();
  if (!normalized) return [];
  out.add(normalized);
  // Strip a scheme / "www" / mobile-host prefix ONLY from a target that is a URL:
  // stripping it from any normalized value made the username "mobile_user"
  // ("mobile user") match "user", and "M. Jordan" match "Jordan" (#945 review).
  const stripped = normalized.replace(URL_PREFIX_RE, "").trim();
  if (stripped && stripped !== normalized && looksLikeUrl(normalized, stripped)) out.add(stripped);
  const phone = phoneKey(normalized);
  if (phone) out.add(phone);
  return [...out];
}

/** Expand a set of normalized targets with every variant key. */
export function expandSearchKeys(targets: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of targets) for (const k of searchKeys(t)) out.add(k);
  return out;
}

/** True when any variant of any of `targets` is in `set`. */
export function anySearchKeyIn(set: ReadonlySet<string>, ...targets: string[]): boolean {
  for (const t of targets) for (const k of searchKeys(t)) if (set.has(k)) return true;
  return false;
}
