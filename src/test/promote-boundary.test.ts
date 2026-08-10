/**
 * promote-boundary.test.ts — the PROMOTE half of the `subject_unlinked` boundary.
 *
 * Three boundaries must consult the quarantine flag: WRITE (backend auto-persist,
 * closed by #433), PIVOT (frontend pivot engine, closed by #436), and PROMOTE —
 * this one. Promote was open: a quarantined artifact could enter an identity
 * cluster and from there drive the report, the Clusters tab, the entity graph, the
 * Identity confidence score, and the cluster audit.
 *
 * WHY THE EXISTING GATE CAUGHT NONE OF IT. `buildIdentityClusters` excluded
 * `isCollisionArtifact(a)` — which tests `kind === "excluded_collision"`,
 * `status === "excluded"`, `excluded_collision`, `collision`, `possible_collision`.
 * Queried against production on 2026-08-10: of the 104 `subject_unlinked` artifacts
 * across 4 threads, **zero** carried any of those five signals. The flag and the
 * exclusion mechanism were disjoint sets of signals that had never been connected,
 * so the gate was not leaky — it was inapplicable.
 *
 * THE FIXTURE reproduces thread 88cf94fa-660a-43f3-bad6-81291eb18641's EXACT shape
 * — same artifact ids, kinds, confidence values, source, and subject_unlinked flags,
 * pulled from the live database. Values (email/phone/address strings) are SYNTHETIC:
 * CLAUDE.md forbids real investigation PII in this repo, and the leak does not depend
 * on what the values are, only on whether a quarantined artifact's id reaches a
 * cluster.
 *
 * Real thread facts (queried, not values):
 *   9 artifacts: 1 name (subject_unlinked NULL/false), 8 others all
 *   subject_unlinked=true — 2 phone, 2 address, 2 email, 1 breach_exposure,
 *   1 ip_address. Every row: source='oathnet_lookup', status='observed'.
 *
 * ASSERTIONS ARE ON OUTPUT, NOT ON PREDICATES. The test below drives the real
 * exported surface and asserts on artifact ids appearing in its output. A test
 * that asserted a predicate returns true would pass while every surface still
 * leaked — this codebase's recurring defect is a correct helper that the
 * surrounding control flow never reaches with the right inputs.
 *
 * COVERAGE IS ONE SURFACE OF FIVE, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT.
 * `buildIdentityClusters` is called from five places, and three of them apply
 * their own predicate carrying the same omission:
 *
 *   intel.ts:1040                 report cluster section          (shared gate)
 *   ClustersTab.tsx:48            Clusters / Graph tab            (shared gate)
 *   confidence-dimensions.ts:117  Identity confidence score       isConflicted :89
 *   entity-graph.ts:192           entity graph nodes/edges        isConflict   :150
 *   audit/from-artifacts.ts:108   cluster audit → ReportVerdict   (shared gate)
 *
 * A fix must close all five, and each needs its own red assertion first. Full
 * scoping — including why widening `isCollisionArtifact` is the WRONG one-line fix
 * — is in SESSION_HANDOFF_2026-08-10_beta-stabilization-III.md §3.
 *
 * NOT IN SCOPE, DELIBERATELY:
 *  - The LABEL boundary. `labelForArtifact`'s attestation short-circuit promotes a
 *    quarantined row to CONFIRMED. Fixing that changes a confidence cap, which
 *    CLAUDE.md puts behind evidence-integrity sign-off. Separate PR.
 *  - The total cluster count. Whether the one clean unreviewed `name` row should
 *    itself form a cluster is a policy question, not a quarantine question.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityClusters, type IdentityCluster } from "@/lib/intel";
import { isSubjectUnlinked } from "@/lib/quarantine";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const NOW = "2026-08-10T15:11:15.413Z";

/** Same id, kind, confidence, source, subject_unlinked flag as the real thread — synthetic values. */
const FIXTURE: Artifact[] = [
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
    metadata: {
      via: "oathnet", status: "observed", query_types: ["phone"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "c97b3628-b9f6-408f-a802-8210dda5952a",
    kind: "phone",
    value: "+15555550102",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: ["phone"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "5cd06c92-d786-4a7d-971a-64ce1b7ece9b",
    kind: "address",
    value: "1 TEST WAY EXAMPLE HILLS 00000",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: ["address", "property"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "b40c485f-bab6-42b8-ad44-a2595cde8814",
    kind: "address",
    value: "1 Test Lane Example 00000",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: ["address", "property"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "dca13bb5-0b52-4983-a63d-aaf6aa93b2dd",
    kind: "email",
    value: "test.subject1@example.com",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: ["email", "username", "domain"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "81a8a3b8-0f60-4777-a70e-c4f40584a33e",
    kind: "email",
    value: "test.subject2@example.com",
    confidence: 45,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: ["email", "username", "domain"],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
  {
    id: "2b77da02-1329-478c-a445-9829aa2736cf",
    kind: "ip_address",
    value: "203.0.113.42",
    confidence: 40,
    source: "oathnet_lookup",
    created_at: NOW,
    metadata: {
      via: "oathnet", status: "observed", query_types: [],
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
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
      breach_corpora: ["ExampleCorp", "TestVendor"],
      breach_corpus_count: 2,
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  },
];

const SEED_VALUE = "test subject ca";

describe("promote boundary — buildIdentityClusters vs subject_unlinked (2026-08-10, thread 88cf94fa shape)", () => {
  it("REPRODUCTION: quarantined artifact ids must not appear in any cluster's member list", () => {
    const quarantinedIds = new Set(
      FIXTURE.filter((a) => isSubjectUnlinked(a.metadata)).map((a) => a.id),
    );
    expect(quarantinedIds.size).toBe(8); // sanity: matches the real thread's count

    const report = buildIdentityClusters(FIXTURE, SEED_VALUE);
    const clusterMemberIds = report.clusters.flatMap((c: IdentityCluster) => c.artifacts.map((a) => a.id));
    const leakedIds = clusterMemberIds.filter((id) => quarantinedIds.has(id));

    // THIS IS THE FAILING ASSERTION. Root cause: buildIdentityClusters (src/lib/intel.ts:1603)
    // has zero references to isSubjectUnlinked anywhere in its body — confirmed by direct
    // inspection, not inference. It clusters on value-derived signals (email/phone/handle/
    // shared-infrastructure) with no quarantine check at any stage, so every subject_unlinked
    // artifact that carries a clustering signal (all 8 here — 2 phone, 2 address, 2 email,
    // 1 breach_exposure via its own value string, 1 ip_address) gets bucketed exactly like a
    // linked one.
    expect(leakedIds).toEqual([]);
  });
});
