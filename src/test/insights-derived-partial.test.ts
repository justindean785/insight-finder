import { describe, it, expect } from "vitest";
import { deriveInsights } from "@/pages/InsightsDerived";

/**
 * `deriveInsights` dereferenced six list fields straight off the RPC payload, so
 * any absent one threw "summary.<field> is not iterable" and blanked the
 * surface. Once Insights became the Overview tab of the merged Intelligence
 * section, that one throw took the whole section down instead of one page.
 * A partial payload must degrade to empty charts.
 */
describe("deriveInsights — partial RPC payloads", () => {
  it("survives a completely empty object", () => {
    const d = deriveInsights({} as never);
    expect(d.byGroup).toEqual([]);
    expect(d.topSources).toEqual([]);
    expect(d.topCases).toEqual([]);
    expect(d.totals.avgConfidence).toBe(0);
  });

  it("survives each list field being absent independently", () => {
    const full = {
      kind_counts: [{ kind: "email", count: 2 }],
      source_counts: [{ source: "hunter", count: 2 }],
      day_counts: [{ day: "2026-08-09", count: 1 }],
      top_cases: [],
      conf_buckets: {},
      avg_confidence: 50,
    } as never;
    for (const key of ["kind_counts", "source_counts", "day_counts", "top_cases"]) {
      const partial = { ...(full as object) } as Record<string, unknown>;
      delete partial[key];
      expect(() => deriveInsights(partial as never)).not.toThrow();
    }
  });

  it("coerces a non-array list to empty rather than throwing", () => {
    expect(() => deriveInsights({ kind_counts: null, source_counts: "nope" } as never)).not.toThrow();
  });

  it("still derives real values from a well-formed payload", () => {
    const d = deriveInsights({
      kind_counts: [{ kind: "email", count: 3 }],
      source_counts: [{ source: "hunter_verify", count: 3 }],
      day_counts: [],
      top_cases: [],
      conf_buckets: {},
      avg_confidence: 62,
    } as never);
    expect(d.totals.avgConfidence).toBe(62);
    expect(d.topSources[0]).toMatchObject({ source: "hunter_verify", count: 3 });
  });
});
