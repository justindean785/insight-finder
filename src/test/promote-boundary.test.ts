/**
 * promote-boundary.test.ts — the PROMOTE half of the `subject_unlinked` authority
 * boundary, across every frontend surface that grants authority.
 *
 * The 08-09 handoff named three boundaries — WRITE, PIVOT, PROMOTE. #433 closed
 * write (backend auto-persist), #436 closed pivot (`computePivots`). This file
 * pins PROMOTE: a quarantined artifact may not seed or strengthen the subject's
 * identity, in clusters, in the graph, or in the confidence dimensions.
 *
 * WHY THE EXISTING GATE DOES NOT COVER THIS. Every one of these surfaces already
 * excludes collisions via `isCollisionArtifact`, which tests `excluded_collision`
 * / `collision` / `possible_collision` / `status === "excluded"` / the
 * `excluded_collision` kind. Measured against production on 2026-08-10: of the
 * 104 `subject_unlinked` artifacts across 4 threads, **zero** carry any of those
 * flags. The gate is not leaky — it is inapplicable. `subject_unlinked` and the
 * exclusion mechanism were never connected.
 *
 * FIXTURE PROVENANCE. Thread 88cf94fa-660a-43f3-bad6-81291eb18641's exact shape:
 * real artifact ids, kinds, confidence values, source and `subject_unlinked`
 * flags, pulled from the live database. VALUES ARE SYNTHETIC — CLAUDE.md forbids
 * real investigation PII in this repo, and the leak does not depend on what the
 * values are, only on whether a quarantined artifact gains authority.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. The label boundary
 * (`labelForArtifact`'s attestation short-circuit promoting a quarantined row to
 * CONFIRMED) is a CONFIDENCE-CAP change, which CLAUDE.md puts behind
 * evidence-integrity sign-off. It is a real, separate leak and it is not fixed
 * here — see the handoff, §3.4.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityClusters, buildReportMarkdown, type IdentityCluster } from "@/lib/intel";
import { buildEntityGraph } from "@/lib/entity-graph";
import { buildConfidenceProfile } from "@/lib/confidence-dimensions";
import { artifactsToClusterAudit } from "@/lib/audit/from-artifacts";
import { isSubjectUnlinked } from "@/lib/quarantine";
import { buildIdentityRows } from "@/lib/report-hygiene";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const NOW = "2026-08-10T15:11:15.413Z";

// `parent` is what gives the edge assertion teeth. Rows harvested from ONE
// name-only query all carry that query as their parent pointer, which is a real
// shared selector — so if the graph gate regresses they bond to each other (and
// to the seed) rather than sitting inert. Without it the fixture's quarantined
// rows share no selector at all, no edge can form under any implementation, and
// "builds no identity edge" passes vacuously. Found by mutation-testing the gate:
// the assertion survived removing the very code it exists to protect.
const QUARANTINE = {
  parent: "test subject",
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
} as const;

/** Same id, kind, confidence, source and quarantine flag as the real thread — synthetic values. */
const FIXTURE: Artifact[] = [
  // The one clean row: the subject's own asserted name, not quarantined.
  {
    id: "e500bfdf-4ad0-4cf0-a222-6127bbee7a05",
    kind: "name",
    value: "Test Subject",
    confidence: 40,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["person"] },
  },
  {
    id: "0f19bbfc-1762-4ffc-83ed-6f2a5e5cdf7d",
    kind: "phone",
    value: "5555550101",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["phone"], ...QUARANTINE },
  },
  {
    id: "c97b3628-b9f6-408f-a802-8210dda5952a",
    kind: "phone",
    value: "+15555550102",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["phone"], ...QUARANTINE },
  },
  {
    id: "5cd06c92-d786-4a7d-971a-64ce1b7ece9b",
    kind: "address",
    value: "1 TEST WAY EXAMPLE HILLS 00000",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["address", "property"], ...QUARANTINE },
  },
  {
    id: "b40c485f-bab6-42b8-ad44-a2595cde8814",
    kind: "address",
    value: "2 TEST WAY EXAMPLE HILLS 00000",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["address", "property"], ...QUARANTINE },
  },
  {
    id: "dca13bb5-0b52-4983-a63d-aaf6aa93b2dd",
    kind: "email",
    value: "test.subject1@example.com",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["email", "username", "domain"], ...QUARANTINE },
  },
  {
    id: "81a8a3b8-0f60-4777-a70e-c4f40584a33e",
    kind: "email",
    value: "test.subject2@example.com",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: ["email", "username", "domain"], ...QUARANTINE },
  },
  {
    id: "2b77da02-1329-478c-a445-9829aa2736cf",
    kind: "ip_address",
    value: "203.0.113.42",
    confidence: 40,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: { via: "oathnet", status: "observed", query_types: [], ...QUARANTINE },
  },
  {
    id: "c6c3188f-4f8e-4cc2-8486-e6d2fb9a4c7e",
    kind: "breach_exposure",
    value: "Breach exposure: test subject (oathnet_db)",
    confidence: 55,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet_db", status: "observed", query_types: [],
      breach_corpora: ["ExampleCorp", "TestVendor"], breach_corpus_count: 2,
      ...QUARANTINE,
    },
  },
];

