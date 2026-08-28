import { describe, it, expect } from "vitest";
import { buildEntityGraph, SEED_ID, type EntityGraph } from "@/lib/entity-graph";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * The no-overlap invariant must hold for EVERY graph shape, including the one
 * with no unclustered nodes at all.
 *
 * `layout()` has three independent position producers — the fixed seed, cluster
 * blocks, and category wedges — and a single `relax()` pass afterwards is what
 * actually enforces "no two chips overlap". That pass used to sit after an
 * early `return` taken when every non-seed node belongs to a cluster, so the
 * shape with the most tightly packed blocks and no wedge ring to push against
 * was the one shape that never got relaxed.
 *
 * The criterion here is the same elliptical test `relax` applies — chips are
 * far wider than they are tall, so a circular test would both miss real
 * horizontal overlaps and flag vertical stacking that reads fine.
 */

const NODE_PITCH_X = 265;
const NODE_PITCH_Y = 56;
/**
 * `relax` converges toward the separation threshold and then quantises every
 * coordinate to 0.1px, so a settled pair lands a hair under 1.0 rather than
 * exactly on it (measured: 0.997–0.9997 — sub-pixel, invisible). Anything
 * inside 1% of the pitch is that rounding; a real collision is not close.
 */
const TOUCHING = 0.99;

const A = (over: Partial<Artifact>): Artifact =>
  ({
    id: over.id ?? "a",
    kind: over.kind ?? "email",
    value: over.value ?? "x@y.com",
    confidence: over.confidence ?? 60,
    source: over.source ?? "test",
    created_at: over.created_at ?? "2026-06-01T00:00:00Z",
    metadata: over.metadata ?? null,
  }) as Artifact;

/** Pairs closer than one chip-separation apart, by `relax`'s own measure. */
function overlappingPairs(g: EntityGraph): string[] {
  const out: string[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i];
      const b = g.nodes[j];
      const nx = (a.x - b.x) / NODE_PITCH_X;
      const ny = (a.y - b.y) / NODE_PITCH_Y;
      if (nx * nx + ny * ny < TOUCHING) out.push(`${a.id}↔${b.id}`);
    }
  }
  return out;
}

/** Every non-seed artifact shares one phone selector, so all of them cluster. */
function fullyClusteredGraph(n: number): EntityGraph {
  const arts: Artifact[] = [];
  for (let i = 0; i < n; i++) {
    arts.push(
      A({
        id: `e${i}`,
        kind: "email",
        value: `sam.cole+${i}@example.com`,
        metadata: { phone: "925-813-9324" },
      }),
    );
  }
  return buildEntityGraph(arts, "sam.cole@example.com", "email");
}

describe("graph layout — no-overlap invariant on a fully clustered graph", () => {
  it("has no unclustered nodes (the fixture exercises the early-return path)", () => {
    const g = fullyClusteredGraph(12);
    const nonSeed = g.nodes.filter((n) => n.id !== SEED_ID);
    expect(nonSeed.length).toBe(12);
    expect(nonSeed.filter((n) => !n.clusterId)).toHaveLength(0);
  });

  it("places no two chips on top of each other", () => {
    const g = fullyClusteredGraph(12);
    expect(overlappingPairs(g)).toEqual([]);
  });

  it("holds as the single cluster grows into multiple rows and columns", () => {
    for (const n of [4, 9, 16, 24]) {
      const g = fullyClusteredGraph(n);
      expect(overlappingPairs(g), `overlaps with ${n} clustered nodes`).toEqual([]);
    }
  });

  it("never lets a cluster block reach back over the fixed seed", () => {
    const g = fullyClusteredGraph(16);
    const seed = g.nodes.find((n) => n.id === SEED_ID)!;
    for (const n of g.nodes) {
      if (n.id === SEED_ID) continue;
      const nx = (n.x - seed.x) / NODE_PITCH_X;
      const ny = (n.y - seed.y) / NODE_PITCH_Y;
      expect(nx * nx + ny * ny, `${n.id} sits on the seed`).toBeGreaterThanOrEqual(TOUCHING);
    }
  });

  it("is still deterministic — the relax pass must not introduce drift", () => {
    expect(JSON.stringify(fullyClusteredGraph(16))).toEqual(
      JSON.stringify(fullyClusteredGraph(16)),
    );
  });
});

/**
 * Every coordinate must be a finite number, on every shape.
 *
 * The layout multiplies and divides through several derived radii, and one
 * NaN anywhere upstream propagates silently: `Math.max(x, NaN)` is NaN, so a
 * single poisoned cluster radius makes `innerR` NaN and every UNCLUSTERED node
 * lands at NaN — a blank graph with no error. Asserting finiteness across
 * shapes catches that class wherever it enters, rather than pinning the one
 * arithmetic path that produced it.
 */
describe("graph layout — coordinates are always finite", () => {
  const mixed = (clustered: number, loose: number): EntityGraph => {
    const arts: Artifact[] = [];
    for (let i = 0; i < clustered; i++) {
      arts.push(
        A({
          id: `c${i}`,
          kind: "email",
          value: `sam.cole+${i}@example.com`,
          metadata: { phone: "925-813-9324" },
        }),
      );
    }
    const kinds = ["domain", "ip", "username", "organization", "phone"];
    for (let i = 0; i < loose; i++) {
      arts.push(A({ id: `u${i}`, kind: kinds[i % kinds.length], value: `loose-${i}.example.com` }));
    }
    return buildEntityGraph(arts, "sam.cole@example.com", "email");
  };

  const shapes: [string, () => EntityGraph][] = [
    ["fully clustered", () => fullyClusteredGraph(12)],
    ["single cluster member", () => fullyClusteredGraph(1)],
    ["no artifacts at all", () => buildEntityGraph([], "sam.cole@example.com", "email")],
    ["no seed", () => buildEntityGraph([A({ id: "x", kind: "domain", value: "a.example.com" })], null, null)],
    ["clustered + unclustered", () => mixed(8, 14)],
    ["one cluster, many loose", () => mixed(2, 30)],
  ];

  for (const [name, build] of shapes) {
    it(`keeps every x/y finite — ${name}`, () => {
      for (const n of build().nodes) {
        expect(Number.isFinite(n.x), `${n.id}.x = ${n.x}`).toBe(true);
        expect(Number.isFinite(n.y), `${n.id}.y = ${n.y}`).toBe(true);
      }
    });
  }

  it("still separates chips when clustered and unclustered nodes mix", () => {
    expect(overlappingPairs(mixed(8, 14))).toEqual([]);
  });
});
