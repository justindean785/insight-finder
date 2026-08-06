/**
 * breach-kind-remaining-consumers.test.ts — the last three consumers of the
 * retired bare "breach" literal.
 *
 * #405 replaced kind:"breach" with breach_exposure and shipped isBreachKind so
 * consumers would not silently read zero. It migrated five; #415 caught two
 * more in the page components. These are the final three, and they are the
 * subtle ones, because production still holds BOTH kinds: 774 legacy bare
 * "breach" rows alongside 777 new-kind rows, across 140 of 260 threads.
 *
 * That is what makes the literal a bug rather than a policy: identical
 * evidence was classified differently based only on WHEN it was written. These
 * tests assert the two kinds are treated the same, which is the property the
 * literal violated.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildConfidenceProfile } from "@/lib/confidence-dimensions";
import { buildEntityGraph } from "@/lib/entity-graph";

const art = (over: Partial<Artifact>): Artifact => ({
  id: Math.random().toString(36).slice(2),
  kind: "email",
  value: "subject@example.com",
  confidence: 60,
  source: "breach_check",
  created_at: "2026-08-06T00:00:00Z",
  metadata: null,
  ...over,
});

/** The legacy row and the collapsed row describe the same finding. */
const legacy = () => art({ kind: "breach", value: "Breach exposure: a@b.com" });
const collapsed = () => art({ kind: "breach_exposure", value: "Breach exposure: a@b.com" });

describe("confidence dimensions treat both breach kinds alike", () => {
  it("scores a collapsed breach row the same as the legacy row", () => {
    const withLegacy = buildConfidenceProfile({ artifacts: [legacy()], seedValue: "a@b.com" });
    const withCollapsed = buildConfidenceProfile({ artifacts: [collapsed()], seedValue: "a@b.com" });
    expect(withCollapsed).toEqual(withLegacy);
  });

  it("does not treat an ordinary artifact as conflicted", () => {
    const plain = buildConfidenceProfile({ artifacts: [art({ kind: "email" })], seedValue: "a@b.com" });
    const breach = buildConfidenceProfile({ artifacts: [collapsed()], seedValue: "a@b.com" });
    // If these were equal the predicate would be matching everything, which
    // would make the test above vacuous.
    expect(breach).not.toEqual(plain);
  });
});

describe("the entity graph treats both breach kinds alike", () => {
  it("classifies a collapsed breach row exactly as the legacy row", () => {
    const g1 = buildEntityGraph([legacy()], "a@b.com", "email");
    const g2 = buildEntityGraph([collapsed()], "a@b.com", "email");
    expect(g2.nodes.map((n) => n.conflict)).toEqual(g1.nodes.map((n) => n.conflict));
  });
});