const SEED_VALUE = "test subject ca";
const QUARANTINED_IDS = new Set(FIXTURE.filter((a) => isSubjectUnlinked(a.metadata)).map((a) => a.id));
const CLEAN_ID = "e500bfdf-4ad0-4cf0-a222-6127bbee7a05";

describe("promote boundary — fixture sanity", () => {
  it("matches the real thread: 9 artifacts, 8 quarantined, 1 clean", () => {
    expect(FIXTURE).toHaveLength(9);
    expect(QUARANTINED_IDS.size).toBe(8);
    expect(QUARANTINED_IDS.has(CLEAN_ID)).toBe(false);
  });

  // If this ever fails, the fix has been reimplemented by widening
  // `isCollisionArtifact` — which would ALSO change the report's collision-section
  // membership (intel.ts:1099) and double-list every quarantined row against the
  // separate path #431 added. Quarantine must be a DISTINCT signal.
  it("no quarantined row carries a legacy collision flag (so the old gate cannot catch them)", () => {
    for (const a of FIXTURE) {
      const m = (a.metadata ?? {}) as Record<string, unknown>;
      expect(m.collision).toBeUndefined();
      expect(m.excluded_collision).toBeUndefined();
      expect(m.possible_collision).toBeUndefined();
      expect(m.status).not.toBe("excluded");
      expect(a.kind).not.toBe("excluded_collision");
    }
  });
});

// ── Surface 1: identity clusters ────────────────────────────────────────────
// buildIdentityClusters is consumed by the report (intel.ts:1040), the Clusters
// tab, the entity graph, the confidence dimensions and the cluster audit — so a
// clean `live` filter here is load-bearing for all five.
describe("promote boundary — identity clusters", () => {
  it("no quarantined artifact id appears in any cluster's member list", () => {
    const report = buildIdentityClusters(FIXTURE, SEED_VALUE);
    const memberIds = report.clusters.flatMap((c: IdentityCluster) => c.artifacts.map((a) => a.id));
    expect(memberIds.filter((id) => QUARANTINED_IDS.has(id))).toEqual([]);
  });

  it("still clusters the clean row — the fix removes authority, not evidence", () => {
    const withCorroboration: Artifact[] = [
      ...FIXTURE,
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "email",
        value: "real.subject@example.com",
        confidence: 80,
        source: "hibp",
        created_at: NOW,
        metadata: { parent: "real.subject@example.com" },
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "username",
        value: "realsubject",
        confidence: 80,
        source: "github",
        created_at: NOW,
        metadata: { parent: "real.subject@example.com" },
      },
    ];
    const report = buildIdentityClusters(withCorroboration, SEED_VALUE);
    const memberIds = report.clusters.flatMap((c: IdentityCluster) => c.artifacts.map((a) => a.id));
    expect(memberIds).toContain("11111111-1111-4111-8111-111111111111");
    expect(memberIds.filter((id) => QUARANTINED_IDS.has(id))).toEqual([]);
  });
});

