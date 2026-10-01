/**
 * nullish-literal — the write boundary's "this is not a value" test.
 *
 * A tool returned a null-shaped field and `auto-persist-findings` stored the
 * literal string `"NULL"` as a `username` at confidence 45 on a production
 * thread (2026-09-02); the analyst had to Dismiss it by hand. Nothing in
 * `normalizeFinding` or `validateArtifact` rejected it, because each only
 * checked for the EMPTY string. This module is the one place that knows what a
 * null literal looks like, and both write paths consult it before anything else.
 *
 * Zero imports on purpose: it sits under both validation paths and must never
 * pull either of them into a cycle.
 */

const NULLISH_LITERALS: ReadonlySet<string> = new Set([
  "null", "nil", "none", "undefined", "nan", "n/a", "na", "n.a.", "-", "--", "—", "–",
  "unknown", "not found", "not available", "not provided", "unavailable", "empty", "void", "missing",
  "[null]", "(null)", "<null>", "{}", "[]", "0000-00-00", "false", "true",
  // The ABSENT-FIELD spellings breach aggregators put in a name column rather
  // than omitting it. OathNet returns the literal `No Name` for a record with
  // no name, and on the 2026-09-12 `baig_azhar` export that persisted as a
  // `name` artifact at confidence 40, formed its own identity cluster, and the
  // analyst had to Dismiss it by hand — the same incident this module was
  // written for, one vocabulary short.
  //
  // Exact match only (the caller trims, lower-cases and unwraps first), so a
  // real observation that merely CONTAINS one of these phrases — "baig_azhar -
  // no breach hits" — is untouched.
  "no name", "noname", "no_name", "no name provided", "name not provided",
  "not set", "notset", "not specified", "unspecified", "not applicable",
  "no data", "no value", "no record", "no results", "no result",
]);

/**
 * True when the trimmed, lower-cased value — with any surrounding quotes,
 * brackets or braces removed — is one of the recognised null spellings.
 * `false`/`true` are included because a boolean field serialised into a
 * selector column is not a selector either.
 */
export function isNullishLiteral(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  let v = value.trim().toLowerCase();
  if (!v) return true;
  if (NULLISH_LITERALS.has(v)) return true;
  // strip one layer of wrapping punctuation: "null", 'NULL', [null], (n/a), <none>
  v = v.replace(/^["'`[(<{]+|["'`\])>}]+$/g, "").trim();
  if (!v) return true;
  return NULLISH_LITERALS.has(v);
}
