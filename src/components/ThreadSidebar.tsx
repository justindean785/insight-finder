import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Plus, LogOut, Trash2, PanelLeftOpen, PanelLeftClose, Search, Brain, CheckCircle2,
  ShieldAlert, Database, Activity, BarChart3, Wallet, FolderOpen,
  Mail, Phone, Globe, Network, User, Hash, FileSearch, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { detectSeed } from "@/lib/seed";
import { isActiveThreadStatus } from "@/lib/thread-status";
import { SUPPORT_MAILTO } from "@/lib/contact";
import type { Database as SupabaseDatabase } from "@/integrations/supabase/types";

// Icon per seed type for the collapsed rail — far cleaner than showing the
// first two characters of each title (which rendered as a stack of "+1", "8.",
// "SE", "NI"… fragments that looked like noise). Falls back to detecting the
// kind from the title for older threads whose seed_type was never persisted.
const SEED_ICON: Record<string, LucideIcon> = {
  email: Mail, phone: Phone, domain: Globe, url: Globe, ip: Network,
  username: User, person: User, name: User, organization: User, crypto: Hash,
};
function seedIcon(seedType: string | null, title: string): LucideIcon {
  const kind = (seedType ?? detectSeed(title)?.kind ?? "other").toLowerCase();
  return SEED_ICON[kind] ?? FileSearch;
}
import { toast } from "sonner";
import { SwarmMark } from "@/components/ui/swarm-mark";

/** Upper bound on the global artifact rows pulled to compute per-thread
 *  sidebar badges. When this is hit the badges become a *sample*, not totals,
 *  so the UI surfaces a "metrics sampled" pill — never silently truncate. */
const SIDEBAR_METRICS_SAMPLE_LIMIT = 5000;

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

type Thread = {
  id: string;
  title: string;
  updated_at: string;
  credits_used: number;
  cost_micro_usd: number | null;
  // Open string, not a closed enum: the backend can write statuses the UI
  // doesn't enumerate (e.g. "failed_context_limit") and they must still render.
  status: string | null;
  seed_type: string | null;
};

type ThreadMetrics = {
  artifacts: number;
  breaches: number;
  lowConf: number;
};

type UserCredits = Pick<
  SupabaseDatabase["public"]["Tables"]["user_credits"]["Row"],
  "balance_micro_usd" | "spent_micro_usd" | "unlimited" | "blocked"
>;

/** Remaining-beta-credits chip for the sidebar footer. Renders nothing until a
 *  row is loaded; "Unlimited" for exempt accounts; amber when low, red when
 *  depleted or blocked. */