// ── Surface 2: the entity graph ─────────────────────────────────────────────
// A node is created for EVERY artifact by design — the graph shows everything.
// What must not happen is a quarantined row acquiring identity EDGES into the
// subject's network, or rendering as an ordinary (non-conflict) node.
describe("promote boundary — entity graph", () => {
  it("marks every quarantined node as conflict, so it is visibly inert", () => {
    const graph = buildEntityGraph(FIXTURE, SEED_VALUE, "name");
    const unflagged = graph.nodes
      .filter((n) => n.art && QUARANTINED_IDS.has(n.art.id) && !n.conflict)
      .map((n) => n.art!.id);
    expect(unflagged).toEqual([]);
  });

  // The invariant is about IDENTITY, not about being drawn at all. `buildEntityGraph`
  // gives any otherwise-unconnected node a faint `seed-discovery` edge to the seed
  // (entity-graph.ts:317, strength 0.15, the lowest EDGE_PRIORITY) meaning only
  // "this was surfaced while investigating the seed" — which stays true of a
  // quarantined row. What must never appear is an `identity` or `shared-infra`
  // edge, because those assert the row belongs to the subject's network.
  it("builds no identity or shared-infra edge touching a quarantined artifact", () => {
    const graph = buildEntityGraph(FIXTURE, SEED_VALUE, "name");
    const asserting = graph.edges.filter(
      (e) =>
        e.type !== "seed-discovery" &&
        (QUARANTINED_IDS.has(e.source) || QUARANTINED_IDS.has(e.target)),
    );
    expect(asserting).toEqual([]);
  });

  // Pins the CHOICE rather than trusting it: quarantine is given exactly the
  // treatment an already-flagged collision gets, no stricter and no looser. If a
  // future change tightens or loosens one, this fails and forces the other to
  // follow — which is the whole point of routing both through one predicate.
  it("treats a quarantined row exactly as an already-flagged collision row", () => {
    const asQuarantined = FIXTURE;
    const asCollision: Artifact[] = FIXTURE.map((a) =>
      QUARANTINED_IDS.has(a.id)
        ? { ...a, metadata: { ...(a.metadata ?? {}), subject_unlinked: undefined, collision: true } }
        : a,
    );
    const shape = (arts: Artifact[]) => {
      const g = buildEntityGraph(arts, SEED_VALUE, "name");
      return {
        conflictNodes: g.nodes.filter((n) => n.conflict).length,
        edgeTypes: [...g.edges].map((e) => e.type).sort(),
        clustered: buildIdentityClusters(arts, SEED_VALUE).clusters.flatMap((c) =>
          c.artifacts.map((a) => a.id),
        ).sort(),
      };
    };
    expect(shape(asQuarantined)).toEqual(shape(asCollision));
  });

  it("keeps the quarantined rows present as nodes — inert, not hidden", () => {
    const graph = buildEntityGraph(FIXTURE, SEED_VALUE, "name");
    const nodeIds = new Set(graph.nodes.filter((n) => n.art).map((n) => n.art!.id));
    for (const id of QUARANTINED_IDS) expect(nodeIds.has(id)).toBe(true);
  });
});

// ── Surface 3: confidence dimensions ────────────────────────────────────────
describe("promote boundary — confidence dimensions", () => {
  it("does not count quarantined rows toward selector breadth", () => {
    const profile = buildConfidenceProfile({ artifacts: FIXTURE, seedValue: SEED_VALUE, nowMs: Date.parse(NOW) });
    const selectors = profile.dimensions.find((d) => d.key === "selectors");
    expect(selectors).toBeDefined();
    // Only the clean `name` row may contribute. A profile built from the clean row
    // ALONE must score identically — if quarantined rows were counted, the full
    // fixture would score higher.
    const cleanOnly = buildConfidenceProfile({
      artifacts: FIXTURE.filter((a) => a.id === CLEAN_ID),
      seedValue: SEED_VALUE,
      nowMs: Date.parse(NOW),
    });
    const cleanSelectors = cleanOnly.dimensions.find((d) => d.key === "selectors");
    expect(selectors!.value).toBe(cleanSelectors!.value);
  });

  it("does not let quarantined rows raise the identity dimension", () => {
    const profile = buildConfidenceProfile({ artifacts: FIXTURE, seedValue: SEED_VALUE, nowMs: Date.parse(NOW) });
    const cleanOnly = buildConfidenceProfile({
      artifacts: FIXTURE.filter((a) => a.id === CLEAN_ID),
      seedValue: SEED_VALUE,
      nowMs: Date.parse(NOW),
    });
    const identity = profile.dimensions.find((d) => d.key === "identity");
    const cleanIdentity = cleanOnly.dimensions.find((d) => d.key === "identity");
    expect(identity!.value).toBe(cleanIdentity!.value);
  });
});

