import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { InsightsOverview } from "@/pages/Insights";
import { AnalysisTab } from "@/components/panel/AnalysisTab";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import {
  Brain, Lightbulb, Star, Network, Zap, PanelLeftOpen,
  ThumbsUp, CreditCard, TrendingUp,
  Search, X, EyeOff, Trash2, HelpCircle, ArrowUp, User, Building2,
  ArrowRight, Wrench, UserCheck,
} from "lucide-react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

export const BRAIN_LAST_VISITED_KEY = "brain_last_visited";
const BRAIN_VISIT_EVENT = "proximity:brain-visited";
const BRAIN_SUPPRESSED_KEY = "brain_suppressed_memories";
const BRAIN_DELETED_KEY = "brain_deleted_memories";

type Memory = {
  id: string;
  kind: string;
  subject: string;
  subject_kind: string | null;
  content: string;
  related_values: string[] | null;
  confidence: number | null;
  hit_count: number;
  last_used_at: string | null;
  created_at: string;
  source_thread_id?: string | null;
};

const KIND_META: Record<string, { label: string; Icon: typeof Lightbulb; tone: string }> = {
  pattern:    { label: "Patterns",    Icon: TrendingUp, tone: "text-primary" },
  lesson:     { label: "Lessons",     Icon: Lightbulb,  tone: "text-[hsl(var(--confidence-mid))]" },
  identity:   { label: "Identities",  Icon: Star,       tone: "text-primary" },
  connection: { label: "Connections", Icon: Network,    tone: "text-accent" },
};

/**
 * Insights and Brain were two nav destinations answering the same question —
 * "what do I know across my cases?" — so comparing an aggregate stat against
 * the memories behind it meant a round trip. They are one section now:
 * OVERVIEW is the former /insights page, ANALYSIS is the cross-case breakdown,
 * and the original four tabs are unchanged.
 */
type SubTab = "overview" | "analysis" | "memories" | "patterns" | "sources" | "credits";
const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "analysis", label: "Analysis" },
  { id: "memories", label: "Memories" },
  { id: "patterns", label: "Patterns" },
  { id: "sources",  label: "Sources" },
  { id: "credits",  label: "Credits" },
];
const IS_SUB_TAB = (v: string | null): v is SubTab =>
  !!v && SUB_TABS.some((t) => t.id === v);

const MEMORY_FILTERS = ["ALL", "IDENTITY", "EMAIL", "USERNAME", "PHONE", "BREACH", "GEO", "SOCIAL"] as const;
type MemoryFilter = typeof MEMORY_FILTERS[number];

const PATTERN_FILTERS = ["ALL", "PHONE", "USERNAME", "EMAIL", "BREACH", "GEO"] as const;
type PatternFilter = typeof PATTERN_FILTERS[number];
const PATTERN_SORTS = ["NEWEST", "CONFIDENCE", "RECALLS"] as const;
type PatternSort = typeof PATTERN_SORTS[number];
const BRAIN_PROMOTED_KEY = "brain_promoted_memories";

/** Filter and sort keys are stored upper-case; they are labels, so they are
 * shown in sentence case like every other label in the product. */
function titleCase(key: string): string {
  return key.charAt(0) + key.slice(1).toLowerCase();
}

function matchesFilter(m: Memory, f: MemoryFilter): boolean {
  if (f === "ALL") return true;
  const hay = `${m.subject_kind ?? ""} ${m.kind} ${m.subject} ${m.content}`.toUpperCase();
  return hay.includes(f);
}