function CreditChip({ credits }: { credits: UserCredits | null }) {
  if (!credits) return null;
  if (credits.unlimited) {
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title="Your account has unlimited credits"
      >
        <Wallet className="w-3.5 h-3.5" strokeWidth={1.5} />
        <span>Credits</span>
        <span className="ml-auto font-mono tabular-nums text-foreground/80">Unlimited</span>
      </div>
    );
  }
  const remaining = Number(credits.balance_micro_usd ?? 0);
  const depleted = credits.blocked || remaining <= 0;
  const low = !depleted && remaining <= 50_000; // under ~$0.05 left
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        depleted ? "text-destructive" : low ? "text-amber-400" : "text-muted-foreground",
      )}
      title={depleted ? "Out of beta credits" : "Remaining beta credits"}
    >
      <Wallet className="w-3.5 h-3.5" strokeWidth={1.5} />
      <span>Beta credits</span>
      <span className="ml-auto font-mono tabular-nums">{formatUsd(remaining)}</span>
    </div>
  );
}

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
  const onInsightsRoute = location.pathname.startsWith("/insights");
  const onCasesRoute = location.pathname.startsWith("/cases");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [metrics, setMetrics] = useState<Record<string, ThreadMetrics>>({});
  const [metricsSampled, setMetricsSampled] = useState(false);
  const [query, setQuery] = useState("");
  const [newPatternCount, setNewPatternCount] = useState<number>(0);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [credits, setCredits] = useState<UserCredits | null>(null);

  useEffect(() => {
    if (!user) return;

    // Cheap: the thread list + Global-Brain "new patterns" badge. Safe to run
    // often (it's a small, indexed query set).
    const loadThreadsAndBrain = async () => {
      const { data } = await supabase
        .from("threads")
        .select("id,title,updated_at,credits_used,cost_micro_usd,status,seed_type")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });
      setThreads((data as Thread[] | null) ?? []);

      // Beta credit balance (own row only via RLS).
      const { data: creditRow } = await supabase
        .from("user_credits")
        .select("balance_micro_usd,spent_micro_usd,unlimited,blocked")
        .eq("user_id", user.id)
        .maybeSingle();
      setCredits(creditRow ?? null);

      const { count } = await supabase
        .from("agent_memory")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      const lastVisited = localStorage.getItem("brain_last_visited");
      if (lastVisited) {
        const { count: newCount } = await supabase
          .from("agent_memory")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gt("created_at", lastVisited);
        setNewPatternCount(newCount ?? 0);
      } else {
        // Never visited — surface everything as new so the affordance is obvious.
        setNewPatternCount(count ?? 0);
      }
    };

    // Expensive: pulls up to SIDEBAR_METRICS_SAMPLE_LIMIT artifact rows across
    // ALL threads to aggregate the per-thread sidebar badges. During a live
    // run the agent writes artifacts in rapid bursts, so this MUST NOT re-run
    // on every insert — it is driven by its own long-debounced scheduler
    // below. When the limit is hit the badges are a sample, not a total, and
    // the UI surfaces a "sampled" pill so counts aren't read as authoritative.
    const loadMetrics = async () => {
      const { data: arts } = await supabase
        .from("artifacts")
        .select("thread_id,kind,confidence")
        .eq("user_id", user.id)
        .limit(SIDEBAR_METRICS_SAMPLE_LIMIT);
      const rows = (arts ?? []) as { thread_id: string; kind: string; confidence: number | null }[];
      const agg: Record<string, ThreadMetrics> = {};
      for (const a of rows) {
        const m = agg[a.thread_id] ?? { artifacts: 0, breaches: 0, lowConf: 0 };
        m.artifacts++;
        if (a.kind?.toLowerCase() === "breach") m.breaches++;
        if ((a.confidence ?? 0) < 50) m.lowConf++;
        agg[a.thread_id] = m;
      }
      setMetrics(agg);
      setMetricsSampled(rows.length >= SIDEBAR_METRICS_SAMPLE_LIMIT);
    };

    void loadThreadsAndBrain();
    void loadMetrics();

    let fullTimer: ReturnType<typeof setTimeout> | undefined;
    let metricsTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFull = () => {
      if (fullTimer) clearTimeout(fullTimer);
      fullTimer = setTimeout(() => void loadThreadsAndBrain(), 400);
    };
    // Collapse a burst of artifact writes into one heavy aggregation refresh.
    const scheduleMetrics = () => {
      if (metricsTimer) clearTimeout(metricsTimer);
      metricsTimer = setTimeout(() => void loadMetrics(), 3000);
    };
    const ch = supabase
      .channel("threads-sidebar")
      .on("postgres_changes", { event: "*", schema: "public", table: "threads" }, scheduleFull)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_memory" }, scheduleFull)
      .on("postgres_changes", { event: "*", schema: "public", table: "artifacts" }, scheduleMetrics)
      .subscribe();
    const onVisit = () => scheduleFull();
    window.addEventListener("proximity:brain-visited", onVisit);
    return () => {
      if (fullTimer) clearTimeout(fullTimer);
      if (metricsTimer) clearTimeout(metricsTimer);
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
    // Deleting a case is irreversible (cascades to its artifacts/evidence), so
    // confirm before destroying it and surface any failure instead of silently
    // navigating away as if it worked.
    if (typeof window !== "undefined" && !window.confirm("Delete this investigation and all of its evidence? This cannot be undone.")) {
      return;
    }
    const { error } = await supabase.from("threads").delete().eq("id", id);
    if (error) {
      toast.error(error.message || "Could not delete the case");
      return;
    }
    setThreads((prev) => prev.filter((t) => t.id !== id));
    toast.success("Case deleted");
    if (id === threadId) navigate("/");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  if (collapsed) {
    return (
      <div className="w-14 h-full flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggleCollapse}
          className="w-8 h-8 rounded-lg glass-interactive grid place-items-center"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen className="w-4 h-4 text-primary" />
        </button>

        <div className="w-8 h-px bg-border-subtle" />

        <button
          onClick={newThread}
          className="w-8 h-8 rounded-lg glass-interactive grid place-items-center text-primary"
          title="New investigation"
          aria-label="New investigation"
        >
          <Plus className="w-4 h-4" />
        </button>

        <Link
          to="/cases"
          className={cn(
            "relative w-8 h-8 rounded-lg grid place-items-center transition-colors",
            onCasesRoute
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "glass-interactive text-muted-foreground hover:text-primary",
          )}
          title="All cases"
          aria-label="All cases"
        >
          <FolderOpen className="w-4 h-4" strokeWidth={1.5} />
        </Link>

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
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-micro font-mono font-bold grid place-items-center shadow-[0_0_10px_hsl(var(--primary)/0.7)]">
              {newPatternCount > 99 ? "99+" : newPatternCount}
            </span>
          )}
        </Link>

        <Link
          to="/insights"
          className={cn(
            "relative w-8 h-8 rounded-lg grid place-items-center transition-colors",
            onInsightsRoute
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "glass-interactive text-muted-foreground hover:text-primary",
          )}
          title="Insights"
          aria-label="Insights"
        >
          <BarChart3 className="w-4 h-4" strokeWidth={1.5} />
        </Link>

        <div className="flex-1 overflow-y-auto w-full flex flex-col items-center gap-1 px-1">
          {threads.map((t) => {
            const Icon = seedIcon(t.seed_type, t.title);
            const active = t.id === threadId;
            return (
              <Link
                key={t.id}
                to={`/chat/${t.id}`}
                className={cn(
                  "w-8 h-8 rounded-md grid place-items-center transition-colors",
                  active
                    ? "glass-interactive text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5",
                )}
                title={`${t.title} · ${formatUsd(t.cost_micro_usd)}`}
                aria-label={t.title}
              >
                <Icon className="w-4 h-4" strokeWidth={1.5} />
              </Link>
            );
          })}
        </div>

        <div className="w-8 h-px bg-border-subtle" />

        <button
          onClick={signOut}
          className="w-8 h-8 rounded-lg grid place-items-center text-muted-foreground hover:text-foreground glass-interactive transition-colors"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const byQuery = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  const filtered = typeFilter === "all"
    ? byQuery
    : byQuery.filter((t) => (t.seed_type ?? "other").toLowerCase() === typeFilter);
  // Group ALL cases by recency (updated_at), regardless of run status. Splitting
  // active vs finished into separate sections pushed recently-completed scans
  // below a long "Older" pile of cases still stuck in "active" (runs that never
  // finalized their status), so the newest scans looked lost. One recency-ordered
  // list keeps them at the top; completed runs are shown dimmed with a ✓ in their
  // own bucket rather than banished to a section below the fold.
  const groups: Record<string, Thread[]> = { Today: [], "This week": [], Older: [] };
  for (const t of filtered) groups[bucketOf(t.updated_at)].push(t);
  const totalCost = threads.reduce((s, t) => s + Number(t.cost_micro_usd ?? 0), 0);

  const TYPES: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "email", label: "Email" },
    { key: "username", label: "User" },
    { key: "phone", label: "Phone" },
    { key: "ip", label: "IP" },
    { key: "domain", label: "Domain" },
  ];

  return (
    <div className="w-full h-full flex flex-col bg-[hsl(var(--surface-0))]">
      <div className="px-3 py-3 border-b border-border-subtle flex items-center gap-2">
        <Link
          to="/"
          aria-label="Home"
          className="flex items-center gap-2 min-w-0 group focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-lg"
        >
          <div className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.035] grid place-items-center transition-colors group-hover:bg-white/[0.06]">
            <SwarmMark className="w-4 h-4 text-foreground/90" />
          </div>
          <div className="min-w-0">
            <div className="font-display font-semibold tracking-tight text-sm text-foreground leading-none">Insight Finder</div>
            <div className="mt-0.5 text-eyebrow text-muted-foreground leading-none">Cases</div>
          </div>
        </Link>
        <button
          onClick={onToggleCollapse}
          className="ml-auto w-8 h-8 rounded-lg border border-white/10 bg-white/[0.035] text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose className="w-4 h-4 mx-auto" />
        </button>
      </div>

      <div className="px-3 pt-3 pb-2">
        <Button
          onClick={newThread}
          size="sm"
          variant="cta"
          className="w-full h-9 justify-center gap-2 rounded-lg border border-white/12 text-sm font-semibold"
        >
          <Plus className="w-4 h-4" /> New investigation
        </Button>
        <Link
          to="/cases"
          aria-label="All cases"
          className={cn(
            "relative mt-2 flex items-center gap-2 w-full px-3 py-2 rounded-lg border text-sm font-medium transition-colors",
            onCasesRoute
              ? "border-[hsl(var(--intel-blue)/0.3)] bg-[hsl(var(--intel-blue)/0.1)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--intel-blue)/0.15)]"
              : "border-border-subtle bg-surface-0 text-muted-foreground hover:text-foreground hover:border-white/15 hover:bg-surface-1",
          )}
        >
          <FolderOpen className={cn("w-3.5 h-3.5", onCasesRoute && "text-[hsl(var(--intel-blue))]")} strokeWidth={1.5} />
          <span>All cases</span>
        </Link>
        <Link
          to="/brain"
          aria-label="Global Brain"
          className={cn(
            "relative mt-2 flex items-center gap-2 w-full px-3 py-2 rounded-lg border text-sm font-medium transition-colors",
            onBrainRoute
              ? "border-[hsl(var(--intel-blue)/0.3)] bg-[hsl(var(--intel-blue)/0.1)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--intel-blue)/0.15)]"
              : "border-border-subtle bg-surface-0 text-muted-foreground hover:text-foreground hover:border-white/15 hover:bg-surface-1",
          )}
        >
          <Brain className={cn("w-3.5 h-3.5", onBrainRoute && "text-[hsl(var(--intel-blue))]")} strokeWidth={1.5} />
          <span>Brain</span>
          {newPatternCount > 0 && !onBrainRoute && (
            <span className="ml-auto inline-flex items-center justify-center min-w-[22px] h-[18px] px-1.5 rounded-full bg-white text-black text-eyebrow font-mono font-bold tracking-normal">
              {newPatternCount > 99 ? "99+" : newPatternCount}
            </span>
          )}
        </Link>
        <Link
          to="/insights"
          aria-label="Insights"
          className={cn(
            "relative mt-2 flex items-center gap-2 w-full px-3 py-2 rounded-lg border text-sm font-medium transition-colors",
            onInsightsRoute
              ? "border-[hsl(var(--intel-blue)/0.3)] bg-[hsl(var(--intel-blue)/0.1)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--intel-blue)/0.15)]"
              : "border-border-subtle bg-surface-0 text-muted-foreground hover:text-foreground hover:border-white/15 hover:bg-surface-1",
          )}
        >
          <BarChart3 className={cn("w-3.5 h-3.5", onInsightsRoute && "text-[hsl(var(--intel-blue))]")} strokeWidth={1.5} />
          <span>Insights</span>
        </Link>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-black/20 px-3 py-2 transition-colors focus-within:border-white/20 focus-within:bg-surface-1">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search investigations"
            aria-label="Search investigations"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="px-3 pb-3">
        <label htmlFor="case-type-filter" className="sr-only">Filter investigations</label>
        <select
          id="case-type-filter"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          className="h-9 w-full rounded-lg border border-border-subtle bg-surface-1 px-3 text-sm text-foreground outline-none transition-colors focus:border-white/25"
        >
          {TYPES.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-3">
        {metricsSampled && (
          <div
            className="mb-2 mx-1 inline-flex items-center gap-1 rounded border border-warning/25 bg-warning/8 px-2 py-1 text-eyebrow text-warning"
            title={`Per-thread badges are aggregated from the latest ${SIDEBAR_METRICS_SAMPLE_LIMIT.toLocaleString()} artifact rows. Counts on older or very large threads may be undercounted.`}
          >
            ⚠ Metrics sampled · latest {SIDEBAR_METRICS_SAMPLE_LIMIT.toLocaleString()} rows
          </div>
        )}
        {(["Today", "This week", "Older"] as const).map((bucket) =>
          groups[bucket].length === 0 ? null : (
            <div key={bucket} className="mb-2.5">
              <div className="px-2 py-1 text-eyebrow uppercase tracking-[0.08em] text-muted-foreground flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-muted-foreground/50" />
                {bucket}
                <span className="ml-1 font-mono opacity-50">{groups[bucket].length}</span>
              </div>
              {groups[bucket].map((t) => (
                <ThreadRow
                  key={t.id}
                  t={t}
                  active={t.id === threadId}
                  onDelete={deleteThread}
                  dim={!isActiveThreadStatus(t.status)}
                  m={metrics[t.id]}
                />
              ))}
            </div>
          )
        )}

        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {q ? "No matches" : "No investigations yet"}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-border-subtle space-y-2.5">
        <SpendTrend threads={threads} totalCost={totalCost} />
        <CreditChip credits={credits} />
        <a
          href={SUPPORT_MAILTO}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Mail className="w-3.5 h-3.5" strokeWidth={1.5} />
          <span>Send feedback</span>
        </a>
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="truncate text-muted-foreground" title={user?.email}>{user?.email}</div>
          <button onClick={signOut} className="shrink-0 text-muted-foreground hover:text-foreground transition-colors" aria-label="Sign out" title="Sign out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
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
        "group relative flex items-start justify-between gap-2 pl-3 pr-2 py-2.5 rounded-lg text-meta transition-all duration-500 ease-premium hover:bg-white/[0.045]",
        active && "bg-[hsl(var(--intel-blue)/0.1)] text-foreground ring-1 ring-[hsl(var(--intel-blue)/0.28)] shadow-[inset_2px_0_0_hsl(var(--intel-blue)),0_0_24px_-14px_hsl(var(--intel-blue)/0.8)]",
        dim && !active && "opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-2 bottom-2 w-0.5 rounded-full",
          active ? "bg-gradient-to-b from-primary to-accent" : stripCls,
          !active && sev === "low" && "opacity-50",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate flex items-center gap-1.5 leading-5">
          {dim && <CheckCircle2 className="w-3 h-3 text-confidence-glow shrink-0" />}
          <span className="truncate font-medium" title={t.title}>{t.title}</span>
        </div>
        <div className="text-micro text-muted-foreground flex items-center gap-1.5 flex-wrap leading-5">
          {t.seed_type && (
            <span className="px-1.5 py-0.5 rounded-md border border-border-subtle bg-white/[0.035] text-eyebrow text-muted-foreground">
              {t.seed_type}
            </span>
          )}
          {(m?.artifacts ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-data text-foreground/80" title="Artifacts">
              <Database className="w-2.5 h-2.5 opacity-70" />{m!.artifacts}
            </span>
          )}
          {(m?.breaches ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-data text-[hsl(var(--danger))]" title="Breaches">
              <ShieldAlert className="w-2.5 h-2.5" />{m!.breaches}
            </span>
          )}
          {(m?.lowConf ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono text-data text-[hsl(var(--confidence-mid))]" title="Needs verify">
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
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
        aria-label="Delete"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </Link>
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
    <div className="rounded-xl border border-white/10 bg-white/[0.035] p-1">
      <div className="rounded-lg bg-black/20 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">Spend</span>
          <span className="font-mono text-micro text-muted-foreground">{threads.length} cases</span>
        </div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="font-mono text-title font-semibold text-foreground tabular-nums leading-none">
            {formatUsd(totalCost)}
          </div>
          {series.length > 1 && (
            <span className={cn(
              "inline-flex items-center gap-1 text-micro font-mono font-medium",
              trend === "up" ? "text-[hsl(var(--confidence-mid))]"
              : trend === "down" ? "text-[hsl(var(--brain-cyan))]"
              : "text-muted-foreground",
            )}>
              {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
              {formatUsd(Math.abs(delta))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
