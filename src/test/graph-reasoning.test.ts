import { describe, it, expect } from "vitest";
import { buildNodes, SOURCE_CLASS_WEIGHT, type ArtifactInput } from "../../supabase/functions/osint-agent/graph.ts";
import {
  inferEdges,
  clusterGraph,
  propagateConfidence,
  personLabel,
  type GraphEdge,
} from "../../supabase/functions/osint-agent/graph_reasoning.ts";

// Phase 2/3 reasoning layer, built around the audited trace 65910da5:
// the boobz_sexy (sexy_boobz) persona vs the Aladewura Adegboyega entrepreneur
// sharing one email selector.

const EMAIL = "taylorquinn@example.com";

const aladewura: ArtifactInput = {
  kind: "name", value: "Aladewura Adegboyega", source: "minimax_web_search (news)",
  confidence: 80, metadata: { parent: EMAIL, source_category: ["news"] },
};
const hadegold: ArtifactInput = {
  kind: "organization", value: "Hadegold Media", source: "minimax_web_search (news)",
  confidence: 80, metadata: { parent: EMAIL, founder: "Aladewura Adegboyega", source_category: ["news"] },
};
const boobz: ArtifactInput = {
  kind: "username", value: "https://x.com/boobz_sexy", source: "socialfetch_lookup (Twitter)",
  confidence: 70, metadata: { parent: EMAIL, display_name: "sexy_boobz", platform_hits: 22, source_category: ["social_profile_active"] },
};

function graphOf(arts: ArtifactInput[]) {
  const nodes = buildNodes(arts);
  const edges = inferEdges(nodes);
  const clustering = clusterGraph(nodes, edges);
  return { nodes, edges, clustering };
}
const nodeId = (type: string, value: string) => `${type}:${value}`;

describe("1. cluster split — boobz_sexy vs Aladewura Adegboyega", () => {
  it("splits one contaminated selector into two identity clusters", () => {
    const { clustering } = graphOf([aladewura, hadegold, boobz]);
    // person+org share the 'aladewura adegboyega' identity; boobz_sexy is its own
    expect(clustering.clusters.filter((c) => c.conflicted).length).toBeGreaterThanOrEqual(2);

    const personC = clustering.clusters.find((c) => c.nodeIds.includes(nodeId("person", "aladewura adegboyega")));
    const boobzC = clustering.clusters.find((c) => c.nodeIds.includes(nodeId("username", "boobz_sexy")));
    expect(personC).toBeTruthy();
    expect(boobzC).toBeTruthy();
    expect(personC!.id).not.toBe(boobzC!.id); // different clusters
    // the org rides with its founder, not with the persona
    expect(personC!.nodeIds).toContain(nodeId("organization", "hadegold media"));
  });
});

