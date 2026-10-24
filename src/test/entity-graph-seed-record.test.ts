// A seed and an artifact holding the SAME selector are one entity. The graph drew them as two nodes joined by an
// identity edge counted as "1 real link" (measured 2026-10-24, audited case). Seed-record association is provenance,
// not a relationship; real links between distinct entities must survive.
import { describe, expect, it } from "vitest";
import { buildEntityGraph, SEED_ID } from "@/lib/entity-graph";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const A = (o: Partial<Artifact>): Artifact => ({
  id: "a", kind: "email", value: "x@y.com", confidence: 50, source: "t",
  created_at: "2026-06-01T00:00:00Z", metadata: null, ...o,
});
const identity = (g: ReturnType<typeof buildEntityGraph>) => g.edges.filter((e) => e.type === "identity");

describe("seed ↔ same-selector artifact", () => {
  it("one email seed + one same-email artifact → zero distinct-entity relationships", () => {
    const g = buildEntityGraph([A({ id: "z" })], "x@y.com", "email");
    expect(g.stats.realEdgeCount).toBe(0);
    expect(identity(g)).toEqual([]);
    expect(g.nodes.find((n) => n.id === "z")).toBeTruthy(); // the record stays inspectable
    expect(g.nodes.find((n) => n.id === SEED_ID)).toBeTruthy();
  });

  it("case and whitespace variants of the same email are the same entity", () => {
    const g = buildEntityGraph([A({ id: "z", value: "  X@Y.COM " })], "x@y.com", "email");
    expect(g.stats.realEdgeCount).toBe(0);
    expect(identity(g)).toEqual([]);
  });

  it("same for a username seed and a handle-normalised artifact", () => {
    const g = buildEntityGraph([A({ id: "z", kind: "username", value: "@Jd_Case" })], "jd_case", "username");
    expect(g.stats.realEdgeCount).toBe(0);
  });

  it("two independent artifacts holding the seed selector still link to EACH OTHER", () => {
    const g = buildEntityGraph([A({ id: "a1", confidence: 60 }), A({ id: "a2", confidence: 55, source: "other" })], "x@y.com", "email");
    expect(identity(g)).toHaveLength(1);
    expect(identity(g)[0].reason).toMatch(/Shares email/);
    expect(g.stats.realEdgeCount).toBe(1);
  });

  it("a distinct selector shared by the seed record and another artifact is a real link", () => {
    const g = buildEntityGraph(
      [
        A({ id: "rec", value: "x@y.com", metadata: { handle: "shared_handle" } }),
        A({ id: "other", kind: "username", value: "shared_handle" }),
      ],
      "x@y.com",
      "email",
    );
    expect(identity(g).map((e) => [e.source, e.target].sort().join())).toEqual(["other,rec"]);
  });

  it("unrelated artifacts keep their faint seed-discovery tie and count as isolated", () => {
    const g = buildEntityGraph([A({ id: "z" }), A({ id: "n", kind: "phone", value: "925-813-9324" })], "x@y.com", "email");
    expect(g.stats.realEdgeCount).toBe(0);
    expect(g.stats.isolatedCount).toBe(1); // the phone, not the seed's own record
  });

  it("a DIFFERENT entity carrying the seed's selector in metadata keeps its link to the seed (Codex P2 on #866)", () => {
    const g = buildEntityGraph(
      [A({ id: "mail", kind: "email", value: "jordan@example.com", metadata: { handle: "jordan" } })],
      "jordan",
      "username",
    );
    const e = g.edges.find((x) => x.type === "identity");
    expect(e).toBeTruthy();
    expect([e!.source, e!.target].sort()).toEqual([SEED_ID, "mail"].sort());
    expect(g.stats.realEdgeCount).toBe(1);
  });

  it("the seed's own record and a metadata carrier of the same selector: only the carrier is a relationship", () => {
    const g = buildEntityGraph(
      [
        A({ id: "rec", kind: "username", value: "jordan" }),
        A({ id: "mail", kind: "email", value: "jordan@example.com", metadata: { handle: "jordan" } }),
      ],
      "jordan",
      "username",
    );
    expect(identity(g).map((e) => [e.source, e.target].sort().join())).toEqual([[SEED_ID, "mail"].sort().join()]);
  });
});
