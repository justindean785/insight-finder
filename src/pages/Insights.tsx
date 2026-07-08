import { Link, Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AppNav } from "@/components/AppNav";
import { useInsightsData } from "@/hooks/useInsightsData";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Brain,
  Activity,
  FileSearch,
  Layers,
  Wifi,
  TrendingUp,
  Clock,
  ArrowRight,
  Wrench,
} from "lucide-react";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  groupForKind,
  type Group,
} from "@/lib/intel";
import { deriveInsights } from "@/pages/InsightsDerived";

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
  const { data, loading, error } = useInsightsData(user?.id, !!user && !authLoading);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const derived = data ? deriveInsights(data.summary) : null;

  const totals = derived
    ? {
        ...derived.totals,
        cases: data!.caseCountExact,
        artifacts: data!.artifactCountExact,
        memories: data!.memoryCount,
      }
    : null;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <AppNav />

      <main className="mx-auto max-w-6xl px-4 sm:px-8 py-8 pb-16">
        <div className="text-eyebrow uppercase tracking-[0.26em] text-primary/80">Insights</div>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
          Your investigation stats
        </h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          Live aggregate view across <strong className="text-foreground/90">your</strong> cases only.
          Updates automatically as scans run and tools return results.
        </p>

        {error && (
          <div className="mt-6 rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            {error}
          </div>
        )}

        <section className="mt-8 grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatTile loading={loading} icon={FileSearch} label="Cases" value={totals?.cases ?? 0} />
          <StatTile loading={loading} icon={Activity} label="Artifacts" value={totals?.artifacts ?? 0} />
          <StatTile loading={loading} icon={Brain} label="Memories" value={totals?.memories ?? 0} />
          <StatTile
            loading={loading}
            icon={Wrench}
            label="Tool calls"
            value={data?.toolCallsTotal ?? 0}
          />
          <StatTile
            loading={loading}
            icon={TrendingUp}
            label="Avg confidence"
            value={totals?.avgConfidence ?? 0}
            suffix="%"
            sub="Source score — not analyst review"
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
                  total: totals?.artifacts || 1,
                  color: GROUP_COLOR[g.group],
                }))}
              />
            ) : (
              <EmptyHint>Run a scan — artifacts will appear here as tools complete.</EmptyHint>
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
              <EmptyHint>Sources appear once breach, WHOIS, DNS, and other tools run.</EmptyHint>
            )}
          </Card>

          <Card title="Tool activity" icon={Wrench}>
            {loading ? (
              <SkeletonRows rows={5} />
            ) : data && data.toolSummaries.length > 0 ? (
              <BarList
                items={data.toolSummaries.slice(0, 8).map((t) => ({
                  key: t.tool_name,
                  label: t.tool_name.replace(/_/g, " "),
                  value: t.count,
                  total: data.toolSummaries[0]?.count || 1,
                  color: "hsl(var(--intel-blue))",
                }))}
              />
            ) : (
              <EmptyHint>No tool calls logged yet for your account.</EmptyHint>
            )}
          </Card>

          <Card title="Activity last 14 days" icon={Clock}>
            {loading ? (
              <SkeletonRows rows={4} />
            ) : derived && derived.activityTotal > 0 ? (
              <SparkBars data={derived.activityByDay} />
            ) : (
              <EmptyHint>No artifact activity in the last 14 days.</EmptyHint>
            )}
          </Card>
        </section>

        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold tracking-tight">Top cases</h2>
            <Link
              to="/cases"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              All cases <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {loading ? (
            <div className="rounded-2xl border border-border-subtle/80 glass-card p-4 space-y-3">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : derived && derived.topCases.length > 0 ? (
            <div className="rounded-2xl border border-border-subtle/80 glass-card divide-y divide-border-subtle/60 overflow-hidden">
              {derived.topCases.map((c) => (
                <Link
                  key={c.id}
                  to={`/cases/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground truncate">
                      {c.title?.trim() || "Untitled case"}
                    </div>
                    <div className="text-micro text-muted-foreground font-mono">
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
      {sub && <div className="mt-1 text-micro text-muted-foreground">{sub}</div>}
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
          // h-full + justify-end give the percentage-height bar a resolved
          // parent height; without it the column collapsed and the bars
          // rendered at 0px (the "empty" activity chart).
          <div
            key={d.day}
            className="flex-1 h-full flex flex-col justify-end"
            title={`${d.day}: ${d.count}`}
          >
            <div
              className="w-full rounded-sm motion-safe:transition-[height] motion-safe:duration-500 motion-safe:ease-out"
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
