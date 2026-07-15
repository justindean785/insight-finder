import { useEffect, useState } from "react";
import { Link, useNavigate, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import {
  MessageSquare,
  BarChart3,
  Brain,
  Settings as SettingsIcon,
  Plus,
  ArrowRight,
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
          supabase.from("threads").select("id", { count: "exact", head: true }).eq("user_id", user.id),
          supabase.from("artifacts").select("id", { count: "exact", head: true }).eq("user_id", user.id),
          supabase.from("agent_memory").select("id", { count: "exact", head: true }).eq("user_id", user.id),
          supabase
            .from("threads")
            .select("id,title,updated_at")
            .eq("user_id", user.id)
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

  if (authLoading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;

  const lastCaseLabel = relativeTime(counts.lastCaseAt);

  return (
    <div className="relative min-h-screen bg-background text-foreground overflow-hidden">
      {/* Ambient backdrop — intel-blue overhead light + a masked halftone signal
          field, cohesive with the chat hero. Luminance + one accent, no orbs. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 55% at 50% 0%, hsl(var(--intel-blue) / 0.12) 0%, transparent 58%), radial-gradient(60% 50% at 50% 100%, hsl(0 0% 0% / 0.5) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "radial-gradient(circle, hsl(var(--intel-blue) / 0.5) 1px, transparent 1.4px)",
          backgroundSize: "22px 22px",
          maskImage: "radial-gradient(80% 60% at 50% 8%, black 0%, transparent 60%)",
          WebkitMaskImage: "radial-gradient(80% 60% at 50% 8%, black 0%, transparent 60%)",
        }}
      />

      <header className="relative z-10 px-6 sm:px-10 py-5 flex items-center gap-3">
        <Link to="/" aria-label="Home" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl glass-strong border border-white/10 grid place-items-center shadow-cta">
            <SwarmMark className="w-5 h-5" />
          </div>
          <div className="font-display text-base font-semibold tracking-tight">Insight Finder</div>
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
        <section className="pt-6 sm:pt-10 pb-10 rounded-3xl border border-white/[0.07] bg-[linear-gradient(160deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_52%,rgba(255,255,255,0.008))] px-5 sm:px-7 py-7 sm:py-8 shadow-[0_26px_90px_-54px_rgba(0,0,0,0.98)] backdrop-blur-xl">
          <div className="flex items-center gap-2 text-eyebrow font-mono uppercase tracking-[0.26em] text-[hsl(var(--intel-blue))]">
            <span className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--intel-blue))]" />
            Workspace
          </div>
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
              className="h-10 rounded-xl px-4 gap-2 disabled:opacity-60 shadow-[0_14px_34px_-18px_hsl(var(--intel-blue)/0.7)]"
            >
              <Plus className="w-4 h-4" />
              {creating ? "Starting…" : "Start new case"}
            </Button>
            {/* Only offer "Resume" once there's actually a case to resume — with
                zero cases this route just creates a fresh thread, duplicating
                "Start new case" under a misleading label. */}
            {counts.cases > 0 && (
              <Link
                to="/chat"
                className="h-10 rounded-xl px-4 inline-flex items-center gap-2 border border-white/12 bg-[linear-gradient(145deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] hover:bg-[linear-gradient(145deg,rgba(255,255,255,0.12),rgba(255,255,255,0.045))] text-foreground text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <MessageSquare className="w-4 h-4" />
                Resume most recent
              </Link>
            )}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-micro font-mono tracking-normal text-muted-foreground">
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">Cases {counts.cases.toLocaleString()}</span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">Artifacts {counts.artifacts.toLocaleString()}</span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">Memories {counts.memories.toLocaleString()}</span>
            <span className="rounded-full border border-[hsl(var(--intel-blue)/0.35)] bg-[hsl(var(--intel-blue)/0.08)] px-2.5 py-1 text-[hsl(var(--intel-blue))]">Last active {lastCaseLabel}</span>
          </div>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <HubCard
            to="/cases"
            icon={FileSearch}
            title="Cases"
            blurb="Browse every investigation you've run. Open any case to review evidence and reports."
            cta="View all cases"
          />
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

        {/* The three headline counts already live as chips in the hero above;
            a second big-number "hero-metric" tile row repeated the same data.
            Removed to de-duplicate and drop the hero-metric template. */}

        <section className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-semibold tracking-tight">Recent cases</h2>
            <Link
              to="/cases"
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
                  to={`/cases/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground truncate">
                      {c.title?.trim() || "Untitled case"}
                    </div>
                    <div className="text-micro text-muted-foreground font-mono">
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
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(150deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02)_55%,rgba(255,255,255,0.008))] p-5 shadow-[0_20px_70px_-44px_rgba(0,0,0,0.96)] backdrop-blur-xl transition-all duration-300 ease-premium hover:-translate-y-0.5 hover:border-[hsl(var(--intel-blue)/0.4)] hover:shadow-[0_24px_70px_-34px_hsl(var(--intel-blue)/0.62)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--intel-blue)/0.5)]"
    >
      {/* hover sheen — intel-blue wash that fades in on the top edge */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--intel-blue)/0.55)] to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl border border-[hsl(var(--intel-blue)/0.3)] bg-[linear-gradient(180deg,hsl(var(--intel-blue)/0.15),hsl(var(--intel-blue)/0.08))] text-[hsl(var(--intel-blue))] shadow-[0_0_24px_-10px_hsl(var(--intel-blue)/0.7)] transition-transform duration-300 group-hover:scale-105">
        <Icon className="h-5 w-5" strokeWidth={1.6} />
      </div>
      <div className="font-display text-base font-semibold tracking-tight">{title}</div>
      <div className="mt-1.5 flex-1 text-xs leading-relaxed text-muted-foreground">{blurb}</div>
      <div className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--intel-blue))]">
        {cta} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
      </div>
    </Link>
  );
}

