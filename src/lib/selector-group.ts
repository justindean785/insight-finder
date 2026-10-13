/**
 * selector-group.ts — rows that record the SAME selector, seen as one group.
 *
 * WHY THIS EXISTS. `useThreadArtifacts` keeps one item per database ROW (rows with identical authority collapse; rows
 * that differ stay separate, each under its OWN authority — see dedupeArtifacts). That is the right unit for authority
 * and the wrong unit for three questions that are really about the SELECTOR, not the row:
 *
 *   1. SAFETY. A minor-safety flag on one row protects the selector, whichever sibling row a surface happens to read.
 *      The flags are a CEILING, never an authority, so propagating them can only restrict.
 *   2. COUNTING. Corroboration is "how many INDEPENDENT source classes back this selector". Two rows from one class are
 *      one class, two rows from two classes are two. Neither is "two findings".
 *   3. ANALYST REJECTION. "This value is wrong" is a statement about the value. The edge already treats it that way
 *      (rejection keys are `kind:normalizedValue`); the display must too, or a dismissed value comes back through its
 *      sibling row.
 *
 * WHAT THIS MODULE MUST NEVER DO. It never moves an analyst's POSITIVE decision (`reviewed`, `confirmed`, `key`), a
 * confidence, a source class, a cluster, a quarantine release (`linkage_confirmed`) or a corroboration between rows.
 * Everything here either restricts (minor ceiling, rejection) or counts (distinct classes), and every restriction is
 * derived at read time: no stored row is rewritten.
 *
 * Pure: no React, no I/O.
 */
import { isRejectedReview } from "@/lib/analyst-decisions";

/** Canonicalize a value per kind so duplicates across tools collapse cleanly. */
export function normalizeSelectorValue(kind: string, raw: string): string {
  const v = (raw ?? "").trim();
  const k = (kind ?? "").toLowerCase();
  if (!v) return v;
  if (k === "email" || k === "domain") return v.toLowerCase();
  if (k === "username" || k === "social") return v.replace(/^@+/, "").toLowerCase();
  if (k === "ip") {
    // Lightweight IPv4 canonicalization (strip leading zeros per octet).
    const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) return m.slice(1).map((n) => String(parseInt(n, 10))).join(".");
    return v.toLowerCase();
  }
  if (k === "name") {
    // Strip trailing parentheticals like "Prince (Twitter display name)" → "prince"
    // so the bare name and its platform-tagged variant collapse to one row.
    return v.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
  }
  return v.toLowerCase();
}

/** The identity of a SELECTOR: kind + canonical value. The same key the hook dedupes on. */
export function selectorKey(kind: string, value: string): string {
  return `${(kind ?? "").toLowerCase()}|${normalizeSelectorValue(kind, value)}`;
}

interface SelectorRow {
  kind: string;
  value: string;
}

/** Group rows by selector. Insertion order of first appearance; rows keep their input order inside a group. */
export function groupBySelector<T extends SelectorRow>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = selectorKey(r.kind, r.value);
    const g = out.get(k);
    if (g) g.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export function distinctSelectorCount(rows: readonly SelectorRow[]): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add(selectorKey(r.kind, r.value));
  return seen.size;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Minor-safety ceiling across a selector group
// ---------------------------------------------------------------------------------------------------------------------

type Meta = Record<string, unknown>;
const asMeta = (m: unknown): Meta => (m && typeof m === "object" && !Array.isArray(m) ? (m as Meta) : {});

/**
 * Does THIS row's own metadata carry a minor-safety flag? The union of everything the readers consult:
 * pivot-engine (`possible_minor` / `minor_warning` / `auto_pivot_blocked`), the audit redaction (`flag ===
 * "MINOR_SAFETY_FLAG"`), CaseReport and ResourcesPanel (`possible_minor` / `minor_warning`).
 */
export function rowCarriesMinorFlag(metadata: unknown): boolean {
  const m = asMeta(metadata);
  return m.possible_minor === true || m.minor_warning === true || m.auto_pivot_blocked === true ||
    String(m.flag ?? "").toUpperCase() === "MINOR_SAFETY_FLAG";
}

/** The flags a protected row must carry so EVERY reader (each checks a different subset) protects it. */
const PROTECTIVE_KEYS = ["possible_minor", "minor_warning", "auto_pivot_blocked"] as const;

