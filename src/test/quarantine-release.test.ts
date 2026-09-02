import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isSubjectUnlinked, isQuarantined, quarantineSets, isInert, quarantineReason } from "@/lib/quarantine";
// `quarantineSets` now takes its denial predicate injected. Pass the SHIPPED one so
// these tests exercise the production boundary rather than a stand-in. The rows here
// carry no collision flags, so `isClusterIneligible` reduces to `isQuarantined` for
// them and every assertion below still means exactly what it meant before.
import { isClusterIneligible } from "@/lib/report-hygiene";
import { labelForArtifact, adjustedConfidence, buildReportMarkdown } from "@/lib/intel";
import { evidenceStatus } from "@/lib/evidence-status";
import { buildEntityGraph } from "@/lib/entity-graph";

/**
 * RELEASE — `linkage_confirmed`, across every frontend authority boundary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `subject_unlinked` had grown THREE different meanings in the frontend, and
 * only one of them was the documented one:
 *
 *   label / status / number   subject_unlinked && !linkage_confirmed   (correct)
 *     labelForArtifact, evidenceStatus, adjustedConfidence
 *   pivot authority           subject_unlinked                        (wrong)
 *     quarantineSets -> isInert -> computePivots
 *   cluster authority         subject_unlinked                        (wrong)
 *     isClusterIneligible -> clusters, entity graph, confidence dimensions
 *
 * The signed-off policy is written down in `promote-boundary.test.ts`:
 *
 *   "4. Only an explicit linkage decision restores authority:
 *       `meta.linkage_confirmed === true`."
 *
 * and `adjustedConfidence` documents the reasoning in prose ("`isQuarantined`
 * (not `isSubjectUnlinked`) is deliberate ... preserving #448's explicit escape
 * hatch"). Two consumers simply never implemented it, so an analyst who had
 * actually adjudicated provenance got a row that read CONFIRMED on its label,
 * Verified on its chip and uncapped in its number — and was still refused as a
 * pivot, still barred from every identity cluster, and still dropped from the
 * graph. The release was real everywhere except where the analyst could act on
 * it. These tests pin all five boundaries to ONE definition.
 *
 * THE INVARIANT
 *
 *   ACTIVE QUARANTINE = subject_unlinked === true AND linkage_confirmed !== true
 *
 * and the split that makes it coherent:
 *
 *   isSubjectUnlinked   historical machine provenance — drives DISCLOSURE
 *   isQuarantined       current authority denial      — drives every GATE
 *   linkage_confirmed   explicit human release, WITHOUT rewriting history
 *
 * The last clause is the one most likely to be broken by a well-meaning
 * "simplification": release must not erase the collision disclosure. A released
 * row still arrived on the name-collision axis, and the report still has to say
 * so. `retains its collision disclosure` below is that guard.
 */

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();

const REASON = "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven";

let seq = 0;
function art(over: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: `rel-${seq}`,
    confidence: 88,
    source: "hunter_verify",
    created_at: NOW,
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2 },
    ...over,
  } as Artifact;
}

/** Actively quarantined: flagged, never adjudicated. */
const quarantined = (over: Partial<Artifact> = {}, meta: Record<string, unknown> = {}) =>
  art({
    kind: "email", value: "stranger@example.com",
    metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, subject_unlinked: true, subject_unlinked_reason: REASON, ...meta },
    ...over,
  });

/** Released: flagged, then explicitly adjudicated by an analyst. */
const released = (over: Partial<Artifact> = {}, meta: Record<string, unknown> = {}) =>
  quarantined(over, { linkage_confirmed: true, ...meta });

describe("release — the predicate split", () => {
  it("keeps the historical flag set after release", () => {
    // The two predicates must NOT collapse into each other: one is history, one
    // is authority. If release cleared `isSubjectUnlinked` the disclosure paths
    // would go silent and nobody would notice until a report shipped.
    expect(isSubjectUnlinked(released().metadata)).toBe(true);
    expect(isQuarantined(released().metadata)).toBe(false);
  });

  it("still denies authority while unreleased", () => {
    expect(isSubjectUnlinked(quarantined().metadata)).toBe(true);
    expect(isQuarantined(quarantined().metadata)).toBe(true);
  });

  it("keeps the recorded reason available after release", () => {
    expect(quarantineReason(released().metadata)).toBe(REASON);
  });

  it("is strictly `=== true` — a truthy-ish release does NOT clear quarantine", () => {
    for (const bad of ["true", 1, {}, "yes"]) {
      expect(isQuarantined(quarantined({}, { linkage_confirmed: bad }).metadata)).toBe(true);
    }
  });
});

