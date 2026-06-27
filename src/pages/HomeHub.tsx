import { useEffect, useState } from "react";
import { Link, useNavigate, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  MessageSquare,
  BarChart3,
  Brain,
  Settings as SettingsIcon,
  Plus,
  ArrowRight,
  Activity,
  FileSearch,
} from "lucide-react";
import { addBreadcrumb, captureError } from "@/lib/telemetry";
import { toast } from "sonner";

type Counts = {
  cases: number;
  artifacts: number;
  memories: number;
  lastCaseAt: string | null;
  recentCases: Array<{ id: string; title: string | null; updated_at: string }>;
};

const EMPTY: Counts = { cases: 0, artifacts: 0, memories: 0, lastCaseAt: null, recentCases: [] };

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

export default function HomeHub() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Counts>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return;
    let alive = true;
    addBreadcrumb("route", "home hub load");
    (async () => {
      setLoading(true);
      try {
        const [threadsRes, artifactsRes, memoriesRes, recentRes] = await Promise.all([
          supabase.from("threads").select("id", { count: "exact", head: true }),
          supabase.from("artifacts").select("id", { count: "exact", head: true }),
          supabase.from("agent_memory").select("id", { count: "exact", head: true }),
          supabase
            .from("threads")
            .select("id,title,updated_at")
            .order("updated_at", { ascending: false })
            .limit(5),
        ]);
        if (!alive) return;
        const recent = (recentRes.data ?? []) as Counts["recentCases"];
        setCounts({
          cases: threadsRes.count ?? 0,
          artifacts: artifactsRes.count ?? 0,
          memories: memoriesRes.count ?? 0,
          lastCaseAt: recent[0]?.updated_at ?? null,
          recentCases: recent,
        });
      } catch (e) {
        captureError(e, "home.counts");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, authLoading]);

  const startCase = async () => {
    if (!user || creating) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("threads")
        .insert({ user_id: user.id })
        .select("id")
        .single();
      if (error) throw error;
      if (data) navigate(`/chat/${data.id}`);
    } catch (e) {
      captureError(e, "home.startCase");
      const msg = e instanceof Error ? e.message : "Could not start a new case.";
      toast.error("Couldn't start a new case", { description: msg });
    } finally {
      setCreating(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  const lastCaseLabel = relativeTime(counts.lastCaseAt);

  return (
    <div className="relative min-h-screen bg-background text-foreground overflow-hidden">
      {/* Ambient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 18%, hsl(var(--primary) / 0.16) 0%, transparent 60%), radial-gradient(50% 50% at 80% 95%, hsl(var(--accent) / 0.10) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />

      <header className="relative z-10 px-6 sm:px-10 py-5 flex items-center gap-3">
        <Link to="/" aria-label="Home" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl glass-strong border border-white/10 grid place-items-center shadow-cta">
            <SwarmMark className="w-5 h-5" />
          </div>
          <div className="font-display text-base font-semibold tracking-tight">Swarmbot</div>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/settings"
            aria-label="Settings"
            className="w-9 h-9 rounded-xl grid place-items-center border border-white/10 bg-white/[0.035] text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <SettingsIcon className="w-4 h-4" />
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6 sm:px-10 pb-16">
        <section className="pt-6 sm:pt-10 pb-10">
          <div className="text-eyebrow uppercase tracking-[0.26em] text-primary/80">Workspace</div>
          <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight">
            Where do you want to go?
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            Start a new investigation, open the chat to resume one in progress, or dig into the
            insights you've already gathered.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              onClick={startCase}
              disabled={creating}
              variant="cta"
              className="h-10 rounded-xl px-4 gap-2 disabled:opacity-60"
            >
              <Plus className="w-4 h-4" />
              {creating ? "Starting…" : "Start new case"}
            </Button>
            <Link
              to="/chat"
              className="h-10 rounded-xl px-4 inline-flex items-center gap-2 border border-white/12 bg-white/[0.035] hover:bg-white/[0.06] text-foreground text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <MessageSquare className="w-4 h-4" />
              Resume most recent
            </Link>
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <HubCard
            to="/chat"
            icon={MessageSquare}
            title="Chat"
            blurb="Run the investigator agent. Seed an identifier and let the swarm work."
            cta="Open chat"
          />
          <HubCard
            to="/insights"
            icon={BarChart3}
            title="Insights"
            blurb="Stats, breakdowns, and the graph view across every case you've run."
            cta="View insights"
          />
          <HubCard
            to="/brain"
            icon={Brain}
            title="Agent brain"
            blurb="Patterns, memories, and source weighting accumulated across investigations."
            cta="Open brain"
          />
        </section>

        <section className="mt-10 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <StatTile loading={loading} icon={FileSearch} label="Cases" value={counts.cases} />
          <StatTile loading={loading} icon={Activity} label="Artifacts" value={counts.artifacts} />
          <StatTile
            loading={loading}
            icon={Brain}
            label="Memories"
            value={counts.memories}
            sub={`Last activity ${lastCaseLabel}`}
          />
        </section>

        <section className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold tracking-tight">Recent cases</h2>
            <Link
              to="/chat"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              All cases <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="rounded-2xl border border-border-subtle/80 glass-card divide-y divide-border-subtle/60 overflow-hidden">
            {loading ? (
              <div className="p-4 space-y-3">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-5 w-1/3" />
              </div>
            ) : counts.recentCases.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                No cases yet — start a new one to seed your first investigation.
              </div>
            ) : (
              counts.recentCases.map((c) => (
                <Link
                  key={c.id}
                  to={`/chat/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground truncate">
                      {c.title?.trim() || "Untitled case"}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      {relativeTime(c.updated_at)}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground/60 shrink-0" />
                </Link>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function HubCard({
  to,
  icon: Icon,
  title,
  blurb,
  cta,
}: {
  to: string;
  icon: typeof MessageSquare;
  title: string;
  blurb: string;
  cta: string;
}) {
  return (
    <Link
      to={to}
      className="group relative rounded-2xl border border-border-subtle/80 glass-card p-5 hover:border-white/20 transition-colors flex flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="w-10 h-10 rounded-xl border border-white/10 bg-white/[0.035] grid place-items-center mb-4">
        <Icon className="w-5 h-5 text-primary" strokeWidth={1.5} />
      </div>
      <div className="font-display text-base font-semibold tracking-tight">{title}</div>
      <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed flex-1">{blurb}</div>
      <div className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-foreground/90 group-hover:text-foreground">
        {cta} <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function StatTile({
  loading,
  icon: Icon,
  label,
  value,
  sub,
}: {
  loading: boolean;
  icon: typeof Activity;
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-border-subtle/80 glass-card p-5">
      <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-semibold tracking-tight">
        {loading ? <Skeleton className="h-9 w-20" /> : value.toLocaleString()}
      </div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
