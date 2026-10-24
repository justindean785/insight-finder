/**
 * evidence-bands.ts — provenance bands inside a same-kind evidence cluster.
 *
 * ## The measured problem
 *
 * Production thread `61d1eede` (seed `morales7272carlos@gmail.com`, 143
 * artifacts) renders an `email` cluster of **34 rows**. Those 34 rows are three
 * unrelated harvests wearing one heading:
 *
 * | rows | source | what they actually are |
 * |---|---|---|
 * | 21 | `oathnet_lookup` | every mailbox in the `psyber.com` DOMAIN breach corpus — `support@`, `dbuse@`, `lisalou@` … |
 * | 10 | `indicia_address` | the other residents of a reverse-address lookup |
 * |  3 | `user_upload` | addresses the analyst supplied |
 *
 * Confidence across the whole cluster is **30–50**, so no sort separates them,
 * and exactly **one** of the thread's 143 rows is quarantined, so no filter
 * separates them either. The analyst's verdict — *"way too many artifacts, it's
 * so hard to go through and see evidence"* — is a description of that table.
 *
 * ## Why the board doesn't already handle this
 *
 * `ArtifactsList` collapses the repeated per-row source label when every row in
 * a cluster resolves to one provenance (`uniformProv`). That optimisation
 * switches **off** precisely when a cluster is crowded, because crowding comes
 * from mixing harvests — so the most cluttered clusters are the ones that also
 * repeat their source label on every single row.
 *
 * ## What this does, and what it deliberately does NOT do
 *
 * Bands are **structure, not concealment**. Every row that goes in comes out,
 * in the same order, always visible — pinned by
 * `evidence-bands.test.ts` ("banding is a partition"). Nothing folds and no
 * default hides anything.
 *
 * That line is not stylistic. `clusterDefaultOpen` in `quarantine.ts` records
 * the operator verdict that killed the previous attempt at this problem: folding
 * clusters over four rows meant a real case "opened almost entirely shut" and
 * the analyst had to expand every cluster to read their own evidence — *"i have
 * to go one by one every single time."* Banding is the version of that idea that
 * survives the verdict: it buys the same scanning win by naming the groups
 * rather than by hiding them.
 */

/**
 * Is this artifact value PROSE rather than a selector?
 *
 * The `value` column is a selector column — mono, one line, truncated — and for
 * `support@psyber.com` that is exactly right. But the extractor also writes
 * whole sentences into it, and those arrive on the board as a truncated
 * monospace fragment that says nothing. Real production values:
 *
 *   "psyber.com domain breach: 45+ records across 18+ breach DBs — ISP customer
 *    emails with exposed passwords, names, addresses, phones for Lincoln…"
 *   "CONTRADICTION: 6035 Bryce Way, Rocklin CA 95677 is NOT linked to Carlos
 *    Morales. Indicia address lookup returned 31 records — the actual…"
 *
 * The second one is the single most important row in its case, and the board
 * showed the analyst its first forty characters in a monospace face.
 *
 * The test is a SPACE plus length, because that is what actually separates the
 * two populations: selectors (emails, phones, domains, handles, URLs, IPs) have
 * no spaces at all, and the one kind that does — a street address — is short.
 * `"6035 Bryce Way, Rocklin, CA 95677"` is 33 characters and stays a selector;
 * anything past the threshold with a space in it is a sentence.
 */
export const PROSE_VALUE_MIN = 48;

export function isProseValue(value: string): boolean {
  return value.length > PROSE_VALUE_MIN && /\s/.test(value.slice(0, PROSE_VALUE_MIN));
}

/**
 * "<url> — <descriptor>": the extractor writes a link and what it is into one `value`
 * ("https://… — X/Twitter avatar for @name"). Neither half is lost: the descriptor reads in the sans face on its own
 * line and the URL keeps the mono, single-line, selectable treatment. Returns null for anything else, including a URL
 * with no descriptor and a descriptor that is not separated by a spaced dash, so ordinary values are untouched.
 */
export function splitUrlDescriptor(value: string): { url: string; descriptor: string } | null {
  const m = /^(https?:\/\/\S+)\s+[\u2014\u2013-]\s+(\S[\s\S]*)$/.exec(value.trim());
  return m ? { url: m[1], descriptor: m[2].trim() } : null;
}

/** The fields banding needs. Structural, so a full `Artifact` or a projection both fit. */
export interface BandRow {
  confidence?: number | null;
  source?: string | null;
  metadata?: unknown;
}

export interface EvidenceBand<T extends BandRow> {
  /** The raw provenance string shared by every row in the band. May be "". */
  prov: string;
  rows: T[];
  /** Confidence range across the band, or null when no row carries a score. */
  lo: number | null;
  hi: number | null;
}

/**
 * Clusters this size or smaller always render flat.
 *
 * Five is one past `CLUSTER_COLLAPSE_THRESHOLD` (4) — the board's existing
 * "this is a wall" line. Below it, banding costs a header row per source and
 * buys nothing: a four-row cluster is already scannable.
 */
export const MIN_BAND_CLUSTER = 5;

/**
 * The provenance string shown under a row and in a band header.
 *
 * Prefers the specific over the generic: a social platform names itself, a
 * breach names its corpus, and only then do we fall back to the tool label.
 * This lived in `ResourcesPanel` and moved here so the row and the band that
 * contains it can never disagree about which rows share a provenance.
 */
export function provenanceOf(a: BandRow): string {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.platform === "string" ? meta.platform
    : typeof meta.breach_source === "string" ? `breach · ${meta.breach_source}`
    : a.source ?? "";
}

/**
 * Partition a same-kind cluster into provenance bands, or `null` to render flat.
 *
 * `null` rather than a one-band array is deliberate: "don't band this" is a
 * decision the call site has to make differently (no headers, per-row source
 * labels restored), so it must not be expressible as a degenerate success.
 *
 * Band order is strongest member first, then larger band first, then label —
 * total and deterministic, so the same cluster bands identically on every
 * render and the order agrees with how `ArtifactsList` already orders kinds.
 * Row order WITHIN a band is the caller's sort, untouched.
 */
export function bandCluster<T extends BandRow>(rows: readonly T[]): EvidenceBand<T>[] | null {
  if (rows.length < MIN_BAND_CLUSTER) return null;

  const byProv = new Map<string, T[]>();
  for (const r of rows) {
    const p = provenanceOf(r);
    const list = byProv.get(p);
    if (list) list.push(r);
    else byProv.set(p, [r]);
  }
  // One provenance is what `uniformProv` already handles, and better: it hoists
  // the label into the kind subheader with no extra row at all.
  if (byProv.size < 2) return null;

  const bands: EvidenceBand<T>[] = [];
  for (const [prov, list] of byProv) {
    let lo: number | null = null;
    let hi: number | null = null;
    for (const r of list) {
      const c = r.confidence;
      if (typeof c !== "number") continue;
      lo = lo == null || c < lo ? c : lo;
      hi = hi == null || c > hi ? c : hi;
    }
    bands.push({ prov, rows: list, lo, hi });
  }

  bands.sort((a, b) =>
    (b.hi ?? -1) - (a.hi ?? -1) ||
    b.rows.length - a.rows.length ||
    a.prov.localeCompare(b.prov)
  );
  return bands;
}
