import {
  GROUP_ORDER,
  GROUP_LABEL,
  groupForKind,
  type Group,
} from "@/lib/intel";

/**
 * Insights aggregation. The COUNTING now happens server-side in the
 * `get_insights_summary` Postgres RPC (so it reflects ALL rows, not the
 * PostgREST-capped first 1,000 that the old client-side row fetch saw). This
 * module only SHAPES that pre-aggregated summary for the view: maps raw kinds
 * to display groups via groupForKind, builds the fixed 14-day window, and keeps
 * the bucket order. Unit-tested in insights-confidence.test.ts.
 */

export type InsightsSummary = {
  kind_counts: Array<{ kind: string; count: number }>;
  source_counts: Array<{ source: string; count: number }>;
  day_counts: Array<{ day: string; count: number }>;
  top_cases: Array<{
    thread_id: string;
    title: string | null;
    artifact_count: number;
    last_at: string;
  }>;
  conf_buckets: { ge80: number; b50: number; b20: number; lt20: number; unscored: number };
  avg_confidence: number;
  tool_counts: Array<{ tool_name: string; count: number; ok_count: number }>;
  tool_calls_total: number;
};

export function deriveInsights(summary: InsightsSummary) {
  // Raw artifact kinds → display groups (Identity, Contact, …). The mapping
  // stays in JS so `groupForKind` is the single source of truth, not duplicated
  // in SQL.
  const byGroupMap = new Map<Group, number>();
  for (const { kind, count } of summary.kind_counts) {
    const g = groupForKind(kind);
    byGroupMap.set(g, (byGroupMap.get(g) ?? 0) + count);
  }
  const byGroup = GROUP_ORDER.map((g) => ({ group: g, count: byGroupMap.get(g) ?? 0 })).filter(
    (g) => g.count > 0,
  );

  const topSources = summary.source_counts.slice(0, 8).map(({ source, count }) => ({ source, count }));

  const cb = summary.conf_buckets;
  const confidenceBuckets = [
    { label: "≥80%", count: cb.ge80, color: "hsl(var(--confidence-high))" },
    { label: "50-79%", count: cb.b50, color: "hsl(var(--confidence-mid))" },
    { label: "20-49%", count: cb.b20, color: "hsl(var(--warning))" },
    { label: "<20%", count: cb.lt20, color: "hsl(var(--danger))" },
    { label: "Unscored", count: cb.unscored, color: "hsl(var(--muted-foreground))" },
  ];

  // Fixed 14-day window: one entry per day (0 where the RPC returned no bucket),
  // so the sparkline always has 14 bars and its length never gates the render.
  const dayMap = new Map(summary.day_counts.map((d) => [d.day, d.count]));
  const today = new Date();
  const activityByDay: Array<{ day: string; count: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    activityByDay.push({ day: key, count: dayMap.get(key) ?? 0 });
  }
  const activityTotal = activityByDay.reduce((n, d) => n + d.count, 0);

  const topCases = summary.top_cases.map((c) => ({
    id: c.thread_id,
    title: c.title,
    artifactCount: c.artifact_count,
    lastAt: c.last_at,
  }));

  const totals = { avgConfidence: summary.avg_confidence };

  return { totals, byGroup, topSources, confidenceBuckets, activityByDay, activityTotal, topCases };
}

export { GROUP_LABEL, GROUP_ORDER, groupForKind };
