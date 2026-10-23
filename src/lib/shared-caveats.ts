/**
 * shared-caveats.ts — say a repeated reason once.
 *
 * The Overview's "Needs a decision" list rendered each row's caveat in full, and
 * on a quarantine-heavy case the same four-line linkage explanation repeated on
 * every card (audit E1, 2026-10-20). The reason is still true of every one of
 * those rows; only its repetition is noise.
 *
 * A caveat that appears on two or more visible rows becomes a shared note shown
 * once above the list. Each of those rows keeps a short pointer and keeps the
 * full text for assistive technology, so a row read on its own (screen reader,
 * deep link, copy) never loses its reason. A caveat seen on one row only stays
 * on that row. Nothing here changes which rows appear, their state, or their
 * text — it only decides where the identical sentence is printed.
 */
export interface CaveatRow {
  id: string;
  caveat: string | null | undefined;
  caveatKind?: string | null;
}

export interface SharedCaveat {
  caveat: string;
  caveatKind: string | null;
  count: number;
}

export interface SharedCaveats {
  /** Caveats shown once above the list, in first-appearance order. */
  shared: SharedCaveat[];
  /** Row id → the shared caveat it points to. Rows absent here keep their own. */
  byRow: Map<string, SharedCaveat>;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function groupSharedCaveats(rows: CaveatRow[], minShare = 2): SharedCaveats {
  const groups = new Map<string, { entry: SharedCaveat; ids: string[] }>();
  for (const r of rows) {
    if (!r.caveat || !norm(r.caveat)) continue;
    // Same words but a different kind (a linkage caveat vs a contradiction note)
    // is not the same reason: keyed on both.
    const key = `${r.caveatKind ?? ""}\u0000${norm(r.caveat)}`;
    const g = groups.get(key);
    if (g) {
      g.entry.count += 1;
      g.ids.push(r.id);
    } else {
      groups.set(key, { entry: { caveat: norm(r.caveat), caveatKind: r.caveatKind ?? null, count: 1 }, ids: [r.id] });
    }
  }
  const shared: SharedCaveat[] = [];
  const byRow = new Map<string, SharedCaveat>();
  for (const { entry, ids } of groups.values()) {
    if (entry.count < minShare) continue;
    shared.push(entry);
    for (const id of ids) byRow.set(id, entry);
  }
  return { shared, byRow };
}
