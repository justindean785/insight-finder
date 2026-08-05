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
