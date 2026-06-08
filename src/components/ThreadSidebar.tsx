import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Plus, LogOut, Trash2, PanelLeftOpen, PanelLeftClose, Search, Brain, CheckCircle2,
  ShieldAlert, Database, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { BrainPanel } from "./BrainPanel";
import { CostMeter } from "@/components/ui/cost-meter";
import { SwarmMark } from "@/components/ui/swarm-mark";
import { timeAgo } from "@/lib/time";

type Thread = {
  id: string;
  title: string;
  updated_at: string;
  credits_used: number;
  cost_micro_usd: number | null;
  status: "active" | "finished" | null;
  seed_type: string | null;
};

type ThreadMetrics = {
  artifacts: number;
  breaches: number;
  lowConf: number;
};

function formatUsd(micro: number | null | undefined): string {
  const m = Number(micro ?? 0);
  const usd = m / 1_000_000;
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function bucketOf(iso: string): "Today" | "This week" | "Older" {
  const d = new Date(iso).getTime();
  const now = Date.now();
  if (now - d < 86400_000) return "Today";
  if (now - d < 7 * 86400_000) return "This week";
  return "Older";
}

export function ThreadSidebar({ collapsed, onToggleCollapse }: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { user } = useAuth();
  const { threadId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const onBrainRoute = location.pathname.startsWith("/brain");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [metrics, setMetrics] = useState<Record<string, ThreadMetrics>>({});
  const [query, setQuery] = useState("");
  const [memCount, setMemCount] = useState<number>(0);
  const [newPatternCount, setNewPatternCount] = useState<number>(0);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [memGrew, setMemGrew] = useState<{ delta: number; key: number } | null>(null);
  const prevMemRef = useRef<number | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const openCaseCount = threads.filter((t) => (t.status ?? "active") !== "finished").length;
  const totalArtifacts = Object.values(metrics).reduce((sum, metric) => sum + (metric?.artifacts ?? 0), 0);
  const breachCaseCount = Object.values(metrics).filter((metric) => (metric?.breaches ?? 0) > 0).length;

  useEffect(() => {
    if (prevMemRef.current !== null && memCount > prevMemRef.current) {
      const delta = memCount - prevMemRef.current;
      setMemGrew({ delta, key: Date.now() });
      const t = setTimeout(() => setMemGrew(null), 2300);
      prevMemRef.current = memCount;
      return () => clearTimeout(t);
    }
    prevMemRef.current = memCount;
  }, [memCount]);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data } = await supabase
        .from("threads")
        .select("id,title,updated_at,credits_used,cost_micro_usd,status,seed_type")
        .order("updated_at", { ascending: false });
      setThreads((data as Thread[] | null) ?? []);
      const { data: arts } = await supabase
        .from("artifacts")
        .select("thread_id,kind,confidence")
        .limit(5000);
      const agg: Record<string, ThreadMetrics> = {};
      for (const a of (arts ?? []) as { thread_id: string; kind: string; confidence: number | null }[]) {
        const m = agg[a.thread_id] ?? { artifacts: 0, breaches: 0, lowConf: 0 };
        m.artifacts++;
        if (a.kind?.toLowerCase() === "breach") m.breaches++;
        if ((a.confidence ?? 0) < 50) m.lowConf++;
        agg[a.thread_id] = m;
      }
      setMetrics(agg);
      const { count } = await supabase
        .from("agent_memory")
        .select("id", { count: "exact", head: true });
      setMemCount(count ?? 0);

      // New patterns since last Global Brain visit (timestamp in localStorage).
      const lastVisited = localStorage.getItem("brain_last_visited");
      if (lastVisited) {
        const { count: newCount } = await supabase
          .from("agent_memory")
          .select("id", { count: "exact", head: true })
          .gt("created_at", lastVisited);
        setNewPatternCount(newCount ?? 0);
      } else {
        // Never visited — surface everything as new so the affordance is obvious.
        setNewPatternCount(count ?? 0);
      }
    };
    load();
    // A single scan emits a burst of artifact INSERTs; firing a full reload on
    // each one thrashes the UI and backend. Coalesce realtime events into one
    // reload per quiet window. (A scoped thread-summary RPC is the longer-term
    // fix — see the scalability roadmap.)
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleLoad = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(load, 400);
    };
    const ch = supabase
      .channel("threads-sidebar")
      .on("postgres_changes", { event: "*", schema: "public", table: "threads" }, scheduleLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_memory" }, scheduleLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "artifacts" }, scheduleLoad)
      .subscribe();
    const onVisit = () => scheduleLoad();
    window.addEventListener("proximity:brain-visited", onVisit);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(ch);
      window.removeEventListener("proximity:brain-visited", onVisit);
    };
  }, [user]);

  const newThread = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("threads")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Failed");
      return;
    }
    navigate(`/chat/${data.id}`);
  };

  const deleteThread = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await supabase.from("threads").delete().eq("id", id);
    if (id === threadId) navigate("/");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  if (collapsed) {
    return (
      <div className="w-14 h-full flex flex-col items-center py-3 gap-3 bg-[radial-gradient(circle_at_top,rgba(72,157,255,0.12),transparent_38%)]">
        <div className="w-10 h-10 rounded-xl border border-primary/20 bg-white/[0.03] grid place-items-center shadow-[0_0_20px_-8px_hsl(var(--primary)/0.55)]">
          <SwarmMark className="w-5 h-5" />
        </div>
        <button
          onClick={onToggleCollapse}
          className="w-9 h-9 rounded-xl border border-border-subtle/80 bg-white/[0.03] grid place-items-center text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-primary/35"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>

        <div className="w-8 h-px bg-border-subtle" />

        <div className="w-10 rounded-xl border border-border-subtle/80 bg-white/[0.03] px-1 py-1.5 text-center">
          <div className="text-[8px] uppercase tracking-[0.18em] text-muted-foreground/70">Open</div>
          <div className="mt-1 font-mono text-[12px] text-foreground">{openCaseCount}</div>
        </div>

        <button
          onClick={newThread}
          className="w-9 h-9 rounded-xl border border-border-subtle/80 bg-white/[0.03] grid place-items-center text-primary transition-colors hover:border-primary/35"
          title="New investigation"
        >
          <Plus className="w-4 h-4" />
        </button>

        <Link
          to="/brain"
          className={cn(
            "relative w-8 h-8 rounded-lg grid place-items-center transition-colors",
            onBrainRoute
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "glass-interactive text-muted-foreground hover:text-primary",
          )}
          title="Global Brain"
          aria-label="Global Brain"
        >
          <Brain className="w-4 h-4" strokeWidth={1.5} />
          {newPatternCount > 0 && !onBrainRoute && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-mono font-bold grid place-items-center shadow-[0_0_10px_hsl(var(--primary)/0.7)]">
              {newPatternCount > 99 ? "99+" : newPatternCount}
            </span>
          )}
        </Link>

        <button
          onClick={() => setBrainOpen(true)}
          className={cn(
            "relative w-9 h-9 rounded-xl grid place-items-center border border-border-subtle/80 bg-white/[0.03] text-accent transition-colors hover:text-primary",
            memGrew && "animate-memory-ring border-primary/60 text-primary"
          )}
          title={`Agent memory: ${memCount} entries — open learning log`}
        >
          <Brain key={memGrew?.key} className={cn("w-4 h-4", memGrew && "animate-brain-grow text-primary")} />
          {memGrew && (
            <span
              key={`f-${memGrew.key}`}
              className="pointer-events-none absolute -top-1 -right-1 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-mono font-bold animate-memory-float shadow-[0_0_10px_hsl(var(--primary)/0.8)]"
            >
              +{memGrew.delta}
            </span>
          )}
        </button>

        <div className="flex-1 overflow-y-auto w-full flex flex-col items-center gap-2 px-1">
          {threads.map((t) => (
            <Link
              key={t.id}
              to={`/chat/${t.id}`}
              className={cn(
                "relative w-9 h-9 rounded-xl border border-transparent flex items-center justify-center text-[10px] font-mono font-bold text-muted-foreground transition-colors hover:border-border-subtle hover:bg-white/[0.03] hover:text-foreground",
                t.id === threadId && "border-primary/30 bg-primary/[0.08] text-foreground shadow-[0_0_18px_-8px_hsl(var(--primary)/0.55)]",
              )}
              title={`${t.title} · ${formatUsd(t.cost_micro_usd)}`}
            >
              {(metrics[t.id]?.breaches ?? 0) > 0 && (
                <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--danger))]" />
              )}
              {t.title.slice(0, 2).toUpperCase()}
            </Link>
          ))}
        </div>

        <div className="w-8 h-px bg-border-subtle" />

        <button
          onClick={signOut}
          className="w-8 h-8 rounded-lg grid place-items-center text-muted-foreground hover:text-foreground glass-interactive transition-colors"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
        <BrainPanel open={brainOpen} onOpenChange={setBrainOpen} />
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const byQuery = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  const filtered = typeFilter === "all"
    ? byQuery
    : byQuery.filter((t) => (t.seed_type ?? "other").toLowerCase() === typeFilter);
  const active = filtered.filter((t) => (t.status ?? "active") !== "finished");
  const finished = filtered.filter((t) => t.status === "finished");
  const activeGroups: Record<string, Thread[]> = { Today: [], "This week": [], Older: [] };
  for (const t of active) activeGroups[bucketOf(t.updated_at)].push(t);
  const totalCost = threads.reduce((s, t) => s + Number(t.cost_micro_usd ?? 0), 0);
  const showingLabel = filtered.length === threads.length ? "all cases" : `${filtered.length} filtered`;

  const TYPES: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "email", label: "Email" },
    { key: "username", label: "User" },
    { key: "phone", label: "Phone" },
    { key: "ip", label: "IP" },
    { key: "domain", label: "Domain" },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-[radial-gradient(circle_at_top,rgba(72,157,255,0.12),transparent_38%)]">
      <div className="border-b border-border-subtle/80 px-4 pt-4 pb-3 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-2xl border border-primary/25 bg-white/[0.04] grid place-items-center shadow-[0_0_24px_-10px_hsl(var(--primary)/0.7)]">
            <SwarmMark className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
              Investigation registry
            </div>
            <div className="font-display font-semibold tracking-tight text-base text-foreground">
              Swarmbot console
            </div>
          </div>
          <button
            onClick={onToggleCollapse}
            className="h-9 w-9 rounded-xl border border-border-subtle/80 bg-white/[0.03] grid place-items-center text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-2xl border border-border-subtle/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">Operations desk</div>
              <div className="mt-1 text-sm font-medium text-foreground/90">Cases, pivots, and analyst memory.</div>
            </div>
            <button
              onClick={() => setBrainOpen(true)}
              className={cn(
                "relative flex h-10 min-w-10 items-center justify-center rounded-xl border border-border-subtle/80 bg-white/[0.03] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary",
                memGrew && "animate-memory-ring border-primary/60 text-primary",
              )}
              title={`${memCount} cross-investigation memories — open learning log`}
            >
              <Brain key={memGrew?.key} className={cn("w-4 h-4", memGrew && "animate-brain-grow")} />
              {memGrew && (
                <span
                  key={`g-${memGrew.key}`}
                  className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold whitespace-nowrap animate-memory-float shadow-[0_0_12px_hsl(var(--primary)/0.8)]"
                >
                  +{memGrew.delta}
                </span>
              )}
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <SidebarMetric label="Open" value={openCaseCount} />
            <SidebarMetric label="Artifacts" value={totalArtifacts} />
            <SidebarMetric label="Breaches" value={breachCaseCount} tone={breachCaseCount > 0 ? "warn" : undefined} />
          </div>

          <div className="mt-3 flex gap-2">
            <Button
              onClick={newThread}
              size="sm"
              className="flex-1 justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-accent text-primary-foreground shadow-[0_6px_24px_-10px_hsl(var(--primary)/0.8)] border-0 hover:opacity-90"
            >
              <Plus className="w-4 h-4" /> New investigation
            </Button>
            <Link
              to="/brain"
              aria-label="Global Brain"
              className={cn(
                "relative flex min-w-[108px] items-center justify-center gap-2 rounded-xl border px-3 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors",
                onBrainRoute
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border-subtle/80 bg-white/[0.02] text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              <Brain className="w-4 h-4" strokeWidth={1.5} />
              <span>Brain</span>
              {newPatternCount > 0 && !onBrainRoute && (
                <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-mono font-bold shadow-[0_0_10px_hsl(var(--primary)/0.65)]">
                  {newPatternCount > 99 ? "99+" : newPatternCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </div>

      <div className="border-b border-border-subtle/70 px-3 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 rounded-xl border border-border-subtle/80 bg-white/[0.03] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search investigations"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="rounded-xl border border-border-subtle/80 bg-white/[0.03] px-2.5 py-2 text-right">
            <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">Memory</div>
            <div className="font-mono text-[12px] text-foreground">{memCount}</div>
          </div>
        </div>

        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
          <span>Registry filters</span>
          <span>{showingLabel}</span>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.16em] transition-colors",
                typeFilter === t.key
                  ? "border-primary/50 bg-primary/15 text-primary"
                  : "border-border-subtle/80 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 pt-3 pb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
        <span>Case queue</span>
        <span>{active.length} live · {finished.length} archived</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {(["Today", "This week", "Older"] as const).map((bucket) =>
          activeGroups[bucket].length === 0 ? null : (
            <div key={bucket} className="mb-3">
              <div className="px-2 py-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/50 shadow-[0_0_10px_hsl(var(--primary)/0.6)]" />
                {bucket}
                <span className="ml-1 font-mono opacity-50">{activeGroups[bucket].length}</span>
              </div>
              {activeGroups[bucket].map((t) => (
                <ThreadRow key={t.id} t={t} active={t.id === threadId} onDelete={deleteThread} m={metrics[t.id]} />
              ))}
            </div>
          )
        )}

        {finished.length > 0 && (
          <div className="mb-2 mt-3">
            <div className="px-2 py-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground flex items-center gap-1.5 border-t border-border-subtle/60 pt-3">
              <CheckCircle2 className="w-3 h-3 text-confidence-glow" />
              Finished
              <span className="ml-1 font-mono opacity-60">{finished.length}</span>
            </div>
            {finished.map((t) => (
              <ThreadRow key={t.id} t={t} active={t.id === threadId} onDelete={deleteThread} dim m={metrics[t.id]} />
            ))}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {q ? "No matches" : "No investigations yet"}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-border-subtle space-y-2">
        <SpendTrend threads={threads} totalCost={totalCost} />
        <CostMeter microUsd={totalCost} threadCount={threads.length} />
        <div className="rounded-2xl border border-border-subtle/80 bg-white/[0.03] px-3 py-2.5 flex items-center justify-between gap-3 text-xs">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">Analyst</div>
            <div className="truncate text-foreground/85">{user?.email}</div>
          </div>
          <button
            onClick={signOut}
            className="h-8 w-8 shrink-0 rounded-lg border border-border-subtle/80 bg-white/[0.03] grid place-items-center text-muted-foreground transition-colors hover:text-foreground hover:border-primary/35"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
      <BrainPanel open={brainOpen} onOpenChange={setBrainOpen} />
    </div>
  );
}

function ThreadRow({
  t, active, onDelete, dim, m,
}: {
  t: Thread;
  active: boolean;
  onDelete: (id: string, e: React.MouseEvent) => void;
  dim?: boolean;
  m?: ThreadMetrics;
}) {
  const sev: "high" | "mid" | "ok" | "low" =
    (m?.breaches ?? 0) > 0 ? "high"
    : (m?.lowConf ?? 0) > 0 ? "mid"
    : (m?.artifacts ?? 0) > 0 ? "ok"
    : "low";
  const stripCls =
    sev === "high" ? "bg-[hsl(var(--danger))] shadow-[0_0_10px_hsl(var(--danger)/0.7)]"
    : sev === "mid" ? "bg-[hsl(var(--confidence-mid))] shadow-[0_0_10px_hsl(var(--confidence-mid)/0.55)]"
    : sev === "ok"  ? "bg-[hsl(var(--confidence-high))] shadow-[0_0_10px_hsl(var(--confidence-high)/0.55)]"
    : "bg-border-strong/70";
  return (
    <Link
      to={`/chat/${t.id}`}
      className={cn(
        "group relative flex items-start justify-between gap-2 rounded-2xl border border-border-subtle/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] pl-4 pr-3 py-3 text-sm transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-primary/20 hover:bg-white/[0.05]",
        active && "border-primary/25 bg-primary/[0.08] text-foreground shadow-[0_0_24px_-12px_hsl(var(--primary)/0.7)]",
        dim && !active && "opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-3 bottom-3 w-0.5 rounded-full",
          active ? "bg-gradient-to-b from-primary to-accent" : stripCls,
          !active && sev === "low" && "opacity-50",
        )}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">
              <span className="font-mono">Case {t.id.slice(0, 4).toUpperCase()}</span>
              <span className="opacity-40">/</span>
              <span>{t.seed_type ?? "general"}</span>
            </div>
            <div className="mt-1 truncate flex items-center gap-1.5">
              {dim && <CheckCircle2 className="w-3 h-3 text-confidence-glow shrink-0" />}
              <span className="truncate font-medium text-foreground/95">{t.title}</span>
            </div>
          </div>
          <span className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.16em]",
            dim
              ? "border-[hsl(var(--confidence-high)/0.35)] bg-[hsl(var(--confidence-high)/0.08)] text-[hsl(var(--confidence-high))]"
              : "border-border-subtle/80 bg-white/[0.03] text-muted-foreground/80",
          )}>
            {dim ? "closed" : "live"}
          </span>
        </div>

        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
          {t.seed_type && (
            <span className="px-1.5 py-0.5 rounded-full border border-border-subtle/80 bg-white/[0.03] font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
              {t.seed_type}
            </span>
          )}
          {(m?.artifacts ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-foreground/80" title="Artifacts">
              <Database className="w-2.5 h-2.5 opacity-70" />{m!.artifacts}
            </span>
          )}
          {(m?.breaches ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-[hsl(var(--danger))]" title="Breaches">
              <ShieldAlert className="w-2.5 h-2.5" />{m!.breaches}
            </span>
          )}
          {(m?.lowConf ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-[hsl(var(--confidence-mid))]" title="Needs verify">
              <Activity className="w-2.5 h-2.5" />{m!.lowConf}
            </span>
          )}
          <span>{timeAgo(t.updated_at)}</span>
          {Number(t.cost_micro_usd ?? 0) > 0 && (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono text-primary/80">{formatUsd(t.cost_micro_usd)}</span>
            </>
          )}
        </div>
      </div>
      <button
        onClick={(e) => onDelete(t.id, e)}
        className="opacity-0 group-hover:opacity-100 h-7 w-7 rounded-lg border border-transparent grid place-items-center text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
        aria-label="Delete"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </Link>
  );
}

function SidebarMetric({ label, value, tone }: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div className="rounded-xl border border-border-subtle/80 bg-black/10 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">{label}</div>
      <div className={cn(
        "mt-1 font-mono text-[15px] leading-none text-foreground",
        tone === "warn" && "text-[hsl(var(--danger))]",
      )}>
        {value}
      </div>
    </div>
  );
}