describe("2. multiple person names on one selector → contradiction edge", () => {
  it("emits a contradicts edge between two distinct people on the same selector", () => {
    const demos: ArtifactInput = {
      kind: "name", value: "John Demos", source: "twitter", confidence: 60,
      metadata: { parent: EMAIL, source_category: ["social_profile_active"] },
    };
    const { clustering } = graphOf([aladewura, demos]);
    expect(clustering.contradictions.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(clustering.contradictions.flatMap((e) => [e.from, e.to]));
    expect(ids.has(nodeId("person", "aladewura adegboyega"))).toBe(true);
    expect(ids.has(nodeId("person", "john demos"))).toBe(true);
  });
});

describe("3. contradiction penalty propagates across the cluster", () => {
  it("lowers a member's confidence vs the same node in a clean cluster", () => {
    const { nodes, edges, clustering } = graphOf([aladewura, hadegold, boobz]); // conflicted
    const person = nodes.find((n) => n.id === nodeId("person", "aladewura adegboyega"))!;
    const conflictedScore = propagateConfidence(person, nodes, edges, clustering);
    expect(conflictedScore.conflicted).toBe(true);
    expect(conflictedScore.penalty).toBe(15);

    // clean baseline: same person + org, no competing persona
    const clean = graphOf([aladewura, hadegold]);
    const cleanPerson = clean.nodes.find((n) => n.id === nodeId("person", "aladewura adegboyega"))!;
    const cleanScore = propagateConfidence(cleanPerson, clean.nodes, clean.edges, clean.clustering);
    expect(cleanScore.conflicted).toBe(false);
    expect(cleanScore.adjusted).toBeGreaterThan(conflictedScore.adjusted);
  });
});

describe("4. support and contradiction both contribute", () => {
  it("applies base + support − penalty together", () => {
    const { nodes, edges, clustering } = graphOf([aladewura, hadegold, boobz]);
    const person = nodes.find((n) => n.id === nodeId("person", "aladewura adegboyega"))!;
    const s = propagateConfidence(person, nodes, edges, clustering);
    expect(s.support).toBeGreaterThan(0); // works_for edge from Hadegold
    expect(s.penalty).toBe(15);          // conflicted cluster
    expect(s.adjusted).toBe(Math.max(0, Math.min(s.base + s.support - s.penalty, 100)));
  });
});

describe("5. generic-handle detection integrates with graph scoring", () => {
  it("keeps an over-broad handle capped at the generic weight even with support", () => {
    const handleArt: ArtifactInput = {
      kind: "username", value: "aladewuraadegboyega", source: "username_sweep",
      confidence: 45, metadata: { parent: EMAIL, platform_hits: 22, source_category: ["username_sweep"] },
    };
    const { nodes, clustering } = graphOf([aladewura, hadegold, handleArt]);
    const handle = nodes.find((n) => n.id === nodeId("username", "aladewuraadegboyega"))!;
    // give it generous (fake) support to prove the cap holds
    const supportEdges: GraphEdge[] = [
      { from: handle.id, to: "x:1", type: "supports", source: "t", weight: 1 },
      { from: handle.id, to: "x:2", type: "supports", source: "t", weight: 1 },
      { from: handle.id, to: "x:3", type: "supports", source: "t", weight: 1 },
    ];
    const liveNeighbors = ["x:1", "x:2", "x:3"].map((id) => ({
      id, type: "email" as const, value: id, raw: id, evidence: [], metadata: {},
    }));
    const s = propagateConfidence(handle, [...nodes, ...liveNeighbors], supportEdges, clustering);
    expect(s.overBroad).toBe(true);
    expect(s.adjusted).toBeLessThanOrEqual(SOURCE_CLASS_WEIGHT.generic);
  });
});

describe("6. dead-end / exhausted nodes do not strengthen neighbors", () => {
  it("a supports edge to a dead-end node yields no boost", () => {
    const nodes = buildNodes([aladewura]);
    const person = nodes[0];
    const deadDomain = {
      id: "domain:example.com", type: "domain" as const, value: "example.com",
      raw: "example.com", evidence: [], metadata: { status: "exhausted", note: "defunct or parked domain" },
    };
    const liveDomain = {
      id: "domain:live.com", type: "domain" as const, value: "live.com",
      raw: "live.com", evidence: [], metadata: { status: "verified" },
    };
    const clustering = { clusters: [], contradictions: [] };

    const deadEdge: GraphEdge[] = [{ from: person.id, to: deadDomain.id, type: "supports", source: "t", weight: 1 }];
    const liveEdge: GraphEdge[] = [{ from: person.id, to: liveDomain.id, type: "supports", source: "t", weight: 1 }];

    const withDead = propagateConfidence(person, [person, deadDomain], deadEdge, clustering);
    const withLive = propagateConfidence(person, [person, liveDomain], liveEdge, clustering);

    expect(withDead.support).toBe(0);
    expect(withLive.support).toBeGreaterThan(0);
  });
});

describe("personLabel", () => {
  it("derives the asserted identity per node type", () => {
    const [n] = buildNodes([boobz]);
    expect(personLabel(n)).toBe("sexy_boobz");
    const [p] = buildNodes([aladewura]);
    expect(personLabel(p)).toBe("aladewura adegboyega");
    const [o] = buildNodes([hadegold]);
    expect(personLabel(o)).toBe("aladewura adegboyega");
  });
});
