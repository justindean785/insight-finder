/**
 * Pure helpers for the Next Steps suggestion cards.
 *
 * Kept out of the component so the dedupe + source-readability rules are
 * unit-testable: a card summary must never show a raw `snake_case` tool id, and
 * apostrophe/spacing/case variants of the same entity must collapse to one card.
 */
import { readableSourceLabel } from "@/lib/tool-display";

/**
 * Normalize a pivot target for dedupe so apostrophe / spacing / case variants of
 * the same entity collapse to one key — e.g. "Damien O Brien" and
 * "Damien O'Brien" (both surfaced from the same source) become "damien o brien".
 */
export function normalizeTarget(value: string): string {
  // Treat every non-alphanumeric run (apostrophe, period, spaces) as a single
  // separator so "O'Brien", "O Brien" and "O.Brien" all normalize identically.
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The ENTITY a pivot target refers to, with any trailing descriptor removed.
 * `"hawkcapo - YouTube channel"` → `"hawkcapo"`.
 *
 * WHY THIS EXISTS — measured on a live 98-artifact case. The pipeline persists
 * `kind: "name"` artifacts whose value is a descriptive label rather than an
 * entity: "hawkcapo - GitHub", "hawkcapo - SoundCloud", "hawkcapo - YouTube
 * channel". A tool, meanwhile, runs against the bare selector "hawkcapo". So the
 * "have we already searched this?" comparison — `queriedSet.has(normalizeTarget
 * (value))` — compared "hawkcapo youtube channel" against "hawkcapo" and never
 * matched. The pivot stayed `status: "new"` permanently, and because Chat's Next
 * Steps renders exactly the `new` ones, the same three cards came back on every
 * render no matter how deep the investigation had gone.
 *
 * USE IT ONLY FOR THE ALREADY-SEARCHED COMPARISON, never for dedupe identity.
 * Two labels sharing an entity ("hawkcapo - GitHub" / "- SoundCloud") are still
 * distinct leads and must stay distinct rows; what they share is that a sweep of
 * "hawkcapo" has already covered both. Collapsing their canonical keys instead
 * would delete one of them from the board.
 *
 * Only a SPACED dash separates entity from descriptor, so hyphenated
 * identifiers ("hawk-capo", "Jean-Luc Bernard") are left intact.
 *
 * ⚠️ IT ANSWERS AN ENTITY-LEVEL QUESTION, AND ONLY THAT ONE. "Has this entity
 * been investigated at all?" — never "has this objective been completed?" The
 * difference is load-bearing and the broadening is real: a lead written
 * "Gregory Bradley - Sacramento court search" reduces to "gregory bradley", so
 * ONE generic query against that name marks the court-records objective searched
 * too. That is acceptable here only because `searched` sinks a lead out of Chat's
 * suggestions while leaving it fully visible and runnable in the Pivots tab —
 * it costs a prompt, not a lead. Do not reuse this key anywhere the consequence
 * is deletion, filtering, or a claim that work was done.
 *
 * This is a mitigation, not the cure, twice over: a `name` artifact whose value
 * is "hawkcapo - GitHub" is bad data at the write layer and only the pipeline
 * can stop producing it, and a durable lifecycle needs objective-level state
 * rather than a string comparison.
 */
export function entityKey(value: string): string {
  return normalizeTarget(value.replace(/\s+[-–—]\s+.*$/, ""));
}

/**
 * Swap a raw `via <tool_id>` source token in an artifact-derived lead reason for
 * a readable label, so card summaries read "via breach/profile lookup" instead
 * of "via oathnet_lookup". Raw ids remain available in expanded provenance.
 */
export function humanizeLeadReason(why: string): string {
  return why.replace(
    /\bvia\s+([a-z0-9_]+(?:[+,/][a-z0-9_]+)*)/i,
    (_m, src: string) => `via ${readableSourceLabel(src)}`,
  );
}

/** A card carries a dedupe target when it pivots on a specific entity. */
export type DedupeKeyed = { title: string; target?: string };

/** Stable dedupe key: same action + same normalized target ⇒ same card. */
export function cardDedupeKey(card: DedupeKeyed): string {
  return `${card.title}|${card.target ? normalizeTarget(card.target) : card.title}`;
}

/** Drop later cards that share an action + normalized target with an earlier one. */
export function dedupeCards<T extends DedupeKeyed>(cards: T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = cardDedupeKey(card);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
