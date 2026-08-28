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
