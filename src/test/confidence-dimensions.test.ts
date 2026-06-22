import { describe, it, expect } from "vitest";
import { buildConfidenceProfile, type ConfidenceProfile } from "@/lib/confidence-dimensions";
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

  it("selectors axis grows with distinct selector types present", () => {
    const one = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", kind: "email" }), A({ id: "2", kind: "email", value: "b@c.com" }), A({ id: "3", kind: "email", value: "d@e.com" })], seedValue: null, nowMs: NOW }), "selectors");
    const many = dim(buildConfidenceProfile({ artifacts: [A({ id: "1", kind: "email" }), A({ id: "2", kind: "phone", value: "555" }), A({ id: "3", kind: "username", value: "bob" })], seedValue: null, nowMs: NOW }), "selectors");
    expect(many.value).toBeGreaterThan(one.value);
  });
});
