import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildEntityGraph, type EntityGraph } from "@/lib/entity-graph";
import { artifactsToClusterAudit } from "@/lib/audit/from-artifacts";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewAdjustment } from "@/lib/intel";

/**
 * An analyst Dismiss must bind on EVERY authority surface, not just the ones
 * that happened to be passed the reviews map.
 *
 * Three production call sites re-derived identity clusters without the analyst's
 * verdicts — the Graph tab, the report's hunter notes, and the cluster audit — so
 * a row the analyst had struck out kept its cluster membership, kept its identity
 * edges, and kept being graded as evidence. The controls existed; these surfaces
 * simply never consulted them.
 *
 * These tests DRIVE the real exported functions with real artifact shapes rather
 * than restating the predicate, and every positive assertion is paired with a
 * negative control — a confirmed row and an unreviewed row must be untouched, or
 * "the fix" is just silently deleting evidence.
 */

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

const nodeById = (g: EntityGraph, id: string) => g.nodes.find((n) => n.id === id);

/** Two rows sharing a phone selector — the shape that produces an identity edge. */
const SHARED_PHONE: Artifact[] = [
  A({ id: "keep", kind: "phone", value: "(925) 813-9324", confidence: 70 }),
  A({ id: "judged", kind: "phone", value: "925-813-9324", confidence: 55 }),
];

describe("buildEntityGraph — analyst verdicts bind on the link picture", () => {
  it("draws the identity edge when nothing has been reviewed (the baseline)", () => {
    const g = buildEntityGraph(SHARED_PHONE, null, null);
    expect(edgeBetween(g, "keep", "judged")).toBeTruthy();
    expect(nodeById(g, "judged")?.conflict).toBe(false);
  });

  it("drops the identity edge for a DISMISSED row and marks it inert", () => {
    const reviews: Record<string, ReviewAdjustment> = { judged: "dismissed" };
    const g = buildEntityGraph(SHARED_PHONE, null, null, reviews);
    expect(edgeBetween(g, "keep", "judged")).toBeUndefined();
    expect(nodeById(g, "judged")?.conflict).toBe(true);
    // Disclosure, not deletion — the row is still ON the graph, just inert.
    expect(nodeById(g, "judged")).toBeTruthy();
  });

  it("does the same for the legacy 'wrong' verdict", () => {
    const g = buildEntityGraph(SHARED_PHONE, null, null, { judged: "wrong" });
    expect(edgeBetween(g, "keep", "judged")).toBeUndefined();
    expect(nodeById(g, "judged")?.conflict).toBe(true);
  });

  it("NEGATIVE CONTROL — a confirmed row keeps its edge", () => {
    const g = buildEntityGraph(SHARED_PHONE, null, null, { judged: "confirmed" });
    expect(edgeBetween(g, "keep", "judged")).toBeTruthy();
    expect(nodeById(g, "judged")?.conflict).toBe(false);
  });

  it("NEGATIVE CONTROL — key and recheck are not rejections", () => {
    for (const state of ["key", "recheck"] as const) {
      const g = buildEntityGraph(SHARED_PHONE, null, null, { judged: state });
      expect(edgeBetween(g, "keep", "judged"), `${state} must keep its edge`).toBeTruthy();
      expect(nodeById(g, "judged")?.conflict).toBe(false);
    }
  });

  it("NEGATIVE CONTROL — a verdict on a DIFFERENT row changes nothing here", () => {
    const g = buildEntityGraph(SHARED_PHONE, null, null, { "some-other-id": "dismissed" });
    expect(edgeBetween(g, "keep", "judged")).toBeTruthy();
  });

  it("strips a dismissed row's CLUSTER MEMBERSHIP, not just its edges", () => {
    // Edges and cluster membership are two separate mechanisms in this module:
    // isConflict gates edge construction, while clusterId comes from
    // buildIdentityClusters. Gating only the edges leaves the rejected node
    // still badged as a member of the subject's identity cluster, which is the
    // same false claim in a different pixel. A mutation that stops forwarding
    // reviews into buildIdentityClusters passes every other test in this file.
    const clustered: Artifact[] = [
      A({ id: "m1", kind: "email", value: "sam.cole@example.com", confidence: 85 }),
      A({ id: "m2", kind: "username", value: "sam.cole", confidence: 80 }),
      A({ id: "m3", kind: "phone", value: "925-813-9324", confidence: 60 }),
    ];
    const seed = "sam.cole@example.com";

    const before = buildEntityGraph(clustered, seed, "email");
    const clusteredBefore = before.nodes.filter((n) => !n.isSeed && n.clusterId).map((n) => n.id);
    expect(clusteredBefore.length, "fixture must produce a cluster to be meaningful").toBeGreaterThan(0);
    const victim = clusteredBefore[0];

    const after = buildEntityGraph(clustered, seed, "email", { [victim]: "dismissed" });
    expect(after.nodes.find((n) => n.id === victim)?.clusterId).toBeNull();
    // Negative control: the OTHER clustered nodes keep their membership.
    for (const id of clusteredBefore.slice(1)) {
      expect(after.nodes.find((n) => n.id === id)?.clusterId, `${id} must keep its cluster`).not.toBeNull();
    }
  });

  it("omitting reviews entirely is unchanged behaviour (back-compat)", () => {
    const withUndefined = buildEntityGraph(SHARED_PHONE, null, null, undefined);
    const without = buildEntityGraph(SHARED_PHONE, null, null);
    expect(JSON.stringify(withUndefined)).toEqual(JSON.stringify(without));
  });

  it("stays deterministic once reviews are supplied", () => {
    const reviews: Record<string, ReviewAdjustment> = { judged: "dismissed" };
    const g1 = buildEntityGraph(SHARED_PHONE, null, null, reviews);
    const g2 = buildEntityGraph(SHARED_PHONE, null, null, reviews);
    expect(JSON.stringify(g1)).toEqual(JSON.stringify(g2));
  });
});

