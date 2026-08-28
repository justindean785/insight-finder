import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bandCluster, provenanceOf, MIN_BAND_CLUSTER, type BandRow } from "@/lib/evidence-bands";
import { isQuarantined } from "@/lib/quarantine";

/**
 * Banding exists to make a crowded cluster readable WITHOUT hiding a row.
 *
 * Every previous attempt at the "wall of identical rows" problem reduced the
 * wall by concealing part of it, and each was reverted on operator verdict
 * (`clusterDefaultOpen`). So the tests that matter here are not the layout
 * ones — they are the ones that would fail if banding ever started losing
 * evidence.
 */

type Row = BandRow & { id: string; value: string };

const row = (id: string, source: string, confidence: number | null = 45, metadata: unknown = {}): Row =>
  ({ id, value: id, source, confidence, metadata });

/**
 * The shape measured in production thread `61d1eede`: one `email` cluster of 34
 * rows drawn from three unrelated harvests, every row scored 30–50.
 */
const CARLOS_EMAIL_CLUSTER: Row[] = [
  ...Array.from({ length: 21 }, (_, i) => row(`oath${i}`, "oathnet_lookup", 45)),
  ...Array.from({ length: 10 }, (_, i) => row(`indicia${i}`, "indicia_address", 50)),
  row("up0", "user_upload (text.txt dossier)", 50),
  row("up1", "user_upload (text.txt dossier)", 40),
  row("up2", "user_upload (text.txt dossier)", 30),
];

describe("banding is a partition, never a filter", () => {
  it("⛔ every row goes in and every row comes out, exactly once", () => {
    // The load-bearing assertion. A band that drops a row is a board that hides
    // evidence, which is the failure this whole approach exists to avoid.
    const bands = bandCluster(CARLOS_EMAIL_CLUSTER);
    expect(bands, "a 34-row three-source cluster must band").not.toBeNull();
    const out = bands!.flatMap((b) => b.rows.map((r) => (r as Row).id));
    expect(out).toHaveLength(CARLOS_EMAIL_CLUSTER.length);
    expect([...out].sort()).toEqual(CARLOS_EMAIL_CLUSTER.map((r) => r.id).sort());
  });

  it("⛔ a quarantined row survives banding like any other", () => {
    // Quarantine is disclosure, not deletion. A quarantined row must reach the
    // board through the band exactly as it reached it through the flat list.
    const quarantined = row("q0", "oathnet_lookup", 45, { subject_unlinked: true });
    const bands = bandCluster([...CARLOS_EMAIL_CLUSTER, quarantined]);
    const out = bands!.flatMap((b) => b.rows) as Row[];
    expect(out.filter((r) => isQuarantined(r.metadata))).toHaveLength(1);
  });

  it("preserves the caller's sort within each band", () => {
    // Bands regroup; they never re-sort. The board sorts by authority then
    // confidence before banding, and that order has to survive.
    const bands = bandCluster(CARLOS_EMAIL_CLUSTER)!;
    const uploads = bands.find((b) => b.prov.startsWith("user_upload"))!;
    expect((uploads.rows as Row[]).map((r) => r.id)).toEqual(["up0", "up1", "up2"]);
  });
});

describe("which clusters band at all", () => {
  it("splits the production email cluster into its three harvests", () => {
    const bands = bandCluster(CARLOS_EMAIL_CLUSTER)!;
    expect(bands.map((b) => [b.prov, b.rows.length])).toEqual([
      // Strongest member first: indicia and the upload both peak at 50, so the
      // larger band leads; oathnet's 21 rows peak at 45 and follow.
      ["indicia_address", 10],
      ["user_upload (text.txt dossier)", 3],
      ["oathnet_lookup", 21],
    ]);
  });

  it("reports each band's confidence range", () => {
    const bands = bandCluster(CARLOS_EMAIL_CLUSTER)!;
    const uploads = bands.find((b) => b.prov.startsWith("user_upload"))!;
    expect([uploads.lo, uploads.hi]).toEqual([30, 50]);
    const oath = bands.find((b) => b.prov === "oathnet_lookup")!;
    expect([oath.lo, oath.hi], "a flat band collapses to one figure").toEqual([45, 45]);
  });

  it("declines a cluster that is already small enough to scan", () => {
    const small = CARLOS_EMAIL_CLUSTER.slice(0, MIN_BAND_CLUSTER - 1);
    expect(bandCluster(small), "a header per source buys nothing under the threshold").toBeNull();
  });

  it("declines a single-provenance cluster — `uniformProv` handles it better", () => {
    // The board hoists a shared label into the kind subheader and drops the
    // per-row line entirely. Banding it would add a header row for no gain.
    const oathOnly = CARLOS_EMAIL_CLUSTER.filter((r) => r.source === "oathnet_lookup");
    expect(oathOnly.length).toBeGreaterThan(MIN_BAND_CLUSTER);
    expect(bandCluster(oathOnly)).toBeNull();
  });

  it("tolerates rows with no source and no score", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row(`a${i}`, "oathnet_lookup", null)),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, value: `b${i}`, source: null, confidence: null })),
    ];
    const bands = bandCluster(rows)!;
    expect(bands.flatMap((b) => b.rows)).toHaveLength(6);
    const unattributed = bands.find((b) => b.prov === "")!;
    expect([unattributed.lo, unattributed.hi]).toEqual([null, null]);
  });

  it("is deterministic — the same cluster bands the same way every render", () => {
    const a = bandCluster(CARLOS_EMAIL_CLUSTER)!.map((b) => b.prov);
    const b = bandCluster([...CARLOS_EMAIL_CLUSTER].reverse())!.map((x) => x.prov);
    expect(a).toEqual(b);
  });
});

