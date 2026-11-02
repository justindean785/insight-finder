import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { assessArtifacts, diffAssessments, formatDelta, linkageWord, SUPPORTED_LINKAGE_MIN } from "@/lib/agent-assessment";
import { displayConfidence } from "@/lib/display-confidence";

/**
 * R2 of the Case-desk revamp: the AI's per-artifact assessment is derived from
 * the engines that already exist (cluster engine, display confidence, source
 * classes, quarantine / collision predicates) and never invents a score.
 */

const SEED = "j.harker@northgate-logistics.com";
const T = "2026-10-20T09:51:00Z";

const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "exa_search", created_at: T, metadata: {}, ...over,
});

const seedRow = art({ id: "seed", kind: "email", value: SEED, confidence: 88, source: "hunter_verify", metadata: { sources: ["hunter_verify", "exa_search"], source_category: ["provider", "independent_public"] } });
// A profile that carries the seed email in its metadata: EMAIL_MATCH joins it to the seed.
const linkedProfile = art({ id: "prof", kind: "social_profile", value: "https://social.example/jharker_ops", confidence: 72, source: "socialfetch", metadata: { email: SEED, handle: "jharker_ops", platform: "Social", source_category: ["social_profile"] } });
// The handle the profile carries: HANDLE_MATCH joins it too.
const linkedHandle = art({ id: "handle", kind: "username", value: "jharker_ops", confidence: 74, source: "username_sweep", metadata: { source_category: ["username_sweep"] } });
// A phone nothing joins to the seed.
const loosePhone = art({ id: "phone", kind: "phone", value: "+1 415 555 0142", confidence: 55, source: "indicia_person", metadata: { source_category: ["data_broker"] } });
// A name alone.
const nameOnly = art({ id: "name", kind: "name", value: "James Harker", confidence: 65, source: "exa_search", metadata: { source_category: ["independent_public", "public_record"] } });
// Quarantined: harvested from a name-only query.
const quarantined = art({ id: "q", kind: "email", value: "jim.harker@example.net", confidence: 70, source: "indicia_person", metadata: { email: SEED, subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — linkage to the subject is unproven" } });
// A namesake flagged by the pipeline.
const collision = art({ id: "col", kind: "email", value: "j.harker@harker-legal.example", confidence: 88, source: "hunter_verify", metadata: { possible_collision: true, reason_not_confirmed: "a second James Harker — attorney, Sacramento — matches the queried name but nothing else" } });
// A row that contradicts the record.
const conflict = art({ id: "con", kind: "location", value: "Stockton, California, US", confidence: 38, source: "indicia_person", metadata: { conflict: true, conflict_note: "contradicts the Oakland record from the same broker" } });
// A capped row: stored 70, server cap 60.
const capped = art({ id: "cap", kind: "ip", value: "203.0.113.57", confidence: 70, source: "oathnet_lookup", metadata: { confidence_cap_applied: 60, reason_for_confidence: "single source class: breach", source_category: ["breach"] } });
// Meta rows are skipped by every counting surface.
const metaRow = art({ id: "meta", kind: "cluster_decision", value: "cluster 1 kept", confidence: null, source: null });

const ALL = [seedRow, linkedProfile, linkedHandle, loosePhone, nameOnly, quarantined, collision, conflict, capped, metaRow];

describe("assessArtifacts — subject linkage comes from the cluster engine", () => {
  const r = assessArtifacts(ALL, SEED);

  it("the seed row is linkage 100, supported, and says so", () => {
    const s = r.byId.seed;
    expect(s.isSeed).toBe(true);
    expect(s.subjectLinkage).toBe(100);
    expect(s.group).toBe("supported");
    expect(s.verdict).toBe("The seed itself");
    expect(r.seedClusterId).toBe(s.clusterId);
  });

  it("a row joined to the seed by a concrete selector takes its cluster's score, never a number of its own", () => {
    const p = r.byId.prof;
    expect(p.linkedToSeed).toBe(true);
    const cluster = r.clusters.find((c) => c.id === p.clusterId)!;
    expect(p.subjectLinkage).toBe(Math.round(cluster.confidence));
    expect(p.clusterSize).toBe(cluster.artifacts.length);
    expect(p.reasons.some((x) => /cluster/i.test(x))).toBe(true);
    // The handle the profile carries rides the same cluster.
    expect(r.byId.handle.linkedToSeed).toBe(true);
    expect(r.byId.handle.clusterId).toBe(p.clusterId);
  });

  it("a selector nothing joins to the seed is unresolved: null linkage, not 0", () => {
    const ph = r.byId.phone;
    expect(ph.subjectLinkage).toBeNull();
    expect(ph.group).toBe("unresolved");
    expect(ph.linkedToSeed).toBe(false);
    expect(ph.reasons.join(" ")).toMatch(/No shared email, phone, handle or infrastructure/);
  });

  it("a name-only match tops out at unresolved, whatever its confidence", () => {
    const n = r.byId.name;
    expect(n.subjectLinkage).toBeNull();
    expect(n.group).toBe("unresolved");
    expect(n.reasons.join(" ")).toMatch(/A name alone is never linkage/);
    // Finding support is still reported: the name may well be real.
    expect(n.findingSupport).toBe(65);
  });

  it("a quarantined row gets no linkage figure, even though its metadata carries the seed email", () => {
    const q = r.byId.q;
    expect(q.group).toBe("quarantined");
    expect(q.subjectLinkage).toBeNull();
    expect(q.linkedToSeed).toBe(false);
    expect(q.opposing[0]).toMatch(/harvested from a name-only query/);
    expect(q.verdict).toMatch(/Withheld/);
  });

  it("a collision-flagged namesake is quarantined with the pipeline's own reason", () => {
    const c = r.byId.col;
    expect(c.group).toBe("quarantined");
    expect(c.subjectLinkage).toBeNull();
    expect(c.opposing.join(" ")).toMatch(/second James Harker/);
  });

  it("a contradicting row is the conflict group and quotes its note", () => {
    const c = r.byId.con;
    expect(c.group).toBe("conflict");
    expect(c.opposing.join(" ")).toMatch(/contradicts the Oakland record/);
    expect(c.verdict).toMatch(/Contradicts/);
  });

  it("finding support is displayConfidence(a).effective — the capped figure — and the cap is opposing evidence", () => {
    const c = r.byId.cap;
    expect(c.findingSupport).toBe(displayConfidence(capped).effective);
    expect(c.findingSupport).toBe(60);
    expect(c.opposing.join(" ")).toMatch(/capped at 60/);
  });

  it("independent source classes are the engine's, listed by name", () => {
    expect(r.byId.seed.independentClasses).toEqual(["provider", "independent_public"]);
    expect(r.byId.seed.reasons.join(" ")).toMatch(/2 independent source classes/);
  });

  it("meta rows are skipped and the groups sum to the rows assessed", () => {
    expect(r.byId.meta).toBeUndefined();
    const total = Object.values(r.counts).reduce((s, n) => s + n, 0);
    expect(total).toBe(r.items.length);
    expect(r.items.length).toBe(ALL.length - 1);
    expect(r.counts.quarantined).toBe(2);
    expect(r.counts.conflict).toBe(1);
  });

  it("verdicts reach the cluster engine only: a rejected joiner links nothing, and no figure or word reads a verdict", () => {
    const joiner = art({ id: "rec", kind: "person", value: "James Harker", metadata: { email: SEED, phone: "+1 415 555 0142", source_category: ["data_broker"] } });
    const open = assessArtifacts([seedRow, loosePhone, joiner], SEED);
    expect(open.byId.phone.linkedToSeed).toBe(true);
    const rejected = assessArtifacts([seedRow, loosePhone, joiner], SEED, { rec: "wrong" });
    expect(rejected.byId.phone.linkedToSeed).toBe(false);
    expect(rejected.byId.phone.subjectLinkage).toBeNull();
    // The seed's own reading does not move with a verdict on it: the analyst's
    // word is shown beside the assessment, never folded into it.
    const confirmedSeed = assessArtifacts([seedRow, loosePhone], SEED, { seed: "confirmed" });
    expect(confirmedSeed.byId.seed.findingSupport).toBe(open.byId.seed.findingSupport);
    expect(confirmedSeed.byId.seed.verdict).toBe(open.byId.seed.verdict);
  });

  it("never writes a review", () => {
    const src = readFileSync(resolve(__dirname, "..", "lib", "agent-assessment.ts"), "utf8");
    expect(src).not.toMatch(/setReview|useReviewStates|artifact_reviews|supabase\.from\(|@\/integrations\/supabase/);
  });

  it("supported means linkage at or above the cluster board's 'Likely link' rung", () => {
    for (const it of r.items) {
      if (it.group === "supported") expect(it.subjectLinkage ?? 0).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
      if (it.group === "unresolved") expect(it.subjectLinkage === null || it.subjectLinkage < SUPPORTED_LINKAGE_MIN).toBe(true);
    }
  });

  it("no seed: nothing is linked, nothing is 100", () => {
    const none = assessArtifacts(ALL, null);
    expect(none.seedClusterId).toBeNull();
    expect(none.items.every((i) => i.subjectLinkage === null)).toBe(true);
    expect(none.items.every((i) => i.group !== "supported")).toBe(true);
  });
});

describe("linkageWord", () => {
  it("has one sentence per rung and never says 'confirmed'", () => {
    const words = [100, 85, 65, 45, 10].map((n) => linkageWord(n, "supported"));
    expect(new Set(words).size).toBe(5);
    for (const w of [...words, linkageWord(null, "unresolved"), linkageWord(null, "quarantined"), linkageWord(null, "conflict")]) {
      expect(w.toLowerCase()).not.toContain("confirmed");
    }
  });
});

describe("diffAssessments / formatDelta", () => {
  it("first assessment has nothing to compare: every delta is null", () => {
    const r = assessArtifacts(ALL, SEED);
    const d = diffAssessments(null, r.byId);
    expect(Object.values(d).every((x) => x.linkage === null && x.support === null && x.from === null)).toBe(true);
    expect(d.seed.to).toBe("supported");
  });

  it("a figure that was null on either side yields a null delta, never a fabricated jump", () => {
    const before = assessArtifacts([seedRow, loosePhone], SEED).byId;
    // The phone becomes linked by a record that carries both selectors.
    const joiner = art({ id: "rec", kind: "person", value: "James Harker", metadata: { email: SEED, phone: "+1 415 555 0142", source_category: ["data_broker"] } });
    const after = assessArtifacts([seedRow, loosePhone, joiner], SEED).byId;
    const d = diffAssessments(before, after);
    expect(after.phone.subjectLinkage).not.toBeNull();
    expect(d.phone.linkage).toBeNull();
    expect(d.phone.from).toBe("unresolved");
    expect(d.phone.to).toBe(after.phone.group);
    expect(d.seed.linkage).toBe(0);
  });

  it("formatDelta signs and rounds, and is silent on zero", () => {
    expect(formatDelta(12)).toBe("+12");
    expect(formatDelta(-3.6)).toBe("−4");
    expect(formatDelta(0)).toBeNull();
    expect(formatDelta(null)).toBeNull();
  });
});
