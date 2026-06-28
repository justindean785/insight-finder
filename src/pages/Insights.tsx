import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  MessageSquare,
  Brain,
  Home,
  Activity,
  FileSearch,
  Layers,
  Wifi,
  TrendingUp,
  Clock,
  ArrowRight,
} from "lucide-react";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  groupForKind,
  type Group,
} from "@/lib/intel";
import { addBreadcrumb, captureError } from "@/lib/telemetry";

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

type Stats = {
  threads: ThreadRow[];
  artifacts: ArtifactRow[];
  memoryCount: number;
};

const GROUP_COLOR: Record<Group, string> = {
  identity: "hsl(var(--primary))",
  contact: "hsl(var(--brain-cyan))",
  social: "hsl(var(--accent))",
  infrastructure: "hsl(var(--confidence-mid))",
  breach: "hsl(var(--danger))",
  web: "hsl(var(--confidence-high))",
  crypto: "hsl(var(--warning))",
  other: "hsl(var(--muted-foreground))",
};

const ARTIFACT_CAP = 5000;

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.max(1, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function Insights() {
  const { user, loading: authLoading } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    let alive = true;
    addBreadcrumb("route", "insights load");
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [threadsRes, artifactsRes, memCountRes] = await Promise.all([
          supabase
            .from("threads")
            .select("id,title,updated_at,created_at")
            .order("updated_at", { ascending: false })
            .limit(500),
          supabase
            .from("artifacts")
            .select("id,kind,source,confidence,created_at,thread_id")
            .order("created_at", { ascending: false })
            .limit(ARTIFACT_CAP),
          supabase.from("agent_memory").select("id", { count: "exact", head: true }),
        ]);
        if (!alive) return;
        if (threadsRes.error) throw threadsRes.error;
        if (artifactsRes.error) throw artifactsRes.error;
        setStats({
          threads: (threadsRes.data ?? []) as ThreadRow[],
          artifacts: (artifactsRes.data ?? []) as ArtifactRow[],
          memoryCount: memCountRes.count ?? 0,
        });
      } catch (e) {
        captureError(e, "insights.load");
        if (alive) setError(e instanceof Error ? e.message : "Could not load insights.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, authLoading]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const derived = stats ? deriveInsights(stats) : null;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border-subtle glass-card">
        <div className="mx-auto max-w-6xl px-6 sm:px-10 h-14 flex items-center gap-3">
          <Link to="/" aria-label="Home" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.035] grid place-items-center">
              <SwarmMark className="w-4 h-4" />
            </div>
            <div className="font-display text-sm font-semibold tracking-tight">Insight Finder</div>
          </Link>
          <nav className="ml-6 hidden sm:flex items-center gap-1 text-xs">
            <NavLink to="/" icon={Home} label="Home" />
            <NavLink to="/chat" icon={MessageSquare} label="Chat" />
            <NavLink to="/insights" icon={BarChart3} label="Insights" active />
            <NavLink to="/brain" icon={Brain} label="Brain" />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 sm:px-10 py-8 pb-16">
        <div className="text-eyebrow uppercase tracking-[0.26em] text-primary/80">Insights</div>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
          Global breakdown
        </h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          Aggregate view across every case you've run. Numbers update as the swarm keeps gathering
          evidence. Showing up to the {ARTIFACT_CAP.toLocaleString()} most recent artifacts.
        </p>

        {error && (
          <div className="mt-6 rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            {error}
          </div>
        )}

        <section className="mt-8 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile
            loading={loading}
            icon={FileSearch}
            label="Cases"
            value={derived?.totals.cases ?? 0}
          />
          <StatTile
            loading={loading}
            icon={Activity}
            label="Artifacts"
            value={derived?.totals.artifacts ?? 0}
            sub={
              derived && derived.totals.artifacts >= ARTIFACT_CAP
                ? "showing recent slice"
                : undefined
            }
          />
          <StatTile
            loading={loading}
            icon={Brain}
            label="Memories"
            value={derived?.totals.memories ?? 0}
          />
          <StatTile
            loading={loading}
            icon={TrendingUp}
            label="Avg source confidence"
            value={derived?.totals.avgConfidence ?? 0}
            suffix="%"
            sub="Tool/source score — not analyst review"
          />
        </section>

        <section className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Entities by category" icon={Layers}>
            {loading ? (
              <SkeletonRows rows={5} />
            ) : derived && derived.byGroup.length > 0 ? (
              <BarList
                items={derived.byGroup.map((g) => ({
                  key: g.group,
                  label: GROUP_LABEL[g.group],
                  value: g.count,
                  total: derived.totals.artifacts || 1,
                  color: GROUP_COLOR[g.group],
                }))}
              />
            ) : (
              <EmptyHint>No artifacts collected yet.</EmptyHint>
            )}
          </Card>

          <Card title="Top sources" icon={Wifi}>
            {loading ? (
              <SkeletonRows rows={5} />
            ) : derived && derived.topSources.length > 0 ? (
              <BarList
                items={derived.topSources.map((s) => ({
                  key: s.source,
                  label: s.source,
                  value: s.count,
                  total: derived.topSources[0]?.count || 1,
                  color: "hsl(var(--primary))",
                }))}
              />
            ) : (
              <EmptyHint>Sources will appear once the swarm runs tools.</EmptyHint>
            )}
          </Card>

          <Card title="Confidence distribution" icon={TrendingUp}>
            {loading ? (
              <SkeletonRows rows={4} />
            ) : derived ? (
              <BarList
                items={derived.confidenceBuckets.map((b) => ({
                  key: b.label,
                  label: b.label,
                  value: b.count,
                  total: derived.totals.artifacts || 1,
                  color: b.color,
                }))}
              />
            ) : null}
          </Card>

          <Card title="Activity last 14 days" icon={Clock}>
            {loading ? (
              <SkeletonRows rows={4} />
            ) : derived && derived.activityByDay.length > 0 ? (
              <SparkBars data={derived.activityByDay} />
            ) : (
              <EmptyHint>No recent artifact activity.</EmptyHint>
            )}
          </Card>
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold tracking-tight">Top cases</h2>
            <Link
              to="/chat"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Open chat <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {loading ? (
            <div className="rounded-2xl border border-border-subtle/80 glass-card p-4 space-y-3">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-1/3" />
            </div>
          ) : derived && derived.topCases.length > 0 ? (
            <div className="rounded-2xl border border-border-subtle/80 glass-card divide-y divide-border-subtle/60 overflow-hidden">
              {derived.topCases.map((c) => (
                <Link
                  key={c.id}
                  to={`/chat/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground truncate">
                      {c.title?.trim() || "Untitled case"}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {c.artifactCount} artifacts · last activity {relativeTime(c.lastAt)}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground/60 shrink-0" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-border-subtle/80 glass-card p-6 text-sm text-muted-foreground">
              No cases yet.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// Exported only so the confidence-aggregation logic can be unit-tested; this is
// a pure helper, not a component, so the fast-refresh rule does not apply here.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveInsights(s: Stats) {
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
      // artifacts.confidence is already a 0–100 score (DB CHECK 0–100); it is
      // NOT a 0–1 fraction, so it must not be rescaled. Multiplying by 100 here
      // produced an impossible "4,817%" average and collapsed every artifact
      // into the top (≥80%) distribution bucket.
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

  return { totals, byGroup, topSources, confidenceBuckets, activityByDay, topCases };
}

function NavLink({
  to,
  icon: Icon,
  label,
  active,
}: {
  to: string;
  icon: typeof Home;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      to={to}
      className={
        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
        (active
          ? "bg-white/[0.06] text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]")
      }
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Link>
  );
}

function StatTile({
  loading,
  icon: Icon,
  label,
  value,
  suffix,
  sub,
}: {
  loading: boolean;
  icon: typeof Activity;
  label: string;
  value: number;
  suffix?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-border-subtle/80 glass-card p-5">
      <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-semibold tracking-tight">
        {loading ? (
          <Skeleton className="h-9 w-20" />
        ) : (
          <>
            {value.toLocaleString()}
            {suffix}
          </>
        )}
      </div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Layers;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border-subtle/80 glass-card p-5">
      <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider text-muted-foreground mb-4">
        <Icon className="w-3.5 h-3.5" />
        {title}
      </div>
      {children}
    </div>
  );
}

function BarList({
  items,
}: {
  items: Array<{ key: string; label: string; value: number; total: number; color: string }>;
}) {
  return (
    <ul className="space-y-2">
      {items.map((it) => {
        const pct = it.total > 0 ? Math.max(2, Math.round((it.value / it.total) * 100)) : 0;
        return (
          <li key={it.key}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="truncate max-w-[70%] text-foreground/90">{it.label}</span>
              <span className="font-mono text-muted-foreground">{it.value.toLocaleString()}</span>
            </div>
            <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: it.color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SparkBars({ data }: { data: Array<{ day: string; count: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-1 h-24">
      {data.map((d) => {
        const h = Math.max(2, Math.round((d.count / max) * 100));
        return (
          <div key={d.day} className="flex-1 flex flex-col items-center gap-1" title={`${d.day}: ${d.count}`}>
            <div
              className="w-full rounded-sm"
              style={{
                height: `${h}%`,
                backgroundColor:
                  d.count > 0 ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.2)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground py-4">{children}</div>;
}