// Guard localStorage access for SSR + jsdom-without-storage (Vitest) safety.
// Without this, rendering BrainGlobalPage under SSR or unit tests that
// don't bootstrap window.localStorage throws ReferenceError and the page
// can't be pre-rendered or covered by tests.
function loadSet(key: string): Set<string> {
  if (typeof window === "undefined" || !window.localStorage) return new Set();
  try { return new Set(JSON.parse(window.localStorage.getItem(key) ?? "[]")); } catch { return new Set(); }
}
function saveSet(key: string, s: Set<string>) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try { window.localStorage.setItem(key, JSON.stringify(Array.from(s))); } catch { /* quota or private mode — ignore */ }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function BrainGlobalPage() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mLeft, setMLeft] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memLoading, setMemLoading] = useState(true);
  const [sinceVisit, setSinceVisit] = useState<string | null>(null);
  // `?tab=` keeps the merged section deep-linkable, and lets /insights redirect
  // here without losing the destination the analyst actually asked for.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [subTab, setSubTabState] = useState<SubTab>(IS_SUB_TAB(tabParam) ? tabParam : "overview");
  const setSubTab = (t: SubTab) => {
    setSubTabState(t);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", t);
      return next;
    }, { replace: true });
  };
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MemoryFilter>("ALL");
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});
  const [suppressed, setSuppressed] = useState<Set<string>>(() => loadSet(BRAIN_SUPPRESSED_KEY));
  const [deleted, setDeleted] = useState<Set<string>>(() => loadSet(BRAIN_DELETED_KEY));
  const [promoted, setPromoted] = useState<Set<string>>(() => loadSet(BRAIN_PROMOTED_KEY));
  const [patternFilter, setPatternFilter] = useState<PatternFilter>("ALL");
  const [patternSort, setPatternSort] = useState<PatternSort>("NEWEST");
  const [sfCreditsLeft, setSfCreditsLeft] = useState<number | null>(null);

  const toggleSuppress = (id: string) => {
    setSuppressed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      saveSet(BRAIN_SUPPRESSED_KEY, n);
      return n;
    });
  };
  const markDeleted = (id: string) => {
    setDeleted((prev) => {
      const n = new Set(prev); n.add(id); saveSet(BRAIN_DELETED_KEY, n); return n;
    });
  };
  const togglePromote = (id: string) => {
    setPromoted((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      saveSet(BRAIN_PROMOTED_KEY, n);
      return n;
    });
  };

  // Mark visit: snapshot the previous visit timestamp first so we can
  // highlight what is "new since you were last here", then advance the
  // pointer so the sidebar badge clears.
  useEffect(() => {
    const prev = localStorage.getItem(BRAIN_LAST_VISITED_KEY);
    setSinceVisit(prev);
    const now = new Date().toISOString();
    localStorage.setItem(BRAIN_LAST_VISITED_KEY, now);
    window.dispatchEvent(new CustomEvent(BRAIN_VISIT_EVENT));
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const loadMemories = async () => {
      setMemLoading(true);
      const { data } = await supabase
        .from("agent_memory")
        .select("id,kind,subject,subject_kind,content,related_values,confidence,hit_count,last_used_at,created_at,source_thread_id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (!alive) return;
      const list = (data as Memory[] | null) ?? [];
      setMemories(list);
      setMemLoading(false);
      const { count: sfUsed } = await supabase
        .from("tool_usage_log")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("tool_name", "socialfetch_lookup");
      if (alive) setSfCreditsLeft(Math.max(0, SOCIALFETCH_CAP - (sfUsed ?? 0)));

      const ids = Array.from(new Set(list.map((m) => m.source_thread_id).filter(Boolean) as string[]));
      if (ids.length) {
        const { data: t } = await supabase
          .from("threads")
          .select("id,title")
          .eq("user_id", user.id)
          .in("id", ids);
        if (alive && t) {
          const map: Record<string, string> = {};
          for (const row of t as { id: string; title: string }[]) map[row.id] = row.title;
          setThreadTitles(map);
        }
      }
    };
    void loadMemories();
    const channel = supabase
      .channel(`brain-mem-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_memory", filter: `user_id=eq.${user.id}` },
        () => void loadMemories(),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tool_usage_log", filter: `user_id=eq.${user.id}` },
        () => void loadMemories(),
      )
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [user]);

  const stats = useMemo(() => {
    const visible = memories.filter((m) => !deleted.has(m.id));
    const total = visible.length;
    const recalls = visible.reduce((s, m) => s + (m.hit_count ?? 0), 0);
    const avgConf = total
      ? Math.round(visible.reduce((s, m) => s + (m.confidence ?? 0), 0) / total)
      : 0;
    const newSince = sinceVisit
      ? visible.filter((m) => new Date(m.created_at).getTime() > new Date(sinceVisit).getTime()).length
      : 0;
    const highConfidence = visible.filter((m) => (m.confidence ?? 0) >= 75).length;
    return { total, recalls, avgConf, newSince, highConfidence };
  }, [memories, sinceVisit, deleted]);

  const filteredMemories = useMemo(() => {
    const q = search.trim().toLowerCase();
    return memories
      .filter((m) => !deleted.has(m.id))
      .filter((m) => matchesFilter(m, filter))
      .filter((m) => !q || `${m.content} ${m.subject}`.toLowerCase().includes(q));
  }, [memories, search, filter, deleted]);

  const patterns = useMemo(() => {
    const list = memories.filter((m) => !deleted.has(m.id) && m.kind === "pattern");
    const filtered = patternFilter === "ALL"
      ? list
      : list.filter((m) => `${m.subject_kind ?? ""} ${m.subject} ${m.content}`.toUpperCase().includes(patternFilter));
    const sorted = [...filtered].sort((a, b) => {
      if (patternSort === "CONFIDENCE") return (b.confidence ?? 0) - (a.confidence ?? 0);
      if (patternSort === "RECALLS") return (b.hit_count ?? 0) - (a.hit_count ?? 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return sorted;
  }, [memories, deleted, patternFilter, patternSort]);

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;

  const content = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background">
        {/* Phone: this header is sticky, so every pixel it takes is permanently
            gone. Measured at 390px before this change it stood ~330px tall —
            39% of an 844px viewport — ahead of any content. Padding, title size
            and the decorative sub-line are scaled per breakpoint; the desktop
            composition is unchanged. */}
        <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-2.5 sm:pb-3 flex items-start gap-2.5 sm:gap-3">
          <Link
            to="/"
            aria-label="Home"
            className="shrink-0 grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface-1 transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Brain className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-lg sm:text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Intelligence
            </h1>
            {/* Decorative: it restates what the title and the tabs below already
                say. First thing to go on a small screen. The governance note
                below is NOT decorative and stays at every width. */}
            <p className="hidden sm:block text-meta text-muted-foreground mt-0.5">
              Cross-case view: aggregate stats, evidence-quality analysis, saved patterns and source context across every case.
            </p>
            <p className="mt-1 sm:mt-1.5 text-micro text-subtle-foreground">
              Pin, mute and hide on this screen are local view controls. They do not modify
              the source memory or create an audited governance record.
            </p>
          </div>
          {stats.newSince > 0 && (
            <span
              className="mt-1 shrink-0 inline-flex items-baseline gap-1 rounded border border-[hsl(var(--brand)/0.55)] px-1.5 py-0.5 text-micro text-foreground"
              title="Memories created since your last visit to this page"
            >
              <span className="font-mono tabular-nums">{stats.newSince}</span> new
            </span>
          )}
        </div>
        {/* One instrument with five readings, not five capsules competing:
            the cells share their rules (`.hairline-grid`). On a phone the strip
            scrolls sideways rather than wrapping to three rows of sticky
            header. */}
        <div className="px-4 sm:px-6 pb-3 sm:pb-4 overflow-x-auto scrollbar-thin">
          <dl className="hairline-grid min-w-[560px] grid-cols-5">
            <MetricCell label="Memories" value={stats.total.toLocaleString()} />
            <MetricCell label="Recalls" value={stats.recalls.toLocaleString()} />
            <MetricCell label="Avg confidence" value={`${stats.avgConf}%`} />
            <MetricCell
              label="High confidence"
              value={stats.highConfidence.toLocaleString()}
              title="Memories with confidence ≥75%. This is a source/tool confidence score, not an analyst confirmation."
            />
            <MetricCell label="SocialFetch left" value={sfCreditsLeft != null ? sfCreditsLeft.toLocaleString() : "—"} />
          </dl>
        </div>
        <div role="tablist" aria-label="Intelligence views" className="tab-rule px-4 sm:px-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={subTab === t.id}
              onClick={() => setSubTab(t.id)}
              className="tab-rule-item"
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="px-6 py-5">
        {subTab === "memories" && (
          <MemoriesTab
            loading={memLoading}
            memories={filteredMemories}
            totalCount={stats.total}
            search={search}
            setSearch={setSearch}
            filter={filter}
            setFilter={setFilter}
            sinceVisit={sinceVisit}
            threadTitles={threadTitles}
            suppressed={suppressed}
            onSuppress={toggleSuppress}
            onDelete={markDeleted}
            onOpenCase={(id) => navigate(`/cases/${id}`)}
          />
        )}
        {subTab === "patterns" && (
          <PatternsTab
            loading={memLoading}
            patterns={patterns}
            filter={patternFilter}
            setFilter={setPatternFilter}
            sort={patternSort}
            setSort={setPatternSort}
            sinceVisit={sinceVisit}
            threadTitles={threadTitles}
            suppressed={suppressed}
            promoted={promoted}
            onPromote={togglePromote}
            onSuppress={toggleSuppress}
            onDelete={markDeleted}
            onOpenCase={(id) => navigate(`/cases/${id}`)}
          />
        )}
        {subTab === "overview" && <InsightsOverview embedded />}
        {subTab === "analysis" && <AnalysisTab />}
        {subTab === "sources" && <SourcesTab />}
        {subTab === "credits" && <CreditsTab onOpenCase={(id) => navigate(`/chat/${id}`)} />}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col h-[100dvh] w-full bg-background overflow-hidden">
        <header className="sticky top-0 z-30 h-12 px-3 flex items-center justify-between gap-2 glass-card border-b border-border-subtle">
          <button
            onClick={() => setMLeft(true)}
            className="w-9 h-9 rounded-xl grid place-items-center glass-interactive"
            aria-label="Open threads"
          >
            <PanelLeftOpen className="w-4 h-4 text-foreground/80" />
          </button>
          <Link
            to="/"
            aria-label="Home"
            className="font-display font-semibold text-sm tracking-tight gradient-text select-none hover:opacity-80 transition-opacity"
          >
            Brain
          </Link>
          <div className="w-9" />
        </header>
        <main className="flex-1 min-h-0 flex w-full overflow-hidden">
          {content}
        </main>
        <Sheet open={mLeft} onOpenChange={setMLeft}>
          <SheetContent
            side="left"
            className="p-0 w-[86vw] max-w-[320px] sm:max-w-[320px] border-r border-white/5 bg-[hsl(230_14%_4%)] [&>button]:hidden overflow-hidden"
          >
            <ThreadSidebar />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full bg-background overflow-x-hidden">
      <aside className="shrink-0 h-screen border-r border-border-subtle glass-card w-72">
        <ThreadSidebar />
      </aside>
      <main className="flex-1 min-h-0 flex flex-col">{content}</main>
    </div>
  );
}

function MetricCell({ label, value, title }: { label: string; value: string | number; title?: string }) {
  return (
    <div className="px-3 py-2" title={title}>
      <dt className="text-micro text-subtle-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-[15px] leading-tight tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function MemoryCard({ m, isNew }: { m: Memory; isNew: boolean }) {
  const meta = KIND_META[m.kind] ?? { label: m.kind, Icon: Lightbulb, tone: "text-muted-foreground" };
  const Icon = meta.Icon;
  return (
    <div
      className={cn(
        "panel p-3 transition-colors",
        isNew
          ? "border-[hsl(var(--brand)/0.45)]"
          : "hover:border-border-strong",
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={cn("w-3 h-3 shrink-0", meta.tone)} strokeWidth={1.75} />
          <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">{meta.label}</span>
          {m.subject_kind && (
            <span className="px-1 py-px rounded border border-border-subtle text-micro uppercase tracking-wider text-muted-foreground">
              {m.subject_kind}
            </span>
          )}
          {isNew && (
            <span className="px-1 py-px rounded text-micro uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
              new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-data font-mono">
          {m.confidence != null && (
            <span className="tabular-nums text-foreground">
              {m.confidence}%
            </span>
          )}
          {m.hit_count > 0 && (
            <span className="flex items-center gap-0.5 text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
          <span className="text-muted-foreground">{timeAgo(m.last_used_at ?? m.created_at)}</span>
        </div>
      </div>
      <div className="text-xs text-foreground leading-relaxed [overflow-wrap:anywhere]">{m.content}</div>
      {m.related_values && m.related_values.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          {m.related_values.slice(0, 6).map((v, i) => (
            <span key={i} className="font-mono text-data px-1.5 py-0.5 rounded bg-white/5 border border-border-subtle text-muted-foreground [overflow-wrap:anywhere]">
              {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoriesTab({
  loading, memories, totalCount, search, setSearch, filter, setFilter,
  sinceVisit, threadTitles, suppressed, onSuppress, onDelete, onOpenCase,
}: {
  loading: boolean;
  memories: Memory[];
  totalCount: number;
  search: string;
  setSearch: (s: string) => void;
  filter: MemoryFilter;
  setFilter: (f: MemoryFilter) => void;
  sinceVisit: string | null;
  threadTitles: Record<string, string>;
  suppressed: Set<string>;
  onSuppress: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenCase: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories..."
            aria-label="Search memories"
            className="w-full h-9 pl-8 pr-8 rounded-lg bg-surface-1/60 border border-border-subtle text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-white/5"
            >
              <X className="w-3 h-3" strokeWidth={1.75} />
            </button>
          )}
        </div>
        <p className="status-line ml-auto">
          <span><span className="status-value">{totalCount.toLocaleString()}</span> memories</span>
        </p>
      </div>

      <div role="group" aria-label="Filter memories by kind" className="tab-rule tab-rule--sub overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MEMORY_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="tab-rule-item"
          >
            {titleCase(f)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-xs text-muted-foreground py-12">Loading brain state…</div>
      ) : memories.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface-2/40 p-10 text-center">
          <div className="relative w-10 h-10 mx-auto mb-3">
            <Brain className="w-10 h-10 text-muted-foreground" strokeWidth={1.5} />
            <HelpCircle className="absolute -bottom-1 -right-1 w-4 h-4 text-muted-foreground bg-background rounded-full" strokeWidth={1.75} />
          </div>
          <div className="text-sm text-foreground">No memories yet.</div>
          <div className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Run Insight Finder on a case to save investigation context here.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {memories.map((m) => (
            <MemoryRichCard
              key={m.id}
              m={m}
              isNew={!!sinceVisit && new Date(m.created_at) > new Date(sinceVisit)}
              suppressed={suppressed.has(m.id)}
              threadTitle={m.source_thread_id ? threadTitles[m.source_thread_id] : undefined}
              onSuppress={() => onSuppress(m.id)}
              onDelete={() => onDelete(m.id)}
              onOpenCase={() => m.source_thread_id && onOpenCase(m.source_thread_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryRichCard({
  m, isNew, suppressed, threadTitle, onSuppress, onDelete, onOpenCase,
}: {
  m: Memory;
  isNew: boolean;
  suppressed: boolean;
  threadTitle?: string;
  onSuppress: () => void;
  onDelete: () => void;
  onOpenCase: () => void;
}) {
  const typeLabel = (m.subject_kind ?? m.kind).toUpperCase();
  return (
    <div
      className={cn(
        "panel p-3 transition-colors flex flex-col gap-2",
        suppressed && "opacity-50",
        isNew
          ? "border-[hsl(var(--brand)/0.45)]"
          : "hover:border-border-strong",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-px rounded border border-border-subtle text-micro uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span className="text-data font-mono tabular-nums text-foreground">
              {m.confidence}%
            </span>
          )}
          {m.hit_count > 0 && (
            <span className="flex items-center gap-0.5 text-data font-mono text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
        </div>
        <span className="text-data font-mono text-muted-foreground shrink-0">
          {timeAgo(m.last_used_at ?? m.created_at)}
        </span>
      </div>

      <div className="text-xs text-foreground leading-relaxed [overflow-wrap:anywhere]">
        {m.content}
      </div>

      <div className="flex items-center justify-between gap-2 mt-auto pt-1">
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {threadTitle && m.source_thread_id && (
            <button
              onClick={onOpenCase}
              className="px-1.5 py-0.5 rounded-sm bg-white/5 border border-border-subtle text-data text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
              title={threadTitle}
            >
              {threadTitle}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onSuppress}
            aria-label={suppressed ? "Unmute memory (local)" : "Mute memory (local)"}
            title={suppressed ? "Unmute in your local view — no audited change" : "Mute in your local view — no audited change"}
            className={cn(
              "w-6 h-6 grid place-items-center rounded hover:bg-white/5",
              suppressed ? "text-primary" : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            <EyeOff className="w-3 h-3" strokeWidth={1.75} />
          </button>
          <button
            onClick={onDelete}
            aria-label="Hide memory from your local view"
            title="Hide in your local view — no audited deletion"
            className="w-6 h-6 grid place-items-center rounded text-muted-foreground/60 hover:text-foreground hover:bg-white/5"
          >
            <Trash2 className="w-3 h-3" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}

function PatternsTab({
  loading, patterns, filter, setFilter, sort, setSort, sinceVisit,
  threadTitles, suppressed, promoted, onPromote, onSuppress, onDelete, onOpenCase,
}: {
  loading: boolean;
  patterns: Memory[];
  filter: PatternFilter;
  setFilter: (f: PatternFilter) => void;
  sort: PatternSort;
  setSort: (s: PatternSort) => void;
  sinceVisit: string | null;
  threadTitles: Record<string, string>;
  suppressed: Set<string>;
  promoted: Set<string>;
  onPromote: (id: string) => void;
  onSuppress: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenCase: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="status-line">
          <span><span className="status-value">{patterns.length.toLocaleString()}</span> patterns</span>
        </p>
        <div role="group" aria-label="Sort patterns" className="ml-auto tab-rule tab-rule--sub border-b-0">
          <span className="self-center pr-1 text-micro text-subtle-foreground">Sort</span>
          {PATTERN_SORTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sort === s}
              onClick={() => setSort(s)}
              className="tab-rule-item"
            >
              {titleCase(s)}
            </button>
          ))}
        </div>
      </div>

      <div role="group" aria-label="Filter patterns by kind" className="tab-rule tab-rule--sub overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {PATTERN_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="tab-rule-item"
          >
            {titleCase(f)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-xs text-muted-foreground py-12">Loading patterns…</div>
      ) : patterns.length === 0 ? (
        <div className="rounded-xl border border-border-subtle bg-surface-2/40 p-10 text-center">
          <TrendingUp className="w-8 h-8 text-muted-foreground mx-auto mb-3" strokeWidth={1.5} />
          <div className="text-sm text-foreground">No patterns yet.</div>
          <div className="text-xs text-muted-foreground mt-1">
            Saved cross-case patterns will appear here when available.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {patterns.map((m) => (
            <PatternCard
              key={m.id}
              m={m}
              isNew={!!sinceVisit && new Date(m.created_at) > new Date(sinceVisit)}
              suppressed={suppressed.has(m.id)}
              promoted={promoted.has(m.id)}
              threadTitle={m.source_thread_id ? threadTitles[m.source_thread_id] : undefined}
              onPromote={() => onPromote(m.id)}
              onSuppress={() => onSuppress(m.id)}
              onDelete={() => onDelete(m.id)}
              onOpenCase={() => m.source_thread_id && onOpenCase(m.source_thread_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function entityIcon(value: string) {
  // crude heuristic: capitalized multi-word → org, else person
  const looksOrg = /\b(inc|llc|ltd|corp|gmbh|co)\b/i.test(value) || /[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+/.test(value);
  return looksOrg ? Building2 : User;
}

function PatternCard({
  m, isNew, suppressed, promoted, threadTitle,
  onPromote, onSuppress, onDelete, onOpenCase,
}: {
  m: Memory;
  isNew: boolean;
  suppressed: boolean;
  promoted: boolean;
  threadTitle?: string;
  onPromote: () => void;
  onSuppress: () => void;
  onDelete: () => void;
  onOpenCase: () => void;
}) {
  const typeLabel = (m.subject_kind ?? "PATTERN").toUpperCase();
  return (
    <div
      className={cn(
        "panel p-3 transition-colors flex flex-col gap-2",
        suppressed && "opacity-60",
        isNew && !suppressed
          ? "border-[hsl(var(--brand)/0.45)]"
          : "hover:border-border-strong",
        promoted && !suppressed && "border-border-strong",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <TrendingUp className="w-3 h-3 shrink-0 text-primary" strokeWidth={1.75} />
          <span className="px-1.5 py-px rounded border border-border-subtle text-micro uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span className="text-data font-mono tabular-nums text-foreground">
              {m.confidence}%
            </span>
          )}
          {m.hit_count > 0 && (
            <span className="flex items-center gap-0.5 text-data font-mono text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
          {suppressed && (
            <span className="px-1 py-px rounded text-micro uppercase tracking-wider bg-muted/30 text-muted-foreground border border-border-subtle">
              suppressed
            </span>
          )}
          {promoted && !suppressed && (
            <span className="px-1 py-px rounded text-micro uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
              promoted
            </span>
          )}
        </div>
        <span className="text-data font-mono text-muted-foreground shrink-0">
          {timeAgo(m.last_used_at ?? m.created_at)}
        </span>
      </div>

      <div
        className={cn(
          "text-xs leading-relaxed [overflow-wrap:anywhere]",
          suppressed ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {m.content}
      </div>

      {m.related_values && m.related_values.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {m.related_values.slice(0, 6).map((v, i) => {
            const Icon = entityIcon(v);
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1 font-mono text-data px-1.5 py-0.5 rounded bg-white/5 border border-border-subtle text-muted-foreground [overflow-wrap:anywhere]"
              >
                <Icon className="w-2.5 h-2.5" strokeWidth={1.75} />
                {v}
              </span>
            );
          })}
        </div>
      )}

      {threadTitle && m.source_thread_id && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-micro text-subtle-foreground">Case</span>
          <button
            onClick={onOpenCase}
            className="px-1.5 py-0.5 rounded-sm bg-white/5 border border-border-subtle text-data text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
            title={threadTitle}
          >
            {threadTitle}
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 mt-auto pt-1 border-t border-border-subtle/40">
        <button
          onClick={onPromote}
          title="Pin in your local view — no audited change to source priority"
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded text-micro font-medium transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            promoted ? "text-primary" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <ArrowUp className="w-3 h-3" strokeWidth={1.75} />
          {promoted ? "Unpin" : "Pin locally"}
        </button>
        <button
          onClick={onSuppress}
          title="Mute in your local view — no audited change to source memory"
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded text-micro font-medium transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            suppressed ? "text-primary" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <EyeOff className="w-3 h-3" strokeWidth={1.75} />
          {suppressed ? "Unmute" : "Mute locally"}
        </button>
        <button
          onClick={onDelete}
          title="Hide in your local view — no audited deletion"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-micro font-medium text-muted-foreground/70 hover:text-foreground hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="w-3 h-3" strokeWidth={1.75} />
          Hide locally
        </button>
      </div>
    </div>
  );
}
const SOURCE_TOOLS = [
  "username_sweep", "leakcheck_lookup", "socialfetch_lookup", "firecrawl_scrape",
  "minimax_web_search", "gemini_deep_dork", "triage_seed", "breach_check",
  "deepfind_disposable_email", "oathnet_lookup", "intelbase_email_lookup",
  "exa_search", "jina_reader_scrape",
];

type SourceRow = {
  tool: string;
  reliability: number; // 0-100
  delta: number;       // pp change recent vs prior
  runs: number;
};

type ReviewSummary = { confirmed: number; key: number; recheck: number; dismissed: number };

/**
 * Reliability is a magnitude, so it is carried by the LENGTH of a neutral bar,
 * never by hue (DESIGN.md "Authority Rule"). It used to be green at >=70%,
 * which on a healthy toolset painted every row the same green and said
 * nothing. A 1px tick at this threshold gives the eye a reference instead:
 * the bar that stops short of the line is the one to look at.
 */
const RELIABILITY_TICK = 90;

function SourcesTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary>({ confirmed: 0, key: 0, recheck: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
      const [{ data: logs }, { data: revs }] = await Promise.all([
        supabase
          .from("tool_usage_log")
          .select("tool_name, ok, created_at")
          .eq("user_id", user.id)
          .in("tool_name", SOURCE_TOOLS)
          .limit(5000),
        supabase.from("artifact_reviews").select("state").eq("user_id", user.id),
      ]);
      if (!alive) return;
      const byTool = new Map<string, { okR: number; nR: number; okP: number; nP: number }>();
      for (const t of SOURCE_TOOLS) byTool.set(t, { okR: 0, nR: 0, okP: 0, nP: 0 });
      for (const row of (logs as { tool_name: string; ok: boolean; created_at: string }[] | null) ?? []) {
        const b = byTool.get(row.tool_name);
        if (!b) continue;
        const recent = row.created_at >= cutoff;
        if (recent) { b.nR++; if (row.ok) b.okR++; }
        else { b.nP++; if (row.ok) b.okP++; }
      }
      const computed: SourceRow[] = SOURCE_TOOLS.map((t) => {
        const b = byTool.get(t)!;
        const total = b.nR + b.nP;
        const overall = total ? Math.round(((b.okR + b.okP) / total) * 100) : 0;
        const rPct = b.nR ? (b.okR / b.nR) * 100 : NaN;
        const pPct = b.nP ? (b.okP / b.nP) * 100 : NaN;
        const delta = isFinite(rPct) && isFinite(pPct) ? Math.round(rPct - pPct) : 0;
        return { tool: t, reliability: overall, delta, runs: total };
      })
        // Only surface sources this user has ACTUALLY run — otherwise a new
        // account sees all 13 tools at 0%/0 runs, which reads as fake example
        // data rather than their own live activity.
        .filter((r) => r.runs > 0)
        .sort((a, b) => b.runs - a.runs);
      setRows(computed);

      const summary: ReviewSummary = { confirmed: 0, key: 0, recheck: 0, dismissed: 0 };
      for (const r of (revs as { state: string }[] | null) ?? []) {
        if (r.state === "confirmed") summary.confirmed++;
        else if (r.state === "key") summary.key++;
        else if (r.state === "recheck") summary.recheck++;
        else if (r.state === "dismissed") summary.dismissed++;
      }
      setReviews(summary);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user]);

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Tool reliability reflects recent run outcomes; review totals summarize your saved case decisions.
      </p>

      {/* Analyst review states, on the authority ladder's own hues: each is a
          verdict someone made, so it may spend colour. The dot carries the
          hue, the word carries the meaning, the number stays ink. */}
      <dl className="hairline-grid grid-cols-2 sm:grid-cols-4">
        <FeedbackCell label="Confirmed" value={reviews.confirmed} tone="hsl(var(--authority-verified))" />
        <FeedbackCell label="Key findings" value={reviews.key} tone="hsl(var(--foreground))" />
        <FeedbackCell label="Needs recheck" value={reviews.recheck} tone="hsl(var(--authority-review))" />
        <FeedbackCell label="Dismissed" value={reviews.dismissed} tone="hsl(var(--authority-failed))" />
      </dl>

      <div className="panel overflow-hidden">
        <div className="panel-head">
          <span className="label-eyebrow">Source reliability</span>
          <span className="ml-auto text-micro text-subtle-foreground">
            <span className="font-mono tabular-nums text-muted-foreground">{rows.length}</span> sources · tick at {RELIABILITY_TICK}%
          </span>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Computing source reliability…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No source activity yet — run an investigation to see tool outcomes here.</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((r) => <SourceWeightRow key={r.tool} row={r} />)}
          </div>
        )}
      </div>

      <SavedContextExplainer />
    </div>
  );
}

function FeedbackCell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="px-3 py-2">
      <dt className="flex items-center gap-1.5 text-micro text-subtle-foreground">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: tone }} />
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-[15px] leading-tight tabular-nums text-foreground">{value.toLocaleString()}</dd>
    </div>
  );
}

function SourceWeightRow({ row }: { row: SourceRow }) {
  const hasDelta = row.delta !== 0;
  const deltaUp = row.delta > 0;
  const belowTick = row.reliability < RELIABILITY_TICK;
  return (
    <div className="px-3 py-2 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_2.75rem_3rem_4.5rem] items-center gap-3">
      <div className="font-mono text-data text-foreground truncate" title={row.tool}>{row.tool}</div>
      <div className="relative h-1.5 bg-surface-3" aria-hidden>
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-slow ease-standard"
          style={{
            // 0% draws nothing: a 2% stub on a zero reads as "a little".
            width: `${row.reliability === 0 ? 0 : Math.max(1.5, row.reliability)}%`,
            background: belowTick ? "hsl(var(--foreground))" : "hsl(var(--foreground) / 0.4)",
          }}
        />
        <div
          className="absolute -inset-y-1 w-px bg-[hsl(var(--border-strong))]"
          style={{ left: `${RELIABILITY_TICK}%` }}
        />
      </div>
      <div className={cn("font-mono text-data tabular-nums text-right", belowTick ? "text-foreground" : "text-muted-foreground")}>
        {row.reliability}%
      </div>
      <div className="text-right font-mono text-data tabular-nums text-subtle-foreground">
        {hasDelta ? (
          <span title={`${deltaUp ? "Up" : "Down"} ${Math.abs(row.delta)} points, recent runs against earlier runs`}>
            {deltaUp ? "+" : "−"}{Math.abs(row.delta)} {deltaUp ? "↑" : "↓"}
          </span>
        ) : (
          <span aria-label="No change">—</span>
        )}
      </div>
      <span className="text-right font-mono text-data tabular-nums text-subtle-foreground">
        {row.runs.toLocaleString()} <span className="font-sans">{row.runs === 1 ? "run" : "runs"}</span>
      </span>
    </div>
  );
}

function SavedContextExplainer() {
  const Step = ({ Icon, label, sub }: { Icon: typeof Wrench; label: string; sub: string }) => (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-surface-1">
        <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <div className="min-w-0">
        <div className="text-meta font-medium text-foreground">{label}</div>
        <div className="text-micro text-subtle-foreground">{sub}</div>
      </div>
    </div>
  );
  return (
    <div className="panel p-4">
      <div className="label-eyebrow mb-3">What this page shows</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Step Icon={Wrench} label="Tools" sub="return findings" />
        <ArrowRight className="h-4 w-4 shrink-0 text-faint-foreground" strokeWidth={1.5} aria-hidden />
        <Step Icon={UserCheck} label="Reviews" sub="save decisions" />
        <ArrowRight className="h-4 w-4 shrink-0 text-faint-foreground" strokeWidth={1.5} aria-hidden />
        <Step Icon={Brain} label="Intelligence" sub="shows saved context" />
      </div>
    </div>
  );
}

// ============================================================
// Credits sub-tab
// ============================================================

export const SOCIALFETCH_CAP = 10000;

type RunRow = {
  threadId: string;
  title: string;
  date: string;
  tools: number;
  costUsd: number;
};

function CreditsTab({ onOpenCase }: { onOpenCase: (threadId: string) => void }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [socialUsed, setSocialUsed] = useState(0);
  const [socialLastUsed, setSocialLastUsed] = useState<string | null>(null);
  const [totalSpendUsd, setTotalSpendUsd] = useState(0);
  const [caseCount, setCaseCount] = useState(0);
  const [lastRunUsd, setLastRunUsd] = useState(0);
  const [avgRunUsd, setAvgRunUsd] = useState(0);
  const [spark, setSpark] = useState<number[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const [{ data: logs }, { data: threads }] = await Promise.all([
        supabase
          .from("tool_usage_log")
          .select("tool_name, thread_id, cost_micro_usd, charged_micro_usd, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(5000),
        supabase
          .from("threads")
          .select("id, title, cost_micro_usd, updated_at")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(500),
      ]);
      if (!alive) return;

      const logRows = (logs ?? []) as Array<{
        tool_name: string; thread_id: string | null; cost_micro_usd: number; charged_micro_usd: number | null; created_at: string;
      }>;
      const threadRows = (threads ?? []) as Array<{
        id: string; title: string; cost_micro_usd: number; updated_at: string;
      }>;

      // SocialFetch usage = count of socialfetch_lookup calls.
      const sfCalls = logRows.filter((l) => l.tool_name === "socialfetch_lookup");
      setSocialUsed(sfCalls.length);
      setSocialLastUsed(sfCalls[0]?.created_at ?? null);

      // Total spend across cases.
      const total = threadRows.reduce((s, t) => s + (Number(t.cost_micro_usd) || 0), 0) / 1_000_000;
      const withSpend = threadRows.filter((t) => (Number(t.cost_micro_usd) || 0) > 0);
      setTotalSpendUsd(total);
      setCaseCount(withSpend.length);

      // Per-run breakdown: group logs by thread_id, take last 10 distinct threads.
      const byThread = new Map<string, { cost: number; tools: Set<string>; date: string }>();
      for (const l of logRows) {
        if (!l.thread_id) continue;
        const cur = byThread.get(l.thread_id) ?? { cost: 0, tools: new Set<string>(), date: l.created_at };
        const charged = l.charged_micro_usd ?? l.cost_micro_usd;
        cur.cost += (Number(charged) || 0) / 1_000_000;
        cur.tools.add(l.tool_name);
        if (l.created_at > cur.date) cur.date = l.created_at;
        byThread.set(l.thread_id, cur);
      }
      const titleMap = new Map(threadRows.map((t) => [t.id, t.title]));
      const runRows: RunRow[] = Array.from(byThread.entries())
        .map(([threadId, v]) => ({
          threadId,
          title: titleMap.get(threadId) ?? "Untitled case",
          date: v.date,
          tools: v.tools.size,
          costUsd: v.cost,
        }))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 10);
      setRuns(runRows);

      setLastRunUsd(runRows[0]?.costUsd ?? 0);
      const allRunCosts = Array.from(byThread.values()).map((v) => v.cost).filter((c) => c > 0);
      setAvgRunUsd(allRunCosts.length ? allRunCosts.reduce((a, b) => a + b, 0) / allRunCosts.length : 0);

      // Sparkline: spend per day, last 14 days.
      const days = 14;
      const buckets = new Array(days).fill(0);
      const now = Date.now();
      for (const l of logRows) {
        const ageDays = Math.floor((now - new Date(l.created_at).getTime()) / 86_400_000);
        if (ageDays >= 0 && ageDays < days) {
          const charged = l.charged_micro_usd ?? l.cost_micro_usd;
          buckets[days - 1 - ageDays] += (Number(charged) || 0) / 1_000_000;
        }
      }
      setSpark(buckets);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user]);

  const sfLeft = Math.max(0, SOCIALFETCH_CAP - socialUsed);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* SocialFetch Credits card */}
        <div className="panel p-5">
          <div className="label-eyebrow mb-3 flex items-center gap-2">
            <CreditCard className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
            SocialFetch credits
          </div>
          <div className="flex items-baseline gap-2">
            <div className="stat-figure font-display text-3xl font-semibold">
              {sfLeft.toLocaleString()} <span className="text-base text-muted-foreground font-sans">left</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            <span className="font-mono tabular-nums">{socialUsed.toLocaleString()}</span> of {SOCIALFETCH_CAP.toLocaleString()} used
          </div>
          <CreditMeter left={sfLeft} cap={SOCIALFETCH_CAP} />
          <div className="text-data text-muted-foreground mt-3">
            {socialLastUsed ? <>Last used <span className="font-mono">{timeAgo(socialLastUsed)}</span></> : "Not used yet"}
          </div>
        </div>

        {/* Total API Spend card */}
        <div className="panel p-5">
          <div className="label-eyebrow mb-3 flex items-center gap-2">
            <BarChart3 className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
            Total API spend
          </div>
          <div className="flex items-baseline gap-2">
            <div className="stat-figure font-display text-3xl font-semibold">
              ${totalSpendUsd.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">across {caseCount} cases</div>
          </div>
          <div className="mt-4">
            <Sparkline data={spark} />
          </div>
          <p className="status-line mt-3">
            <span><span className="status-value">${lastRunUsd.toFixed(3)}</span> last run</span>
            <span><span className="status-value">${avgRunUsd.toFixed(3)}</span> avg per run</span>
          </p>
        </div>
      </div>

      {/* Per-run breakdown */}
      <div className="panel overflow-hidden">
        <div className="panel-head">
          <span className="label-eyebrow">Last 10 runs</span>
        </div>
        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No runs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-eyebrow uppercase tracking-wider text-subtle-foreground">
                <th className="text-left font-normal px-5 py-2">Case</th>
                <th className="text-left font-normal px-5 py-2">Date</th>
                <th className="text-left font-normal px-5 py-2">Tools</th>
                <th className="text-right font-normal px-5 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.threadId} className="border-t border-border-subtle hover:bg-white/[0.02]">
                  <td className="px-5 py-2.5">
                    <button
                      onClick={() => onOpenCase(r.threadId)}
                      className="text-foreground hover:underline underline-offset-2 text-left truncate max-w-[28ch] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {r.title}
                    </button>
                  </td>
                  <td className="px-5 py-2.5 text-muted-foreground text-xs">{timeAgo(r.date)}</td>
                  <td className="px-5 py-2.5 text-muted-foreground text-xs font-mono tabular-nums">{r.tools}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-foreground tabular-nums">
                    ${r.costUsd.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-data text-muted-foreground leading-relaxed">
        API costs are driven by tool count and data volume per run. Pivot-heavy investigations cost more.
        Use Cost-Aware Mode in Insight Finder settings to cap per-run spend.
      </p>
    </div>
  );
}

/**
 * SocialFetch balance as a ruled meter: 40 cells of 250 credits, each filled
 * by exactly the share of its 250 that is still left. The old bar drew 40
 * used credits of 10,000 as a 0.4% sliver that read as a rendering glitch;
 * cells make the remaining balance countable at a glance without a hue.
 */
const METER_CELLS = 40;
function CreditMeter({ left, cap }: { left: number; cap: number }) {
  const per = cap / METER_CELLS;
  return (
    <div
      role="meter"
      aria-label="SocialFetch credits left"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={left}
      className="mt-4 grid gap-px"
      style={{ gridTemplateColumns: `repeat(${METER_CELLS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: METER_CELLS }, (_, i) => {
        const fill = Math.min(1, Math.max(0, (left - i * per) / per));
        return (
          <span key={i} className="relative h-2.5 bg-surface-3">
            <span className="absolute inset-y-0 left-0 bg-[hsl(var(--foreground)/0.55)]" style={{ width: `${fill * 100}%` }} />
          </span>
        );
      })}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const w = 220, h = 36;
  const max = Math.max(0.0001, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const ys = data.map((v) => h - (v / max) * (h - 4) - 2);
  const points = ys.map((y, i) => `${(i * step).toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPoints = `0,${h} ${points} ${w},${h}`;
  const lastY = ys.length ? ys[ys.length - 1] : null;
  return (
    // The dot is HTML, not SVG: the chart stretches (preserveAspectRatio
    // none) and a stretched circle is an ellipse. It is the one accent on the
    // card because it marks the live end of the series, today.
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9" preserveAspectRatio="none" aria-hidden>
        <polygon points={areaPoints} fill="hsl(var(--foreground) / 0.08)" />
        <polyline points={points} fill="none" stroke="hsl(var(--foreground) / 0.7)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
      </svg>
      {lastY != null && (
        <span
          aria-hidden
          className="absolute right-0 h-1.5 w-1.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-[hsl(var(--brand))]"
          style={{ top: `${(lastY / h) * 100}%` }}
        />
      )}
    </div>
  );
}