/** Marker listing exactly the keys WE added, so a writer can remove them again. Never consulted by a reader. */
export const MINOR_DERIVED_MARKER = "minor_flag_inherited_keys";

interface ProtectableRow extends SelectorRow {
  metadata: Meta | null;
}

/**
 * Give every row of a minor-flagged selector the protective flags, so the ceiling holds whichever row is read.
 *
 * ONLY the three protective booleans are copied (plus a marker naming which ones). Not the review state, not a
 * confidence, not a source class, not a cluster, not a quarantine release. A row that already carries a flag is
 * returned as the SAME object; rows of unflagged selectors are untouched. Order independent: the result depends on the
 * set of rows, never on which came first.
 */
export function protectMinorSelectors<T extends ProtectableRow>(rows: readonly T[]): T[] {
  const flagged = new Set<string>();
  for (const r of rows) if (rowCarriesMinorFlag(r.metadata)) flagged.add(selectorKey(r.kind, r.value));
  if (flagged.size === 0) return rows as T[];
  return rows.map((r) => {
    if (!flagged.has(selectorKey(r.kind, r.value))) return r;
    const m = asMeta(r.metadata);
    const missing = PROTECTIVE_KEYS.filter((k) => m[k] !== true);
    if (missing.length === 0) return r;
    const derived: Meta = { ...m, [MINOR_DERIVED_MARKER]: missing };
    for (const k of missing) derived[k] = true;
    return { ...r, metadata: derived };
  });
}

/**
 * Remove what `protectMinorSelectors` derived, before an item's metadata is written back to the database.
 * A key the row carried itself is never in the marker, so it is never removed.
 */
export function stripDerivedItemMetadata<M extends Meta>(metadata: M): M {
  const marker = metadata[MINOR_DERIVED_MARKER];
  if (!Array.isArray(marker)) return metadata;
  const out: Meta = { ...metadata };
  for (const k of marker) if (typeof k === "string") delete out[k];
  delete out[MINOR_DERIVED_MARKER];
  return out as M;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Analyst REJECTION across a selector group
// ---------------------------------------------------------------------------------------------------------------------

interface IdentifiedRow extends SelectorRow {
  id: string;
}

/**
 * The review states every row of a selector effectively has, given the rows' OWN recorded states.
 *
 * "Dismissed" and "marked false" are verdicts about the VALUE. The edge already treats them that way (its rejection keys
 * are `kind:normalizedValue`), and before #593 the dedupe merged a selector's rows into one item, so a verdict recorded
 * against that item dismissed the value. With rows kept separate, a value dismissed on one row came back through its
 * sibling — and every dismissal recorded BEFORE this change (against the merged item's id) now has a sibling that is
 * not dismissed. So a rejection recorded on any row of a selector is applied to the siblings that have no verdict of
 * their own.
 *
 * ONLY rejections propagate. `confirmed`, `key` and `recheck` stay on the row they were recorded on, because a positive
 * decision on one record is not a decision about another record's authority. A sibling's own verdict always wins. When
 * rows disagree about HOW it was rejected, siblings inherit "wrong" (the stronger statement) over "dismissed", so the
 * result does not depend on row order.
 *
 * Derived at read time from the recorded states; nothing is written, so resetting the verdict on the row it was recorded
 * on lifts it from the siblings too. Returns the SAME object when there is nothing to expand.
 */
export function expandRejections<S extends string>(
  rows: readonly IdentifiedRow[] | null | undefined,
  states: Readonly<Record<string, S>>,
): Record<string, S> {
  if (!rows || rows.length === 0) return states as Record<string, S>;
  let anyRejected = false;
  for (const id in states) {
    if (isRejectedReview(states[id])) { anyRejected = true; break; }
  }
  if (!anyRejected) return states as Record<string, S>;

  const groups = groupBySelector(rows.filter((r) => r.id));
  let out: Record<string, S> | null = null;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let inherited: S | null = null;
    for (const m of members) {
      const s = states[m.id];
      if (!isRejectedReview(s)) continue;
      if (inherited === null || (s === ("wrong" as S) && inherited !== ("wrong" as S))) inherited = s;
    }
    if (inherited === null) continue;
    for (const m of members) {
      const own = states[m.id];
      if (own && own !== ("new" as S)) continue;
      (out ??= { ...states })[m.id] = inherited;
    }
  }
  return out ?? (states as Record<string, S>);
}