describe("provenanceOf keeps the row and its band in one keyspace", () => {
  it("prefers the platform, then the breach corpus, then the tool", () => {
    expect(provenanceOf({ source: "username_sweep", metadata: { platform: "github" } })).toBe("github");
    expect(provenanceOf({ source: "breach_check", metadata: { breach_source: "stolen.tax" } }))
      .toBe("breach · stolen.tax");
    expect(provenanceOf({ source: "oathnet_lookup", metadata: {} })).toBe("oathnet_lookup");
    expect(provenanceOf({ source: null, metadata: null })).toBe("");
  });

  it("⛔ the row and the band read provenance from ONE function", () => {
    // The band header claims "these rows share a source". If the row computed
    // its own provenance differently, a band could group rows the row labels
    // differently — a header that lies about its own contents. There is exactly
    // one definition and both sides import it.
    const src = readFileSync("src/components/ResourcesPanel.tsx", "utf8");
    expect(src).toMatch(/provenanceOf as provFor.*from "@\/lib\/evidence-bands"/);
    expect(src, "no second local definition may reappear").not.toMatch(/function provFor\s*\(/);
  });
});

describe("wiring: a band nobody renders is not a band", () => {
  const src = readFileSync("src/components/ResourcesPanel.tsx", "utf8");

  it("the board actually calls bandCluster", () => {
    expect(src).toMatch(/const bands = uniformProv \? null : bandCluster\(list\)/);
  });

  it("keeps the flat path for clusters that decline to band", () => {
    // Both branches must render rows. Banding is an alternative layout, not a
    // gate: a cluster that returns null still shows every one of its rows.
    expect(src).toMatch(/\{open && bands && bands\.map\(/);
    expect(src).toMatch(/\{open && !bands && list\.map\(/);
  });

  it("band headers are not interactive — bands may not become a second fold", () => {
    // If a band header ever gains a click handler it becomes another place to
    // hide rows, which is the reverted behaviour `clusterDefaultOpen` records.
    const bandBlock = src.slice(src.indexOf("{open && bands &&"), src.indexOf("{open && !bands &&"));
    expect(bandBlock.length).toBeGreaterThan(200);
    expect(bandBlock).not.toMatch(/onClick|role="button"|aria-expanded/);
  });
});

describe("the board-wide fold is analyst-initiated, never a default", () => {
  const src = readFileSync("src/components/ResourcesPanel.tsx", "utf8");

  it("stores the fold-all choice under a key no cluster can collide with", () => {
    // Cluster keys are `${group}:${kind}` and always contain a colon.
    expect(src).toMatch(/const FOLD_ALL_KEY = "\*"/);
    expect(src).toMatch(/const key = `\$\{g\}:\$\{kind\}`/);
  });

  it("consults it only AFTER the cluster's own toggle, and before the policy default", () => {
    expect(src).toMatch(
      /openClusters\[key\]\s*\?\?\s*openClusters\[FOLD_ALL_KEY\]\s*\?\?\s*clusterDefaultOpen\(/,
    );
  });

  it("folds only when the analyst asks — the stored value is never seeded", () => {
    // `readClusterPrefs` returns {} for a case with no preferences, so the
    // lookup falls through to `clusterDefaultOpen` (always open). Nothing in
    // the component writes FOLD_ALL_KEY except the button's own handler.
    const writes = src.match(/\[FOLD_ALL_KEY\]:/g) ?? [];
    expect(writes, "exactly one writer: the Fold all button").toHaveLength(1);
    expect(src).toMatch(/setClusters\(allFolded \? \{\} : \{ \[FOLD_ALL_KEY\]: false \}\)/);
  });
});