/** Total-spend KPI — premium, calm, no charts. */
function SpendTrend({ threads, totalCost }: { threads: Thread[]; totalCost: number }) {
  if (threads.length === 0) return null;
  const series = [...threads]
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
    .slice(-14)
    .map((t) => Number(t.cost_micro_usd ?? 0));
  const last = series[series.length - 1] ?? 0;
  const prev = series[series.length - 2] ?? 0;
  const delta = last - prev;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <div className="evidence-tile px-3 py-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="label-eyebrow">Total spend</span>
        <span className="font-mono text-[10px] text-muted-foreground">{threads.length} cases</span>
      </div>
      <div className="font-mono text-xl font-semibold text-foreground tabular-nums leading-none tracking-tight">
        {formatUsd(totalCost)}
      </div>
      {series.length > 1 && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className={cn(
            "inline-flex items-center gap-0.5 text-[10px] font-mono font-medium",
            trend === "up" ? "text-[hsl(var(--confidence-mid))]"
            : trend === "down" ? "text-[hsl(var(--brain-cyan))]"
            : "text-muted-foreground",
          )}>
            <span className="text-xs leading-none">
              {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
            </span>
            {formatUsd(Math.abs(delta))} last run
          </span>
          <span className="text-[10px] text-muted-foreground">
            · across {threads.length} case{threads.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}
