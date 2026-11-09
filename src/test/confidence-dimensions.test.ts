import { describe, it, expect } from "vitest";
import { buildConfidenceProfile, DIMENSION_DEFINITIONS, type ConfidenceProfile } from "@/lib/confidence-dimensions";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const NOW = Date.parse("2026-06-21T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const A = (over: Partial<Artifact> = {}): Artifact => ({
  id: over.id ?? "a",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  confidence: over.confidence ?? 50,
  source: over.source ?? "web_search",
  created_at: over.created_at ?? daysAgo(1),
  metadata: over.metadata ?? null,
});

const dim = (p: ConfidenceProfile, key: string) => p.dimensions.find((d) => d.key === key)!;

describe("DIMENSION_DEFINITIONS — every confidence axis is explained", () => {
  it("has a non-empty definition for every dimension key the profile emits", () => {
    const profile = buildConfidenceProfile({
      artifacts: [A({ id: "1", kind: "email", value: "a@b.com" })],
      seedValue: "a@b.com",
      nowMs: NOW,
    });
    for (const d of profile.dimensions) {
      expect(DIMENSION_DEFINITIONS[d.key], `missing definition for "${d.key}"`).toBeTruthy();
      expect(DIMENSION_DEFINITIONS[d.key].length).toBeGreaterThan(10);
    }
  });
});

