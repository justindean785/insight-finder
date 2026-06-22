import { describe, it, expect } from "vitest";
import { buildEntityGraph, SEED_ID, type EntityGraph } from "@/lib/entity-graph";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const A = (over: Partial<Artifact> = {}): Artifact => ({
  id: over.id ?? "a",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  confidence: over.confidence ?? 50,
  source: over.source ?? "test",
  created_at: over.created_at ?? "2026-06-01T00:00:00Z",
  metadata: over.metadata ?? null,
});

const edgeBetween = (g: EntityGraph, a: string, b: string) =>
  g.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));

describe("buildEntityGraph — honest, deterministic edge derivation", () => {
  it("is deterministic: identical input → identical output (incl. positions)", () => {
    const arts = [
      A({ id: "a1", kind: "email", value: "scero@me.com", confidence: 80 }),
      A({ id: "a2", kind: "username", value: "nuhdeem", confidence: 60 }),
      A({ id: "a3", kind: "phone", value: "925-813-9324", confidence: 55 }),
      A({ id: "a4", kind: "ip", value: "98.207.141.88", confidence: 40 }),
    ];
    const g1 = buildEntityGraph(arts, "scero@me.com", "email");
    const g2 = buildEntityGraph(arts, "scero@me.com", "email");
    expect(JSON.stringify(g1)).toEqual(JSON.stringify(g2));
  });

  it("connects two artifacts that share a selector (phone)", () => {
    const g = buildEntityGraph(
      [
        A({ id: "p1", kind: "phone", value: "(925) 813-9324", confidence: 70 }),
        A({ id: "p2", kind: "name", value: "Tacio Cero", confidence: 50, metadata: {} }),
        A({ id: "p3", kind: "phone", value: "925-813-9324", confidence: 50 }),
      ],
      null,
      null,
    );
    const e = edgeBetween(g, "p1", "p3");
    expect(e).toBeTruthy();
    expect(e!.type).toBe("identity");
    expect(e!.reason.toLowerCase()).toContain("phone");
  });

  it("uses a STAR not a clique: N nodes sharing one selector → N-1 edges", () => {
    // Three records carrying the same handle (one platform each).
    const g = buildEntityGraph(
      [
        A({ id: "h1", kind: "username", value: "nuhdeem", confidence: 90 }),
        A({ id: "h2", kind: "social", value: "nuhdeem (ig)", confidence: 70, metadata: { handle: "nuhdeem" } }),
        A({ id: "h3", kind: "music_profile", value: "Nuh D", confidence: 60, metadata: { handle: "nuh.deem" } }),
      ],
      null,
      null,
    );
    expect(g.edges).toHaveLength(2); // star, not 3 (clique)
    expect(g.edges.every((e) => e.type === "identity")).toBe(true);
    // Hero is the highest-confidence holder (h1); both edges touch it.
    expect(g.edges.every((e) => e.source === "h1" || e.target === "h1")).toBe(true);
  });

  it("treats shared infrastructure (IP) as a weak shared-infra link, never identity", () => {
    const g = buildEntityGraph(
      [
        A({ id: "i1", kind: "ip", value: "98.207.141.88", confidence: 40 }),
        A({ id: "i2", kind: "ip", value: "98.207.141.88", confidence: 40 }),
      ],
      null,
      null,
    );
    const e = edgeBetween(g, "i1", "i2");
    expect(e!.type).toBe("shared-infra");
    expect(e!.reason.toLowerCase()).toContain("infrastructure");
  });

  it("invents no edges: unrelated artifacts with no shared selector and no seed stay unconnected", () => {
    const g = buildEntityGraph(
      [
        A({ id: "u1", kind: "email", value: "a@x.com", confidence: 60 }),
        A({ id: "u2", kind: "email", value: "b@y.com", confidence: 60 }),
      ],
      null,
      null,
    );
    expect(g.edges).toHaveLength(0);
  });

  it("excludes collision artifacts from seeding identity edges", () => {
    const g = buildEntityGraph(
      [
        A({ id: "c1", kind: "phone", value: "555-123-4567", confidence: 60 }),
        A({ id: "c2", kind: "phone", value: "555-123-4567", confidence: 60, metadata: { collision: true } }),
      ],
      null,
      null,
    );
    expect(edgeBetween(g, "c1", "c2")).toBeUndefined();
    expect(g.nodes.find((n) => n.id === "c2")!.conflict).toBe(true);
  });

  it("excludes ALL conflict rows (breach / metadata.conflict / *_conflict), not just collisions, from identity edges", () => {
    const g = buildEntityGraph(
      [
        A({ id: "u", kind: "username", value: "nuhdeem", confidence: 80 }),
        // A breach row carrying the same handle must NOT forge an identity link.
        A({ id: "b", kind: "breach", value: "Acme leak", confidence: 50, metadata: { handle: "nuhdeem" } }),
        // A metadata.conflict row sharing the same handle, likewise.
        A({ id: "x", kind: "social", value: "nuhdeem (x)", confidence: 50, metadata: { handle: "nuhdeem", conflict: true } }),
      ],
      null,
      null,
    );
    expect(edgeBetween(g, "u", "b")).toBeUndefined();
    expect(edgeBetween(g, "u", "x")).toBeUndefined();
    expect(g.nodes.find((n) => n.id === "b")!.conflict).toBe(true);
    expect(g.nodes.find((n) => n.id === "x")!.conflict).toBe(true);
  });

  it("does not count a node with a real edge as isolated, even if it also has a parent→seed edge", () => {
    // 'm' shares a phone with peer 'p' (a real identity edge) AND carries a
    // parent pointer to the seed (a separate seed-discovery edge). Counting
    // seed-discovery EDGES would wrongly flag 'm' as isolated; counting nodes
    // with zero real edges does not.
    const g = buildEntityGraph(
      [
        A({ id: "m", kind: "phone", value: "555-0001", confidence: 70, metadata: { parent: "scero@me.com" } }),
        A({ id: "p", kind: "phone", value: "555-0001", confidence: 60 }),
      ],
      "scero@me.com",
      "email",
    );
    expect(edgeBetween(g, "m", "p")!.type).toBe("identity");
    expect(g.stats.isolatedCount).toBe(0);
  });

  it("the seed-discovery fallback ties an isolated node to the seed (faint, not a real edge)", () => {
    const g = buildEntityGraph([A({ id: "n1", kind: "name", value: "Bob", confidence: 30 })], "scero@me.com", "email");
    const e = edgeBetween(g, SEED_ID, "n1");
    expect(e!.type).toBe("seed-discovery");
    expect(g.stats.realEdgeCount).toBe(0);
    expect(g.stats.isolatedCount).toBe(1);
  });

  it("connects the seed to an artifact that carries the seed value", () => {
    const g = buildEntityGraph([A({ id: "z", kind: "email", value: "x@y.com", confidence: 70 })], "x@y.com", "email");
    const e = edgeBetween(g, SEED_ID, "z");
    expect(e!.type).toBe("identity");
    expect(g.stats.nodeCount).toBe(1); // seed excluded from nodeCount
  });

  it("handles the empty case", () => {
    const g = buildEntityGraph([], null, null);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
    expect(g.stats.nodeCount).toBe(0);
  });
});
