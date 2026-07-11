// WP2 output-integrity at the report/render layer:
//  - related/associated entities are NOT promoted to co-equal candidate clusters,
//    and get their own "Related / Associated Entities" section (WP2-#7);
//  - disproven leads and unlinked cross-subject contacts are quarantined out of
//    the candidate clusters (WP2-#4/#6).
import { describe, it, expect } from "vitest";
import { buildIdentityClusters, buildReportMarkdown } from "@/lib/intel";
import {
  isCollisionArtifact,
  isRelatedEntity,
  relationshipToSubject,
} from "@/lib/report-hygiene";
import type { Artifact } from "@/hooks/useThreadArtifacts";

function mk(p: { id: string; kind: string; value: string; source?: string; confidence?: number; metadata?: Record<string, unknown> }): Artifact {
  return {
    id: p.id,
    kind: p.kind,
    value: p.value,
    confidence: p.confidence ?? 45,
    source: p.source ?? "socialfetch_lookup",
    created_at: "2026-07-11T16:19:49.981Z",
    metadata: p.metadata ?? null,
  };
}

describe("report-hygiene predicates", () => {
  it("isRelatedEntity / relationshipToSubject read the relationship field", () => {
    const a = mk({ id: "r", kind: "username", value: "raphousetvhq", metadata: { related_entity: true, relationship_to_subject: "co_appears_in_serp_with_seed" } });
    expect(isRelatedEntity(a)).toBe(true);
    expect(relationshipToSubject(a)).toBe("co_appears_in_serp_with_seed");
    expect(isCollisionArtifact(a)).toBe(false); // related is NOT a collision
  });
  it("isCollisionArtifact quarantines disproven reasons and cross-subject-scoped rows", () => {
    expect(isCollisionArtifact(mk({ id: "d", kind: "weak_lead", value: "pjmak.com", metadata: { reason: "domain_similar_letters_not_same_entity" } }))).toBe(true);
    expect(isCollisionArtifact(mk({ id: "x", kind: "weak_lead", value: "530 area code", metadata: { excluded_from_subject: true } }))).toBe(true);
  });
});

describe("WP2-#7 related entities are not co-equal subjects", () => {
  const seed = "pjsmakka";
  const artifacts: Artifact[] = [
    // the subject's own anchor profile (a real candidate identity)
    mk({ id: "seed", kind: "username", value: "https://www.instagram.com/pjsmakka/", metadata: { handle: "pjsmakka", anchor: true, provenance: "read_from_profile" } }),
    // amplifier accounts co-appearing in the SERP — RELATED, not subjects
    mk({ id: "rel1", kind: "username", value: "raphousetvhq", metadata: { handle: "raphousetvhq", related_entity: true, relationship_to_subject: "co_appears_in_serp_with_seed" } }),
    mk({ id: "rel2", kind: "username", value: "inmateswithtalent", metadata: { handle: "inmateswithtalent", related_entity: true, relationship_to_subject: "mentioned_in_seed_bio" } }),
    // a disproven collision lead
    mk({ id: "dis", kind: "excluded_collision", value: "pjmak.com", confidence: 10, metadata: { excluded_collision: true, excluded_reason: "disproven_by_reason" } }),
  ];

  it("buildIdentityClusters excludes related + collision artifacts from candidate clusters", () => {
    const { clusters } = buildIdentityClusters(artifacts, seed);
    const allIds = clusters.flatMap((c) => c.artifacts.map((a) => a.id));
    expect(allIds).toContain("seed");        // the subject IS a candidate cluster
    expect(allIds).not.toContain("rel1");    // related account is NOT a co-equal subject
    expect(allIds).not.toContain("rel2");
    expect(allIds).not.toContain("dis");     // disproven lead is quarantined
  });

  it("the report renders a Related / Associated Entities section listing them with their relationship", () => {
    const md = buildReportMarkdown({ seedValue: seed, seedType: "username", artifacts });
    expect(md).toContain("## Related / Associated Entities");
    expect(md).toContain("raphousetvhq");
    expect(md).toContain("co appears in serp with seed");
    // and they must NOT appear inside the candidate-cluster section as subjects:
    const clusterSection = md.split("## Related / Associated Entities")[0];
    expect(clusterSection.includes("Cluster") && clusterSection.includes("raphousetvhq")).toBe(false);
  });
});