describe("buildConfidenceProfile — honest, deterministic confidence axes", () => {
  it("is deterministic for identical input (with a fixed now)", () => {
    const arts = [
      A({ id: "1", kind: "email", value: "a@b.com", source: "breach_check", metadata: { sources: ["breach_check", "github_user"] } }),
      A({ id: "2", kind: "phone", value: "555-1", source: "web_search" }),
      A({ id: "3", kind: "username", value: "bob", source: "username_sweep" }),
    ];
    const a = buildConfidenceProfile({ artifacts: arts, seedValue: "a@b.com", nowMs: NOW });
    const b = buildConfidenceProfile({ artifacts: arts, seedValue: "a@b.com", nowMs: NOW });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("flags a thin case as limited without faking precision", () => {
    const p = buildConfidenceProfile({ artifacts: [A({ id: "1" })], seedValue: "x@y.com", nowMs: NOW });
    expect(p.limited).toBe(true);
    expect(p.artifactCount).toBe(1);
    // every axis exposes a reason
    expect(p.dimensions.every((d) => d.reason.length > 0)).toBe(true);
  });

  it("returns all seven evidence axes, each clamped 0-100 with a reason", () => {
    const p = buildConfidenceProfile({ artifacts: [A({ id: "1" }), A({ id: "2" }), A({ id: "3" })], seedValue: "x@y.com", nowMs: NOW });
    expect(p.dimensions.map((d) => d.key)).toEqual([
      "identity", "selectors", "corroboration", "diversity", "recency", "conflictFree", "readiness",
    ]);
    for (const d of p.dimensions) {
      expect(d.value).toBeGreaterThanOrEqual(0);
      expect(d.value).toBeLessThanOrEqual(100);
      expect(d.reason).toBeTruthy();
    }
  });

  it("marks recency insufficient when there are no timestamps", () => {
    const noTime = [
      { ...A({ id: "1" }), created_at: "" },
      { ...A({ id: "2" }), created_at: "not-a-date" },
      { ...A({ id: "3" }), created_at: "" },
    ] as Artifact[];
    const r = dim(buildConfidenceProfile({ artifacts: noTime, seedValue: null, nowMs: NOW }), "recency");
    expect(r.sufficient).toBe(false);
    expect(r.reason.toLowerCase()).toContain("no timestamps");
  });

  it("recency degrades with age (fresh > stale)", () => {
    const fresh = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", created_at: daysAgo(1) }), A({ id: "2", created_at: daysAgo(1) }), A({ id: "3", created_at: daysAgo(1) })], seedValue: null, nowMs: NOW }), "recency");
    const stale = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", created_at: daysAgo(400) }), A({ id: "2", created_at: daysAgo(400) }), A({ id: "3", created_at: daysAgo(400) })], seedValue: null, nowMs: NOW }), "recency");
    expect(fresh.value).toBeGreaterThan(stale.value);
  });

  it("conflict-free is inverted: more conflicts → lower value, and never reads conflicts as good", () => {
    const clean = buildConfidenceProfile({ artifacts: [A({ id: "1" }), A({ id: "2" }), A({ id: "3" })], seedValue: null, nowMs: NOW });
    const dirty = buildConfidenceProfile({
      artifacts: [A({ id: "1" }), A({ id: "2", metadata: { collision: true } }), A({ id: "3", kind: "name_conflict", value: "X vs Y" })],
      seedValue: null,
      nowMs: NOW,
    });
    expect(dim(clean, "conflictFree").value).toBe(100);
    expect(dim(dirty, "conflictFree").value).toBeLessThan(100);
    expect(dirty.conflictCount).toBe(2);
    expect(dim(dirty, "conflictFree").reason.toLowerCase()).toContain("conflict");
  });

  it("report readiness rises when artifacts are analyst-verified", () => {
    const arts = [A({ id: "1" }), A({ id: "2" }), A({ id: "3" })];
    const base = dim(buildConfidenceProfile({ artifacts: arts, seedValue: null, nowMs: NOW }), "readiness");
    const reviewed = dim(
      buildConfidenceProfile({ artifacts: arts, seedValue: null, reviews: { "1": "confirmed", "2": "key" }, nowMs: NOW }),
      "readiness",
    );
    expect(reviewed.value).toBeGreaterThan(base.value);
  });

  // The defect these pin, in one line: an excluded row can never reach the
  // readiness NUMERATOR, so counting it in the DENOMINATOR made adjudication —
  // the analyst's most valuable act — lower the score. Each case drives
  // buildConfidenceProfile and asserts on the emitted axis, not on the formula.
  it("rejecting a false positive does not LOWER report readiness", () => {
    // Both rows start report-safe, so readiness is 100%. The analyst then finds
    // row 2 is a false positive. Dividing by TOTAL dropped this to 50% — the
    // analyst removed a wrong claim and the case scored HALF as report-ready.
    // Row 1's evidence never changed, so the share of REPORTABLE rows that are
    // report-safe must not move.
    const arts = [
      A({ id: "1", metadata: { reviewed: true } }),
      A({ id: "2", kind: "phone", value: "555-1", metadata: { reviewed: true } }),
    ];
    const before = dim(buildConfidenceProfile({ artifacts: arts, seedValue: null, nowMs: NOW }), "readiness");
    const after = dim(
      buildConfidenceProfile({ artifacts: arts, seedValue: null, reviews: { "2": "wrong" }, nowMs: NOW }),
      "readiness",
    );
    expect(before.value).toBe(100);
    expect(after.value).toBe(100);
  });

  it("a dismissed row leaves the readiness denominator entirely", () => {
    const arts = [
      A({ id: "1", metadata: { reviewed: true } }),
      A({ id: "2", kind: "phone", value: "555-1" }),
      A({ id: "3", kind: "username", value: "bob" }),
    ];
    const profile = buildConfidenceProfile({
      artifacts: arts,
      seedValue: null,
      reviews: { "2": "dismissed", "3": "dismissed" },
      nowMs: NOW,
    });
    const readiness = dim(profile, "readiness");
    // One eligible row, and it is report-safe -> a full share, not 1-of-3.
    expect(readiness.value).toBe(100);
    expect(readiness.reason).toContain("1 of 1");
    expect(readiness.reason).toContain("2 excluded rows not counted");
  });

  it("excluding rows never manufactures readiness from unverified evidence", () => {
    // Every remaining row is an ordinary unverified lead. Shrinking the
    // denominator must not promote them: the numerator is still zero.
    const arts = [
      A({ id: "1" }),
      A({ id: "2", kind: "phone", value: "555-1" }),
      A({ id: "3", kind: "username", value: "bob" }),
    ];
    const readiness = dim(
      buildConfidenceProfile({ artifacts: arts, seedValue: null, reviews: { "3": "wrong" }, nowMs: NOW }),
      "readiness",
    );
    expect(readiness.value).toBe(0);
  });

  it("reports no reportable findings when every row is excluded", () => {
    const arts = [A({ id: "1" }), A({ id: "2", kind: "phone", value: "555-1" })];
    const readiness = dim(
      buildConfidenceProfile({ artifacts: arts, seedValue: null, reviews: { "1": "wrong", "2": "dismissed" }, nowMs: NOW }),
      "readiness",
    );
    expect(readiness.value).toBe(0);
    expect(readiness.sufficient).toBe(false);
    expect(readiness.reason).toBe("No reportable findings yet");
  });

  it("selectors axis grows with distinct selector types present", () => {
    const one = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", kind: "email" }), A({ id: "2", kind: "email", value: "b@c.com" }), A({ id: "3", kind: "email", value: "d@e.com" })], seedValue: null, nowMs: NOW }), "selectors");
    const many = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", kind: "email" }), A({ id: "2", kind: "phone", value: "555" }), A({ id: "3", kind: "username", value: "bob" })], seedValue: null, nowMs: NOW }), "selectors");
    expect(many.value).toBeGreaterThan(one.value);
  });
});

// 2026-11-08, live 70-artifact upload case: 14 analyst-verified rows, but readiness
// read "11 of 29" and Conflict-free "40 conflict / collision / breach indicators
// among 70". The 3 missing verified rows were breach_exposure rows the analyst had
// CONFIRMED: `isConflicted` treated every breach kind as a conflict, regardless of
// review, so the analyst's own verdict could never reach the numerator.
// DIMENSION_DEFINITIONS.conflictFree already says "UNVERIFIED breach indicators".
describe("analyst-confirmed breach rows (DIMENSION_DEFINITIONS: unverified breach indicators)", () => {
  const breach = (id: string, metadata: Record<string, unknown> | null = null) =>
    A({ id, kind: "breach_exposure", value: `breach ${id}@example.com`, source: "breach_check", metadata });
  const base = [
    A({ id: "e1", kind: "email", value: "a@example.com" }),
    A({ id: "e2", kind: "email", value: "b@example.com" }),
  ];

  it("a confirmed or key breach row counts toward readiness and is not a conflict", () => {
    for (const verdict of ["confirmed", "key"] as const) {
      const p = buildConfidenceProfile({ artifacts: [...base, breach("b1")], seedValue: "a@example.com", reviews: { b1: verdict }, nowMs: NOW });
      expect(dim(p, "readiness").reason).toMatch(/^1 of 3 reportable/);
      expect(p.conflictCount).toBe(0);
    }
  });

  it("an unreviewed breach row is unchanged: still a conflict, still outside readiness", () => {
    const p = buildConfidenceProfile({ artifacts: [...base, breach("b1")], seedValue: "a@example.com", nowMs: NOW });
    expect(p.conflictCount).toBe(1);
    expect(dim(p, "readiness").reason).toMatch(/^0 of 2 reportable/);
  });

  it("a confirmed verdict never lifts quarantine on a breach row", () => {
    const p = buildConfidenceProfile({
      artifacts: [...base, breach("b1", { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" })],
      seedValue: "a@example.com",
      reviews: { b1: "confirmed" },
      nowMs: NOW,
    });
    expect(p.conflictCount).toBe(1);
    expect(dim(p, "readiness").reason).toMatch(/^0 of 2 reportable/);
  });
});
