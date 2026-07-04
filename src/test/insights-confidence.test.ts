import { describe, it, expect } from "vitest";
import { deriveInsights } from "@/pages/Insights";

/**
 * Regression guard for the Insights aggregate-confidence scaling bug.
 *
 * `artifacts.confidence` is stored on a 0–100 scale (DB `CHECK (confidence
 * BETWEEN 0 AND 100)`, and src/lib/confidence.ts documents it as 0–100).
 * deriveInsights must treat it as an already-formed percentage. If it
 * multiplies by 100 again, two things break that this test pins down:
 *   1. the "Avg source confidence" headline reads an impossible value
 *      (the field bug rendered "4,817%"), and
 *   2. every scored artifact collapses into the top (≥80%) distribution
 *      bucket, since pct >= 80 always fires first.
 */

type ArtifactLike = {
  id: string;
  kind: string;
  source: string | null;
  confidence: number | null;
  created_at: string;
  thread_id: string;
};

function artifact(confidence: number | null, i = 0): ArtifactLike {
  return {
    id: `a${i}`,
    kind: "email",
    source: "whois",
    confidence,
    created_at: "2026-06-20T12:00:00.000Z",
    thread_id: "t1",
  };
}

function stats(confidences: Array<number | null>) {
  return {
    threads: [
      {
        id: "t1",
        title: "case",
        updated_at: "2026-06-20T12:00:00.000Z",
        created_at: "2026-06-20T12:00:00.000Z",
      },
    ],
    artifacts: confidences.map((c, i) => artifact(c, i)),
    memoryCount: 0,
  };
}

describe("deriveInsights — aggregate confidence scaling", () => {
  it("avgConfidence is the plain 0–100 mean, not double-scaled", () => {
    // Mean of 40/60/80 is 60. The double-scaling bug (× 100) yields 6000.
    const { totals } = deriveInsights(stats([40, 60, 80]));
    expect(totals.avgConfidence).toBe(60);
  });

  it("avgConfidence stays within 0–100 (directly catches the 4,817% bug)", () => {
    const { totals } = deriveInsights(stats([48, 49, 47, 50]));
    expect(totals.avgConfidence).toBeGreaterThanOrEqual(0);
    expect(totals.avgConfidence).toBeLessThanOrEqual(100);
  });

  it("confidence distribution spreads across buckets, not all into ≥80%", () => {
    // One value per scored bucket. The bug pushes all four into ≥80%.
    const { confidenceBuckets } = deriveInsights(stats([10, 30, 60, 90]));
    const byLabel = Object.fromEntries(
      confidenceBuckets.map((b) => [b.label, b.count]),
    );
    expect(byLabel["≥80%"]).toBe(1); // only the 90
    expect(byLabel["50-79%"]).toBe(1); // the 60
    expect(byLabel["20-49%"]).toBe(1); // the 30
    expect(byLabel["<20%"]).toBe(1); // the 10
  });

  it("null confidence is excluded from the mean and counted as Unscored", () => {
    const { totals, confidenceBuckets } = deriveInsights(stats([60, null]));
    expect(totals.avgConfidence).toBe(60); // null excluded, not treated as 0
    const unscored = confidenceBuckets.find((b) => b.label === "Unscored");
    expect(unscored?.count).toBe(1);
  });
});

/**
 * Regression guard for the "Activity last 14 days" empty-state.
 *
 * activityByDay ALWAYS has 14 entries (one per day in the window), so the old
 * render condition `activityByDay.length > 0` was always true — the empty-state
 * hint was unreachable dead code and an idle account rendered 14 near-invisible
 * zero-height bars (a chart that reads as broken). The render now keys off
 * `activityTotal`, which these tests pin. Dates are built relative to now so the
 * in-window / out-of-window split is stable whenever the suite runs.
 */
function artifactOnDate(createdAtIso: string, i = 0): ArtifactLike {
  return { id: `a${i}`, kind: "email", source: "whois", confidence: 50, created_at: createdAtIso, thread_id: "t1" };
}
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function statsWithArtifacts(artifacts: ArtifactLike[]) {
  return { threads: [], artifacts, memoryCount: 0 };
}

describe("deriveInsights — activity empty-state", () => {
  it("activityByDay is always 14 entries, so its length can't gate the empty-state", () => {
    expect(deriveInsights(statsWithArtifacts([])).activityByDay).toHaveLength(14);
  });

  it("activityTotal is 0 when there are no artifacts (empty-state path)", () => {
    expect(deriveInsights(statsWithArtifacts([])).activityTotal).toBe(0);
  });

  it("activityTotal is 0 when all activity is older than the 14-day window", () => {
    const old = [artifactOnDate(daysAgoIso(20), 0), artifactOnDate(daysAgoIso(45), 1)];
    expect(deriveInsights(statsWithArtifacts(old)).activityTotal).toBe(0);
  });

  it("activityTotal counts only artifacts inside the 14-day window (SparkBars path)", () => {
    const mixed = [
      artifactOnDate(daysAgoIso(0), 0), // today — in window
      artifactOnDate(daysAgoIso(5), 1), // in window
      artifactOnDate(daysAgoIso(30), 2), // out of window — excluded
    ];
    expect(deriveInsights(statsWithArtifacts(mixed)).activityTotal).toBe(2);
  });
});
