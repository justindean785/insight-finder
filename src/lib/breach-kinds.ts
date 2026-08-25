/**
 * breach-kinds.ts — the single answer to "is this artifact a breach record?"
 *
 * WHY THIS EXISTS. `auto-persist-findings.ts` used to emit one `kind:"breach"`
 * artifact per breach corpus name. It now collapses them into `breach_exposure`
 * rows (see docs/design/confidence-corroboration.md §10). Six independent
 * consumers matched the literal string `"breach"` and would each have silently
 * changed behaviour:
 *
 *   src/lib/intel.ts          KIND_TO_GROUP — collapsed rows would drop out of the
 *                             Breach group into "other"
 *   src/components/ThreadSidebar.tsx   the per-thread breach counter → 0
 *   src/components/panel/CaseReport.tsx (×2)  the "3+ breaches" note, and a breach
 *                             count feeding a score → 0
 *   src/lib/entityIcons.ts    no icon → fell through to the generic document icon
 *   src/lib/confidence.ts     the "Stale breach" badge stopped applying
 *
 * A green extraction unit-suite proved none of that, which is exactly why the
 * compatibility review that caught it was warranted.
 *
 * This module is a LEAF — it imports nothing, so every consumer (including small
 * modules like entityIcons.ts) can depend on it without an import cycle. Adding a
 * new breach-shaped kind means editing this set and nowhere else.
 */

/** Artifact kinds that represent a breach/leak record about the subject. */
export const BREACH_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "breach",
  // Emitted by the auto-persist collapse: one row per provider, carrying the
  // full corpus list in metadata.breach_corpora.
  "breach_exposure",
  "credential_exposure",
  "leak_paste",
  "stealer_log",
  "leak",
]);

/** True when `kind` is a breach/leak record. Case-insensitive; null-safe. */
export function isBreachKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return BREACH_ARTIFACT_KINDS.has(kind.toLowerCase().trim());
}

/**
 * The narrower set that carries an actual exposure DATE worth ageing.
 *
 * Deliberately NOT the whole set: the "Stale breach" badge reasons about when the
 * breach happened, and a collapsed `breach_exposure` row spans many corpora with
 * many different dates, so ageing it as a single record would assert something the
 * row does not know. Kept separate so the distinction is explicit rather than an
 * accident of which predicate a call site happened to use.
 */
export function isDateableBreachKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  const k = kind.toLowerCase().trim();
  return k === "breach" || k === "leak" || k === "stealer_log";
}

/**
 * True when a breach-shaped artifact records an ACTUAL exposure, as opposed to a
 * negative or coverage result that merely carries a breach-shaped `kind`.
 *
 * WHY THIS EXISTS. `isBreachKind` answers "is this row breach-shaped?" — which is
 * the right question for grouping, icons and tab counts, and the WRONG question
 * for risk. A sweep that finds nothing still persists a `breach_exposure` row, so
 * counting by kind treated "no exposure found" as exposure. Measured on a live
 * report, three such rows —
 *
 *   "NO BREACH EXPOSURE FOUND — <selector> clean"
 *   "ListCrawler has no Hawaii/Honolulu classifieds section — 404"
 *   "No escort listing found on BackpageGals Honolulu containing <selector>"
 *
 * — tripped the `>= 3` threshold and published "Subject appears in 3 distinct
 * breach corpora. Assume credential exposure is broad", plus a MEDIUM risk score,
 * in the same report that stated every breach query returned zero hits.
 *
 * The test is STRUCTURAL, never the prose of `value`. A real exposure record
 * carries the metadata `buildBreachExposure` renders from — a corpus name, a
 * date, exposed field classes, or a concrete leaked value. A negative sweep
 * carries none of it. Reading the text instead would be the same mistake as
 * inferring intent from prose: it works until a provider rewords its summary.
 */
export function isPositiveBreachExposure(artifact: {
  kind?: string | null;
  metadata?: Record<string, unknown> | null;
  [k: string]: unknown;
} | null | undefined): boolean {
  if (!artifact || !isBreachKind(artifact.kind)) return false;
  const m = artifact.metadata;
  if (!m || typeof m !== "object") return false;

  // An explicit negative marker wins outright, if a writer sets one.
  if (m.no_exposure === true || m.exposure_found === false) return false;

  const nonEmptyString = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const nonEmptyList = (v: unknown) => Array.isArray(v) && v.length > 0;

  // Any ONE of these is proof the sweep actually returned something.
  if (nonEmptyString(m.breach_name)) return true;
  if (nonEmptyString(m.breach_date)) return true;
  if (nonEmptyList(m.breach_corpora)) return true;
  if (nonEmptyList(m.exposed_fields)) return true;
  if (typeof m.breach_count === "number" && m.breach_count > 0) return true;

  // Concrete leaked values — the strongest signal of a real record.
  for (const k of ["password", "password_hash", "hash", "salt", "email", "username", "phone", "ssn", "dob"]) {
    if (nonEmptyString(m[k])) return true;
  }
  return false;
}
