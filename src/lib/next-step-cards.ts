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