describe("artifactsToClusterAudit — a dismissed row is not gradeable evidence", () => {
  const CLUSTERED: Artifact[] = [
    A({ id: "e1", kind: "email", value: "sam.cole@example.com", confidence: 85 }),
    A({ id: "u1", kind: "username", value: "sam.cole", confidence: 80 }),
    A({ id: "bad", kind: "email", value: "sam.cole@example.com", confidence: 30, source: "broker" }),
  ];

  const allCellValues = (audits: ReturnType<typeof artifactsToClusterAudit>) =>
    audits.flatMap((c) => c.cells.map((cell) => cell.value));

  it("includes every row when no verdicts are supplied (the baseline)", () => {
    const audits = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com");
    expect(allCellValues(audits).length).toBeGreaterThan(0);
  });

  it("excludes a dismissed row from the audited cells", () => {
    const withAll = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com");
    const withVerdict = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com", { bad: "dismissed" });
    const before = allCellValues(withAll).length;
    const after = allCellValues(withVerdict).length;
    expect(after).toBeLessThan(before);
  });

  it("NEGATIVE CONTROL — a confirmed verdict removes nothing", () => {
    const withAll = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com");
    const confirmed = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com", { bad: "confirmed" });
    expect(allCellValues(confirmed).length).toEqual(allCellValues(withAll).length);
  });

  it("omitting reviews is unchanged behaviour (back-compat)", () => {
    const a = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com");
    const b = artifactsToClusterAudit(CLUSTERED, "sam.cole@example.com", undefined);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

/**
 * The defect was never in the lib functions — they always accepted `reviews`.
 * It was that three CALL SITES didn't pass it. Behavioural tests on the exported
 * functions cannot see that, so the call sites are pinned structurally, the same
 * way `network-drop-wiring.test.ts` and the edge suite's `reviews_wiring_test.ts`
 * pin theirs. This asserts wiring, not behaviour, and says so.
 */
describe("call-site wiring — every cluster consumer passes the analyst's verdicts", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("CaseReport passes reviews to hunter notes and the cluster audit", () => {
    const src = read("../components/panel/CaseReport.tsx");
    expect(src).toContain("buildHunterNotes(artifacts, seedValue, reviews)");
    expect(src).toContain("artifactsToClusterAudit(artifacts, seedValue, reviews)");
  });

  it("GraphTab loads reviews and passes them to buildEntityGraph", () => {
    const src = read("../components/workspace/GraphTab.tsx");
    expect(src).toContain("useReviewStates(threadId)");
    expect(src).toMatch(/buildEntityGraph\([^)]*reviews\)/);
  });

  it("no production buildIdentityClusters call site omits reviews", () => {
    // The original bug, stated as an invariant. Test files are excluded — they
    // legitimately drive the 2-arg form to isolate clustering from review logic.
    const roots = ["../lib", "../components", "../pages", "../hooks"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/buildIdentityClusters\(([^;]*?)\)/gs)) {
          const args = m[1];
          if (args.includes("export function")) continue;
          const depth = args.split(",").length;
          if (depth < 3) offenders.push(`${path.relative(path.resolve(__dirname, ".."), full)} → buildIdentityClusters(${args.trim().slice(0, 60)})`);
        }
      }
    };
    for (const r of roots) walk(path.resolve(__dirname, r));
    expect(offenders, `these call sites drop the analyst's verdicts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