// ── Surface 5: the rendered report ──────────────────────────────────────────
// This is the half the design rationale rests on and the half nothing pinned.
// `isClusterIneligible` is deliberately SEPARATE from `isCollisionArtifact`
// because the latter is also the collision-SECTION membership test
// (intel.ts:1100 -> collisionIds), and intel.ts:1138 excludes collisionIds from
// `conflictNoted` — the only branch that quotes `subject_unlinked_reason`
// verbatim (intel.ts:1151). Fold quarantine into isCollisionArtifact and every
// quarantined row silently loses its specific reason for the generic collision
// boilerplate. Both assertions below fail under exactly that mutation.
describe("promote boundary — rendered report", () => {
  const render = () =>
    buildReportMarkdown({ seedValue: SEED_VALUE, seedType: "name", artifacts: FIXTURE });

  it("quotes the backend's own subject_unlinked_reason verbatim", () => {
    const md = render();
    expect(md).toContain(
      "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    );
    // and NOT the generic fallback the collision path would substitute
    expect(md).not.toContain("conflicting attributes across sources");
  });

  // `## Network Connections` IS the subject's network — appearing there is an
  // authority claim, not disclosure. The Artifact/Entity Table and Timeline are
  // inventories and MUST still carry the row (evidence). The distinction is the
  // whole "authority, not evidence" rule, so assert both halves rather than a
  // blunt occurrence count.
  const sectionOf = (md: string, heading: string) => {
    const start = md.indexOf(`## ${heading}`);
    if (start === -1) return "";
    const rest = md.slice(start + heading.length + 3);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("never lists a quarantined row under Network Connections", () => {
    const network = sectionOf(render(), "Network Connections");
    const leaked = FIXTURE.filter((a) => QUARANTINED_IDS.has(a.id) && network.includes(a.value))
      .map((a) => a.value);
    expect(leaked).toEqual([]);
  });

  it("still lists quarantined rows in the evidence inventory — disclosure is preserved", () => {
    const table = sectionOf(render(), "Artifact / Entity Table");
    const missing = FIXTURE.filter((a) => QUARANTINED_IDS.has(a.id) && !table.includes(a.value))
      .map((a) => a.value);
    expect(missing).toEqual([]);
  });

  it("keeps quarantined rows OUT of the namesake collision list", () => {
    const md = render();
    const start = md.indexOf("## Collision / Likely Unrelated");
    expect(start).toBeGreaterThan(-1);
    const section = md.slice(start);
    // The namesake blurb heads `collisionArtifacts`; quarantined rows belong to
    // the conflict-noted blurb below it, which carries their reason.
    expect(section).not.toContain("flagged as namesakes / unrelated entities");
    expect(section).toContain("Conflicts noted across sources");
  });
});

// ── Surface 4: the cluster audit ────────────────────────────────────────────
// The audit surface exists to CATCH over-statement. Computed from contaminated
// clusters it would certify them instead.
describe("promote boundary — cluster audit", () => {
  it("no audit cell cites a quarantined artifact's value", () => {
    const quarantinedValues = new Set(
      FIXTURE.filter((a) => QUARANTINED_IDS.has(a.id)).map((a) => a.value),
    );
    const audit = artifactsToClusterAudit(FIXTURE, SEED_VALUE);
    // EvidenceCell.value is `string | number`; artifact values are strings. Compare
    // as strings so a numeric cell can still be matched rather than silently skipped.
    const citedValues = audit.flatMap((c) => c.cells.map((cell) => String(cell.value)));
    expect(citedValues.filter((v) => quarantinedValues.has(v))).toEqual([]);
  });
});

// ── Surface 6: the CaseReport Identity panel ────────────────────────────────
// The workspace Report tab's Identity panel (CaseReport.tsx) is the surface an
// analyst actually reads. It is an AUTHORITY surface — "Real name", "Phone",
// "Alt email" are claims that the row belongs to the subject. A quarantined row
// appearing there as "Alt email" asserts the very linkage quarantine says is
// unproven. This is a different component from buildReportMarkdown (Surface 5);
// it was found by visual check during verification and is closed here.
//
// `buildIdentityRows` was extracted to report-hygiene.ts as a pure function so
// it is testable without exporting from the component. It uses the SAME
// `isClusterIneligible` predicate as the other four surfaces, so the two
// signals can never drift apart here either.
describe("promote boundary — CaseReport Identity panel", () => {
  it("never presents a quarantined artifact as a subject identity field", () => {
    const rows = buildIdentityRows(FIXTURE);
    const leaked = rows.filter((r) =>
      FIXTURE.filter((a) => QUARANTINED_IDS.has(a.id)).some((a) => a.value === r.value),
    );
    expect(leaked).toEqual([]);
  });

  it("still presents the clean row — the fix removes authority, not evidence", () => {
    const rows = buildIdentityRows(FIXTURE);
    const cleanName = FIXTURE.find((a) => a.id === CLEAN_ID)!;
    expect(rows.some((r) => r.value === cleanName.value && r.field === "Real name")).toBe(true);
  });

  // Over-block guard, matching the entity-graph assertion at line 230. The fix
  // removes identity AUTHORITY; it must not remove the row from the Evidence
  // board or the report's collision section. Those surfaces are tested above;
  // this just pins that buildIdentityRows itself doesn't over-block by accepting
  // a clean corroboration that restores a value's authority.
  it("does not over-block: a clean row restoring a value lets it appear", () => {
    const cleanEmail: Artifact = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "email",
      value: "test.subject1@example.com", // same value as a quarantined row
      confidence: 80,
      source: "hibp",
      created_at: NOW,
      metadata: { parent: "test.subject1@example.com" }, // NOT quarantined
    };
    const rows = buildIdentityRows([...FIXTURE, cleanEmail]);
    // The clean email restores authority to that value, so it MAY appear —
    // matching the "authority, not evidence" rule: quarantine is per-row, and a
    // linked observation restores the identity.
    expect(rows.some((r) => r.value === cleanEmail.value)).toBe(true);
  });
});