describe("release — every authority boundary agrees", () => {
  it("label: restores CONFIRMED (already correct — pinned as the reference)", () => {
    expect(labelForArtifact(quarantined(), "confirmed")).not.toBe("CONFIRMED");
    expect(labelForArtifact(released(), "confirmed")).toBe("CONFIRMED");
  });

  it("status: restores verified (already correct — pinned as the reference)", () => {
    expect(evidenceStatus(quarantined(), "confirmed").status).not.toBe("verified");
    expect(evidenceStatus(released(), "confirmed").status).toBe("verified");
  });

  it("confidence: lifts the ceiling (already correct — pinned as the reference)", () => {
    expect(adjustedConfidence(quarantined())).toBeLessThanOrEqual(55);
    expect(adjustedConfidence(released())).toBeGreaterThan(55);
  });

  it("cluster eligibility: a released row becomes eligible", () => {
    expect(isClusterIneligible(quarantined())).toBe(true);
    expect(isClusterIneligible(released())).toBe(false);
  });

  it("cluster eligibility: release does NOT rescue a genuine collision row", () => {
    // `linkage_confirmed` releases the quarantine, not an `excluded_collision`
    // ruling. Over-releasing here would let a ruled-out namesake into the
    // subject's clusters, which is a worse failure than the one being fixed.
    const collided = released({}, { excluded_collision: true });
    expect(isClusterIneligible(collided)).toBe(true);
  });

  it("pivot authority: a released selector is no longer inert", () => {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const toPivot = (k: string) => (k === "email" ? "email" : k === "phone" ? "phone" : null);

    const q = quarantineSets([quarantined()], norm, toPivot, isClusterIneligible);
    expect(isInert("email:stranger example com", q)).toBe(true);

    const r = quarantineSets([released()], norm, toPivot, isClusterIneligible);
    expect(isInert("email:stranger example com", r)).toBe(false);
  });

  it("pivot authority: one released observation restores a value another row still quarantines", () => {
    // Provenance is PER ROW. The same selector can arrive twice — once on the
    // collision axis and once adjudicated — and the surviving authoritative
    // observation is what decides. The key lands in BOTH sets, and `isInert`
    // resolves it to false because `linked` is non-empty for that key.
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const toPivot = (k: string) => (k === "email" ? "email" : null);
    const sets = quarantineSets([quarantined(), released()], norm, toPivot, isClusterIneligible);

    expect(sets.quarantined.has("email:stranger example com")).toBe(true);
    expect(sets.linked.has("email:stranger example com")).toBe(true);
    expect(isInert("email:stranger example com", sets)).toBe(false);
  });

  it("entity graph: a released row loses the inert flag that gates identity edges", () => {
    // NOTE THE MECHANISM — a quarantined row is NOT dropped from the graph.
    // Quarantine is disclosure: `isConflict` (entity-graph.ts) keeps the node and
    // sets `conflict`, which is what renders it visibly inert AND what gates edge
    // construction. So the release assertion is about the FLAG, not about node
    // presence; asserting presence would pass for the wrong reason on both sides.
    const seed = "subject@northgate.example";
    const nodeFor = (a: Artifact) =>
      buildEntityGraph([a], seed, "email").nodes.find((n) => n.art?.id === a.id);

    const q = quarantined({ value: "graphed@example.com" });
    const r = released({ value: "graphed@example.com" });

    // Both are present — quarantine never removes a node.
    expect(nodeFor(q)).toBeDefined();
    expect(nodeFor(r)).toBeDefined();
    // The released row also regains the graph's authority interpretation, so it
    // can take identity edges again (edge construction is gated on this flag).
    expect(nodeFor(q)?.conflict).toBe(true);
    expect(nodeFor(r)?.conflict).toBe(false);
  });
});

describe("release — history is NOT rewritten", () => {
  it("retains its collision disclosure in the report after release", () => {
    // THE GUARD AGAINST OVER-CORRECTING. Every gate above now honours the
    // release; the disclosure path must NOT, because the row genuinely did
    // arrive from a name-only sweep and a reader of the report is entitled to
    // know that. `conflictNoted` in intel.ts keys on the raw `isSubjectUnlinked`
    // flag for exactly this reason — if someone "consistently" migrates that
    // call site to `isQuarantined` too, this test fails and says why.
    const md = buildReportMarkdown({
      artifacts: [released({ value: "disclosed@example.com" })],
      seedValue: "subject@northgate.example",
    } as never);
    expect(md).toContain("disclosed@example.com");
    expect(md).toContain(REASON);
  });
});
