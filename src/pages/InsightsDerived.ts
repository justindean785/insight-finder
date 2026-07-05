import {
  GROUP_ORDER,
  GROUP_LABEL,
  groupForKind,
  type Group,
} from "@/lib/intel";

type ArtifactRow = {
  id: string;
  kind: string;
  source: string | null;
  confidence: number | null;
  created_at: string;
  thread_id: string;
};

type ThreadRow = {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
};

export type InsightsStatsInput = {
  threads: ThreadRow[];
  artifacts: ArtifactRow[];
  memoryCount: number;
};

/** Pure aggregation for Insights — unit-tested in insights-confidence.test.ts */
export function deriveInsights(s: InsightsStatsInput) {
  const byGroupMap = new Map<Group, number>();
  const sourceMap = new Map<string, number>();
  const confidenceBuckets = [
    { label: "≥80%", min: 80, count: 0, color: "hsl(var(--confidence-high))" },
    { label: "50-79%", min: 50, count: 0, color: "hsl(var(--confidence-mid))" },
    { label: "20-49%", min: 20, count: 0, color: "hsl(var(--warning))" },
    { label: "<20%", min: 0, count: 0, color: "hsl(var(--danger))" },
    { label: "Unscored", min: -1, count: 0, color: "hsl(var(--muted-foreground))" },
  ];
  const dayMap = new Map<string, number>();
  const caseArtifacts = new Map<string, { count: number; lastAt: string }>();

  let confSum = 0;
  let confN = 0;

  for (const a of s.artifacts) {
    const grp = groupForKind(a.kind);
    byGroupMap.set(grp, (byGroupMap.get(grp) ?? 0) + 1);

    if (a.source) {
      sourceMap.set(a.source, (sourceMap.get(a.source) ?? 0) + 1);
    }

    if (a.confidence == null) {
      confidenceBuckets[confidenceBuckets.length - 1].count++;
    } else {
      const pct = a.confidence;
      confSum += pct;
      confN++;
      for (const b of confidenceBuckets) {
        if (b.min >= 0 && pct >= b.min) {
          b.count++;
          break;
        }
      }
    }

    const day = a.created_at.slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);

    const prev = caseArtifacts.get(a.thread_id);
    if (!prev) caseArtifacts.set(a.thread_id, { count: 1, lastAt: a.created_at });
    else {
      prev.count++;
      if (a.created_at > prev.lastAt) prev.lastAt = a.created_at;
    }
  }

  const byGroup = GROUP_ORDER.map((g) => ({ group: g, count: byGroupMap.get(g) ?? 0 })).filter(
    (g) => g.count > 0,
  );

  const topSources = [...sourceMap.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const today = new Date();
  const activityByDay: Array<{ day: string; count: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    activityByDay.push({ day: key, count: dayMap.get(key) ?? 0 });
  }
  const activityTotal = activityByDay.reduce((n, d) => n + d.count, 0);

  const threadTitle = new Map(s.threads.map((t) => [t.id, t.title]));
  const topCases = [...caseArtifacts.entries()]
    .map(([id, v]) => ({
      id,
      title: threadTitle.get(id) ?? null,
      artifactCount: v.count,
      lastAt: v.lastAt,
    }))
    .sort((a, b) => b.artifactCount - a.artifactCount)
    .slice(0, 6);

  const totals = {
    cases: s.threads.length,
    artifacts: s.artifacts.length,
    memories: s.memoryCount,
    avgConfidence: confN ? Math.round(confSum / confN) : 0,
  };

  return { totals, byGroup, topSources, confidenceBuckets, activityByDay, activityTotal, topCases };
}

export { GROUP_LABEL, GROUP_ORDER, groupForKind };
