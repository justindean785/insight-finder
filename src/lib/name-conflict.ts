/**
 * name-conflict.ts — an analyst-supplied name that record-derived names contradict.
 *
 * Why this exists. A live scan was seeded `@handle` + "Jordan Vale". Breach records
 * returned the same first name with a different surname, twice, and a third unrelated
 * name. Nothing in the product marked that as an OPEN QUESTION: the engine only splits
 * clusters on conflicting names, and the model's prose picked a winner. An analyst
 * reading the report could not tell that the surname they typed was contradicted by
 * every record that named one.
 *
 * Deliberately conservative — this is an alarm, not an adjudicator:
 *  - It needs an ANALYST-SUPPLIED name as the anchor. Two record-derived names that
 *    disagree with each other are ordinary relatives/namesakes, not a contradiction of
 *    anything the analyst asserted.
 *  - It flags only a name that SHARES THE ANCHOR'S FIRST NAME and differs on surname.
 *    A different first name is a different person, not a conflict.
 *  - Middle initials, generational suffixes and an initial-only surname never conflict.
 *  - Excluded / collision rows are ignored: they are already ruled out.
 *
 * It never picks a side and never says "different people" — surname differences also
 * come from marriage, stage names and step-families. Pure and structural; no I/O.
 */
import { isCollisionArtifact } from "@/lib/report-hygiene";

/** The slice of an artifact this reads (a full `Artifact` is assignable). */
export type NameRow = {
  kind: string;
  value: string;
  source: string | null;
  metadata?: Record<string, unknown> | null;
};

export type NameVariant = { name: string; rows: number; sources: string[] };

export type NameConflict = {
  /** The analyst-supplied name the others were compared against, as recorded. */
  anchor: string;
  /** Record-derived names sharing the anchor's first name but disagreeing on surname. */
  conflicting: NameVariant[];
};

const ANALYST_SOURCES = new Set(["user_provided", "analyst_provided", "analyst"]);
const GENERATIONAL = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

type Folded = { first: string; last: string };

/** "Jordan Q. Vale Jr." -> { first: "jordan", last: "vale" }; null when it is not a
 *  two-token personal name (a handle, an org, a single word). */
function foldName(value: string): Folded | null {
  const tokens = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean)
    .filter((t) => !GENERATIONAL.has(t));
  if (tokens.length < 2) return null;
  const first = tokens[0];
  // Drop single-letter middle initials; the surname is the last REAL token.
  const last = tokens[tokens.length - 1];
  if (first.length < 2) return null;
  return { first, last };
}

/** Same first name: equal, or one is a prefix of the other (>=3 chars) — "Mekhi"/"Mekhi". */
function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

function isAnalystSupplied(r: NameRow): boolean {
  const src = String(r.source ?? "").trim().toLowerCase();
  if (ANALYST_SOURCES.has(src)) return true;
  const m = (r.metadata ?? {}) as Record<string, unknown>;
  return m.user_provided === true || m.analyst_provided === true;
}

export function detectNameConflict(rows: ReadonlyArray<NameRow>): NameConflict | null {
  const names = rows.filter((r) => String(r.kind ?? "").toLowerCase() === "name" && !isCollisionArtifact(r));
  const anchorRow = names.find((r) => isAnalystSupplied(r) && foldName(r.value));
  if (!anchorRow) return null;
  const anchor = foldName(anchorRow.value)!;

  const groups = new Map<string, NameVariant>();
  for (const r of names) {
    if (isAnalystSupplied(r)) continue;
    const f = foldName(r.value);
    if (!f || !sameFirstName(f.first, anchor.first)) continue;
    // An initial-only surname ("Jordan V.") cannot contradict a full one.
    if (f.last.length < 2 || anchor.last.length < 2) continue;
    if (f.last === anchor.last) continue;
    const key = `${f.first} ${f.last}`;
    const g = groups.get(key) ?? { name: r.value.trim(), rows: 0, sources: [] };
    g.rows += 1;
    const src = String(r.source ?? "").trim();
    if (src && !g.sources.includes(src)) g.sources.push(src);
    groups.set(key, g);
  }
  if (!groups.size) return null;
  return { anchor: anchorRow.value.trim(), conflicting: [...groups.values()] };
}

/** One report/UI warning line. Wording is deliberately an OPEN QUESTION — it names
 *  the disagreement and says no source settles it. It does not pick a surname. */
export function formatNameConflict(c: NameConflict): string {
  const variants = c.conflicting
    .map((v) => `“${v.name}” (${v.rows} row${v.rows === 1 ? "" : "s"}${v.sources.length ? `: ${v.sources.join(", ")}` : ""})`)
    .join("; ");
  return `Name conflict (open question): the analyst-supplied name “${c.anchor}” disagrees on surname with ${
    c.conflicting.length === 1 ? "a record-derived name" : `${c.conflicting.length} record-derived names`
  } that share its first name — ${variants}. Nothing in this case establishes which surname is right; treat them as unresolved and do not merge identities on a first name alone.`;
}

/** The structured form of the same warning, for a UI that lists the variants
 *  instead of printing one paragraph. Same wording rules: an open question, no
 *  winner. */
export function nameConflictParts(c: NameConflict): { headline: string; variants: string[] } {
  return {
    headline: `You supplied “${c.anchor}”. ${
      c.conflicting.length === 1 ? "A record gives" : `${c.conflicting.length} records give`
    } the same first name with a different surname.`,
    variants: c.conflicting.map(
      (v) => `“${v.name}” · ${v.rows} row${v.rows === 1 ? "" : "s"}${v.sources.length ? ` · ${v.sources.join(", ")}` : ""}`,
    ),
  };
}
