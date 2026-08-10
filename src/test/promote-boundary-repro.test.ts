/**
 * promote-boundary-repro.test.ts — DIAGNOSTIC, not yet part of any PR.
 *
 * Executes the real production `buildIdentityClusters` (src/lib/intel.ts) against
 * a fixture that reproduces thread 88cf94fa-660a-43f3-bad6-81291eb18641's EXACT
 * shape — same artifact ids, same kinds, same subject_unlinked flags, same
 * confidence values, same source — pulled from the live database on 2026-08-10.
 * Values (email/phone/address strings) are synthetic; CLAUDE.md forbids real
 * investigation PII entering this repo, and the leak this test targets does not
 * depend on what the values ARE, only on whether a quarantined artifact's ID
 * ends up inside a cluster's member list.
 *
 * Real thread facts (queried, not values):
 *   9 artifacts: 1 name (subject_unlinked NULL/false), 8 others all
 *   subject_unlinked=true — 2 phone, 2 address, 2 email, 1 breach_exposure,
 *   1 ip_address. Every row: source='oathnet_lookup', status='observed'.
 *
 * Scope note: this reproduction concerns ONLY quarantine leakage — whether a
 * subject_unlinked artifact's id appears among a cluster's member ids. It does
 * NOT assert a required total cluster count; whether the one clean unreviewed
 * name row should itself form a cluster is a separate policy question.
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
