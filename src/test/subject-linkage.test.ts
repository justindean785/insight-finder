import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { assessArtifacts, SUPPORTED_LINKAGE_MIN, type AgentAssessment } from "@/lib/agent-assessment";
import { profileOwnership } from "@/lib/subject-linkage";

/**
 * Audit A01: the positive ownership rule behind the Subject Profile's contact
 * fields. Two layers:
 *  - the rule itself, on hand-built assessments, so each branch and the
 *    threshold edge are pinned without depending on cluster scoring;
 *  - the rule on REAL `assessArtifacts` output, so the cases that matter
 *    (quarantined seed, analyst-confirmed associate) are proven end to end.
 * Every value is synthetic and uses a reserved domain.
 */

const base: AgentAssessment = {
  artifactId: "x",
  group: "unresolved",
  findingSupport: 50,
  subjectLinkage: null,
  verdict: "",
  reasons: [],
  opposing: [],
  clusterId: null,
  clusterSize: 0,
  linkedToSeed: false,
  independentClasses: [],
  backendClusterId: null,
  tier: "possible",
  isSeed: false,
};
const assessed = (over: Partial<AgentAssessment>): AgentAssessment => ({ ...base, ...over });

describe("profileOwnership — the rule, in order", () => {
  it("direct seed: the supplied seed is the subject's", () => {
    expect(profileOwnership(assessed({ isSeed: true, subjectLinkage: 100, group: "supported" }))).toBe("subject");
  });

  it("supported link: linked to the seed at or above the support threshold", () => {
    expect(profileOwnership(assessed({ linkedToSeed: true, subjectLinkage: SUPPORTED_LINKAGE_MIN, group: "supported" }))).toBe("subject");
    expect(profileOwnership(assessed({ linkedToSeed: true, subjectLinkage: 85, group: "supported" }))).toBe("subject");
  });

  it("weak link: linked to the seed below the threshold stays unresolved", () => {
    expect(profileOwnership(assessed({ linkedToSeed: true, subjectLinkage: SUPPORTED_LINKAGE_MIN - 1 }))).toBe("unresolved");
    expect(profileOwnership(assessed({ linkedToSeed: true, subjectLinkage: 40 }))).toBe("unresolved");
  });

  it("null linkage is unresolved, never a low score, even when the row shares the seed's cluster", () => {
    expect(profileOwnership(assessed({ linkedToSeed: false, subjectLinkage: null }))).toBe("unresolved");
    expect(profileOwnership(assessed({ linkedToSeed: true, subjectLinkage: null }))).toBe("unresolved");
  });

  it("missing assessment (a meta row) is unresolved", () => {
    expect(profileOwnership(undefined)).toBe("unresolved");
  });

  it("quarantine wins over being the seed", () => {
    expect(profileOwnership(assessed({ isSeed: true, group: "quarantined", subjectLinkage: null }))).toBe("unresolved");
    // Even a malformed assessment that kept a figure must not pass.
    expect(profileOwnership(assessed({ isSeed: true, linkedToSeed: true, group: "quarantined", subjectLinkage: 100 }))).toBe("unresolved");
  });

  it("an unlinked row cannot qualify merely because it has a high score", () => {
    // Finding support is how sure we are the value is real, not whose it is.
    expect(profileOwnership(assessed({ findingSupport: 99, tier: "confirmed" }))).toBe("unresolved");
    // A linkage figure without the seed link is not linkage to the SUBJECT.
    expect(profileOwnership(assessed({ linkedToSeed: false, subjectLinkage: 99, findingSupport: 99 }))).toBe("unresolved");
  });
});

const SEED = "subject@example.test";
const T = "2026-11-13T12:00:00Z";
const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "exa_search", created_at: T, metadata: {}, ...over,
});

const seedRow = art({ id: "seed", kind: "email", value: SEED, confidence: 55 });
const associateEmail = art({ id: "assoc", kind: "email", value: "associate@example.test", confidence: 95, source: "web_scrape" });
const phone = art({ id: "phone", kind: "phone", value: "+1 555 555 0142", confidence: 55 });
// A record that carries both the seed email and the phone: the cluster engine joins them.
const joiner = art({ id: "rec", kind: "person", value: "Sam Example", metadata: { email: SEED, phone: "+1 555 555 0142", source_category: ["data_broker"] } });

describe("profileOwnership — on real assessArtifacts output", () => {
  it("the seed row is the subject's; a clean, higher-confidence associate email is not", () => {
    const r = assessArtifacts([seedRow, associateEmail], SEED);
    expect(profileOwnership(r.byId.seed)).toBe("subject");
    expect(r.byId.assoc.findingSupport).toBeGreaterThan(r.byId.seed.findingSupport ?? 0);
    expect(profileOwnership(r.byId.assoc)).toBe("unresolved");
  });

  it("an analyst-confirmed associate is still not the subject's: a verdict says real, not whose", () => {
    for (const verdict of ["confirmed", "key"] as const) {
      const r = assessArtifacts([seedRow, associateEmail], SEED, { assoc: verdict });
      expect(profileOwnership(r.byId.assoc)).toBe("unresolved");
    }
  });

  it("a quarantined seed row is not asserted for the subject", () => {
    const quarantinedSeed = art({ ...seedRow, metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" } });
    const r = assessArtifacts([quarantinedSeed], SEED);
    expect(r.byId.seed.isSeed).toBe(true);
    expect(r.byId.seed.group).toBe("quarantined");
    expect(profileOwnership(r.byId.seed)).toBe("unresolved");
  });

  it("a phone joined to the seed by a shared record follows the cluster's score against the threshold", () => {
    const r = assessArtifacts([seedRow, phone, joiner], SEED);
    const p = r.byId.phone;
    expect(p.linkedToSeed).toBe(true);
    expect(p.subjectLinkage).not.toBeNull();
    // Whatever the engine scores it, the rule must agree with the threshold.
    expect(profileOwnership(p)).toBe((p.subjectLinkage ?? 0) >= SUPPORTED_LINKAGE_MIN ? "subject" : "unresolved");
  });

  it("the same phone with no joining record is unresolved", () => {
    const r = assessArtifacts([seedRow, phone], SEED);
    expect(r.byId.phone.subjectLinkage).toBeNull();
    expect(profileOwnership(r.byId.phone)).toBe("unresolved");
  });
});
