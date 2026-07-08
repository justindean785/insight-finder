import { describe, it, expect } from "vitest";
import { deriveInsights, type InsightsSummary } from "@/pages/InsightsDerived";

/**
 * Insights aggregation now happens server-side (get_insights_summary RPC), so
 * these guard the SHAPING that remains in deriveInsights:
 *   1. avg_confidence is passed through untouched — deriveInsights must NOT
 *      re-scale it (the old client-side ×100 bug rendered "4,817%").
 *   2. conf_buckets map to labelled, correctly-ordered display buckets.
 *   3. the "Activity last 14 days" window is always 14 entries and activityTotal
 *      counts only days inside the window (the empty-state / invisible-bars guard).
 */

const EMPTY_SUMMARY: InsightsSummary = {
  kind_counts: [],
  source_counts: [],
  day_counts: [],
  top_cases: [],
  conf_buckets: { ge80: 0, b50: 0, b20: 0, lt20: 0, unscored: 0 },
  avg_confidence: 0,
  tool_counts: [],
  tool_calls_total: 0,
};

function summary(partial: Partial<InsightsSummary>): InsightsSummary {
  return { ...EMPTY_SUMMARY, ...partial };
}

describe("deriveInsights — confidence shaping", () => {
  it("passes avg_confidence through unchanged (no client-side re-scaling)", () => {
    expect(deriveInsights(summary({ avg_confidence: 60 })).totals.avgConfidence).toBe(60);
    expect(deriveInsights(summary({ avg_confidence: 49 })).totals.avgConfidence).toBe(49);
  });

  it("maps conf_buckets to labelled buckets in order, spread across bands", () => {
    const { confidenceBuckets } = deriveInsights(
      summary({ conf_buckets: { ge80: 1, b50: 1, b20: 1, lt20: 1, unscored: 2 } }),
    );
    const byLabel = Object.fromEntries(confidenceBuckets.map((b) => [b.label, b.count]));
    expect(byLabel["≥80%"]).toBe(1);
    expect(byLabel["50-79%"]).toBe(1);
    expect(byLabel["20-49%"]).toBe(1);
    expect(byLabel["<20%"]).toBe(1);
    expect(byLabel["Unscored"]).toBe(2);
    expect(confidenceBuckets.map((b) => b.label)).toEqual([
      "≥80%", "50-79%", "20-49%", "<20%", "Unscored",
    ]);
  });
});

function dayKey(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

describe("deriveInsights — activity 14-day window", () => {
  it("activityByDay is always 14 entries, so its length can't gate the empty-state", () => {
    expect(deriveInsights(EMPTY_SUMMARY).activityByDay).toHaveLength(14);
  });

  it("activityTotal is 0 when there is no day activity (empty-state path)", () => {
    expect(deriveInsights(EMPTY_SUMMARY).activityTotal).toBe(0);
  });

  it("activityTotal counts only days inside the 14-day window", () => {
    const s = summary({
      day_counts: [
        { day: dayKey(0), count: 3 }, // today — in window
        { day: dayKey(5), count: 2 }, // in window
        { day: dayKey(30), count: 9 }, // out of window — excluded
      ],
    });
    expect(deriveInsights(s).activityTotal).toBe(5);
  });
});
