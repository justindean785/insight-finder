/**
 * analyst-decisions.test.ts — the pure decision helpers every frontend consumer
 * shares, and the MANUAL dispatch guard the pivot bus applies.
 */
import { describe, expect, it } from "vitest";
import {
  buildDecisionSets,
  isManualDispatchRefused,
  isRejectedArtifact,
  isRejectedReview,
  isNonNewReview,
  recheckPrompt,
} from "@/lib/analyst-decisions";
import { normalizeTarget } from "@/lib/next-step-cards";
import { KIND_TO_PIVOT } from "@/lib/intel";

const toPivot = (kind: string) => KIND_TO_PIVOT[kind.toLowerCase()] ?? null;

const ARTS = [
  { id: "e1", kind: "email", value: "Wrong@Example.com", metadata: {} },
  { id: "u1", kind: "username", value: "jordan.vale", metadata: {} },
  { id: "n1", kind: "name", value: "Jordan Vale", metadata: {} },
  { id: "k1", kind: "phone", value: "+1 555 000 1111", metadata: {} },
  { id: "r1", kind: "domain", value: "example.org", metadata: {} },
  { id: "c1", kind: "email", value: "ok@example.com", metadata: {} },
  { id: "f1", kind: "email", value: "legacy@example.com", metadata: { false_positive: true } },
  { id: "x1", kind: "breach_exposure", value: "not pivotable", metadata: {} },
];

describe("predicates", () => {
  it("isRejectedReview / isNonNewReview", () => {
    expect(isRejectedReview("dismissed")).toBe(true);
    expect(isRejectedReview("wrong")).toBe(true);
    expect(isRejectedReview("confirmed")).toBe(false);
    expect(isRejectedReview(null)).toBe(false);
    expect(isNonNewReview("new")).toBe(false);
    expect(isNonNewReview("key")).toBe(true);
  });

  it("isRejectedArtifact unifies the verdict with the legacy metadata flag", () => {
    expect(isRejectedArtifact({ id: "a", metadata: {} }, "dismissed")).toBe(true);
    expect(isRejectedArtifact({ id: "a", metadata: { false_positive: true } }, undefined)).toBe(true);
    expect(isRejectedArtifact({ id: "a", metadata: { false_positive: "true" } }, undefined)).toBe(false);
    expect(isRejectedArtifact({ id: "a", metadata: null }, "confirmed")).toBe(false);
  });

  it("recheckPrompt scopes to the exact value and kind", () => {
    expect(recheckPrompt("x@y.z", "email")).toContain('"x@y.z" (email)');
  });
});

describe("buildDecisionSets", () => {
  const sets = buildDecisionSets(ARTS, { e1: "dismissed", u1: "wrong", k1: "key", r1: "recheck", c1: "confirmed" }, normalizeTarget, toPivot);

  it("keys rejection by id AND by type:normalizedValue", () => {
    expect(sets.rejectedIds.has("e1")).toBe(true);
    expect(sets.rejectedKeys.has("email:wrong example com")).toBe(true);
    expect(sets.rejectedKeys.has("username:jordan vale")).toBe(true);
    // Legacy flag, no verdict at all.
    expect(sets.rejectedIds.has("f1")).toBe(true);
    expect(sets.rejectedKeys.has("email:legacy example com")).toBe(true);
  });

  it("does NOT let a rejected username reject a same-text name", () => {
    expect(sets.rejectedKeys.has("name:jordan vale")).toBe(false);
  });

  it("separates key / recheck / confirmed identities", () => {
    expect(sets.keyKeys.has("phone:1 555 000 1111")).toBe(true);
    expect(sets.recheckKeys.has("domain:example org")).toBe(true);
    expect(sets.confirmedKeys.has("email:ok example com")).toBe(true);
    expect(sets.stateById.get("k1")).toBe("key");
  });

  it("ignores non-pivotable kinds for identity keys but still records the id", () => {
    const s = buildDecisionSets(ARTS, { x1: "dismissed" }, normalizeTarget, toPivot);
    expect(s.rejectedIds.has("x1")).toBe(true);
    expect([...s.rejectedKeys].some((k) => k.includes("not pivotable"))).toBe(false);
  });

  it("a rejection on one row of a selector outranks a Key on another row of it", () => {
    const dup = [
      { id: "a", kind: "email", value: "dup@example.com", metadata: {} },
      { id: "b", kind: "email", value: "dup@example.com", metadata: {} },
    ];
    const s = buildDecisionSets(dup, { a: "dismissed", b: "key" }, normalizeTarget, toPivot);
    expect(s.rejectedKeys.has("email:dup example com")).toBe(true);
    expect(s.keyKeys.has("email:dup example com")).toBe(false);
  });
});

describe("isManualDispatchRefused — the pivot-bus guard", () => {
  const sets = buildDecisionSets(ARTS, { e1: "dismissed", u1: "wrong" }, normalizeTarget, toPivot);

  it("⛔ refuses a rejected selector by pivot type", () => {
    expect(isManualDispatchRefused(sets, "email", "wrong@example.com", normalizeTarget, toPivot)).toBe(true);
    expect(isManualDispatchRefused(sets, "email", "WRONG@example.COM", normalizeTarget, toPivot)).toBe(true);
  });

  it("accepts an artifact KIND on the bus (a Recheck launch passes the kind, not the pivot type)", () => {
    expect(isManualDispatchRefused(sets, "handle", "jordan.vale", normalizeTarget, toPivot)).toBe(true);
    expect(isManualDispatchRefused(sets, "username", "@jordan.vale", normalizeTarget, toPivot)).toBe(true);
  });

  it("lets a clean selector through, and a same-text NAME through", () => {
    expect(isManualDispatchRefused(sets, "email", "ok@example.com", normalizeTarget, toPivot)).toBe(false);
    expect(isManualDispatchRefused(sets, "name", "Jordan Vale", normalizeTarget, toPivot)).toBe(false);
  });

  it("fails open on a missing type or value — those were never reviewed as this identity", () => {
    expect(isManualDispatchRefused(sets, undefined, "wrong@example.com", normalizeTarget, toPivot)).toBe(false);
    expect(isManualDispatchRefused(sets, "email", "", normalizeTarget, toPivot)).toBe(false);
  });
});
