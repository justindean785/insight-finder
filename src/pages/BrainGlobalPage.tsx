import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { ThreadSidebar } from "@/components/ThreadSidebar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  Brain, Sparkles, Lightbulb, Star, Network, Zap, PanelLeftOpen,
  Target, ThumbsUp, CreditCard, TrendingUp,
  Search, X, EyeOff, Trash2, HelpCircle, ArrowUp, User, Building2,
  ArrowRight, Wrench, UserCheck,
} from "lucide-react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";

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

type SubTab = "memories" | "patterns" | "sources" | "credits";
const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "memories", label: "MEMORIES" },
  { id: "patterns", label: "PATTERNS" },
  { id: "sources",  label: "SOURCES" },
  { id: "credits",  label: "CREDITS" },
];

const MEMORY_FILTERS = ["ALL", "IDENTITY", "EMAIL", "USERNAME", "PHONE", "BREACH", "GEO", "SOCIAL"] as const;
type MemoryFilter = typeof MEMORY_FILTERS[number];

const PATTERN_FILTERS = ["ALL", "PHONE", "USERNAME", "EMAIL", "BREACH", "GEO"] as const;
type PatternFilter = typeof PATTERN_FILTERS[number];
const PATTERN_SORTS = ["NEWEST", "CONFIDENCE", "RECALLS"] as const;
type PatternSort = typeof PATTERN_SORTS[number];
const BRAIN_PROMOTED_KEY = "brain_promoted_memories";

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


export default function BrainGlobalPage() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mLeft, setMLeft] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memLoading, setMemLoading] = useState(true);
  const [sinceVisit, setSinceVisit] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("memories");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MemoryFilter>("ALL");
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});
  const [suppressed, setSuppressed] = useState<Set<string>>(() => loadSet(BRAIN_SUPPRESSED_KEY));
  const [deleted, setDeleted] = useState<Set<string>>(() => loadSet(BRAIN_DELETED_KEY));
  const [promoted, setPromoted] = useState<Set<string>>(() => loadSet(BRAIN_PROMOTED_KEY));
  const [patternFilter, setPatternFilter] = useState<PatternFilter>("ALL");
  const [patternSort, setPatternSort] = useState<PatternSort>("NEWEST");

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
    (async () => {
      setMemLoading(true);
      const { data } = await supabase
        .from("agent_memory")
        .select("id,kind,subject,subject_kind,content,related_values,confidence,hit_count,last_used_at,created_at,source_thread_id")
        .order("created_at", { ascending: false })
        .limit(500);
      if (!alive) return;
      const list = (data as Memory[] | null) ?? [];
      setMemories(list);
      setMemLoading(false);
      const ids = Array.from(new Set(list.map((m) => m.source_thread_id).filter(Boolean) as string[]));
      if (ids.length) {
        const { data: t } = await supabase
          .from("threads").select("id,title").in("id", ids);
        if (alive && t) {
          const map: Record<string, string> = {};
          for (const row of t as { id: string; title: string }[]) map[row.id] = row.title;
          setThreadTitles(map);
        }
      }
    })();
    return () => { alive = false; };
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
    const userConfirmed = visible.filter((m) => (m.confidence ?? 0) >= 75).length;
    return { total, recalls, avgConf, newSince, userConfirmed };
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

  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;

  const content = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <header className="sticky top-0 z-10 glass-card border-b border-border-subtle">
        <div className="px-6 pt-5 pb-3 flex items-start gap-3">
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-xl glass-strong grid place-items-center ring-1 ring-primary/40 shadow-[0_0_24px_-6px_hsl(var(--primary)/0.7)]">
              <Brain className="w-5 h-5 text-primary" strokeWidth={1.5} />
            </div>
            <Sparkles className="absolute -top-1 -right-1 w-3 h-3 text-primary animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xl tracking-tight text-foreground">
              AGENT BRAIN · LEARNING LOG
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Patterns, lessons and source weighting the agent has accumulated across investigations.
            </p>
          </div>
          {stats.newSince > 0 && (
            <span className="mt-1 px-2 py-1 rounded-full bg-primary/15 border border-primary/30 text-primary text-[10px] font-mono uppercase tracking-wider shrink-0">
              {stats.newSince} new
            </span>
          )}
        </div>
        <div className="px-6 pb-4 flex gap-2 overflow-x-auto scrollbar-thin">
          <MetricChip icon={Brain} label="MEMORIES" value={stats.total} />
          <MetricChip icon={Zap} label="RECALLS" value={stats.recalls} />
          <MetricChip icon={Target} label="AVG CONFIDENCE" value={`${stats.avgConf}%`} />
          <MetricChip icon={ThumbsUp} label="USER CONFIRMED" value={stats.userConfirmed} />
          <MetricChip icon={CreditCard} label="SOCIALFETCH" value="9,944 left" />
        </div>
        <div className="px-6 pb-3 flex gap-1 border-t border-border-subtle/40 pt-3">
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={cn(
                "px-3 py-1.5 rounded-md text-[10px] uppercase tracking-wider font-mono transition-colors",
                subTab === t.id
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5 border border-transparent",
              )}
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
            onOpenCase={(id) => navigate(`/chat/${id}`)}
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
            onOpenCase={(id) => navigate(`/chat/${id}`)}
          />
        )}
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
          <div className="font-display font-semibold text-sm tracking-tight gradient-text select-none">
            Brain
          </div>
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

function MetricChip({
  icon: Icon, label, value,
}: { icon: typeof Brain; label: string; value: string | number }) {
  return (
    <div className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1/60 px-2.5 py-1.5">
      <Icon className="w-3 h-3 text-muted-foreground" strokeWidth={1.75} />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-[10px] text-muted-foreground">·</span>
      <span className="text-[10px] font-mono text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function MemoryCard({ m, isNew }: { m: Memory; isNew: boolean }) {
  const meta = KIND_META[m.kind] ?? { label: m.kind, Icon: Lightbulb, tone: "text-muted-foreground" };
  const Icon = meta.Icon;
  return (
    <div
      className={cn(
        "glass-card rounded-lg p-3 border transition-colors",
        isNew
          ? "border-primary/40 shadow-[0_0_18px_-8px_hsl(var(--primary)/0.6)]"
          : "border-border-subtle hover:border-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={cn("w-3 h-3 shrink-0", meta.tone)} strokeWidth={1.75} />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{meta.label}</span>
          {m.subject_kind && (
            <span className="px-1 py-px rounded border border-border-subtle font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              {m.subject_kind}
            </span>
          )}
          {isNew && (
            <span className="px-1 py-px rounded font-mono text-[9px] uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
              new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono">
          {m.confidence != null && (
            <span
              style={{
                color:
                  m.confidence >= 75 ? "hsl(var(--confidence-high))" :
                  m.confidence >= 50 ? "hsl(var(--confidence-mid))" :
                  "hsl(var(--confidence-low))",
              }}
            >
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
            <span key={i} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-border-subtle text-muted-foreground [overflow-wrap:anywhere]">
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
            className="w-full h-9 pl-8 pr-8 rounded-lg bg-surface-1/60 border border-border-subtle text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
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
        <div className="ml-auto text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          MEMORIES · <span className="text-foreground tabular-nums">{totalCount}</span>
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-thin -mx-1 px-1">
        {MEMORY_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider font-mono border transition-colors",
              filter === f
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-surface-1/40 text-muted-foreground border-border-subtle hover:text-foreground",
            )}
          >
            {f}
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
            Run Swarmbot on a case to start building the agent's knowledge base.
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
        "glass-card rounded-lg p-3 border transition-colors flex flex-col gap-2",
        suppressed && "opacity-50",
        isNew
          ? "border-primary/40 shadow-[0_0_18px_-8px_hsl(var(--primary)/0.6)]"
          : "border-border-subtle hover:border-primary/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-px rounded border border-border-subtle font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span
              className="text-[10px] font-mono tabular-nums"
              style={{
                color:
                  m.confidence >= 75 ? "hsl(var(--confidence-high))" :
                  m.confidence >= 50 ? "hsl(var(--confidence-mid))" :
                  "hsl(var(--confidence-low))",
              }}
            >
              {m.confidence}%
            </span>
          )}
          {m.hit_count > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] font-mono text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
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
              className="px-1.5 py-0.5 rounded-full bg-white/5 border border-border-subtle text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
              title={threadTitle}
            >
              {threadTitle}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onSuppress}
            aria-label={suppressed ? "Unsuppress memory" : "Suppress memory"}
            className={cn(
              "w-6 h-6 grid place-items-center rounded hover:bg-white/5",
              suppressed ? "text-primary" : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            <EyeOff className="w-3 h-3" strokeWidth={1.75} />
          </button>
          <button
            onClick={onDelete}
            aria-label="Delete memory"
            className="w-6 h-6 grid place-items-center rounded text-muted-foreground/60 hover:text-destructive hover:bg-white/5"
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
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          PATTERNS · <span className="text-foreground tabular-nums">{patterns.length}</span>
        </div>
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-lg bg-surface-1/60 border border-border-subtle p-0.5">
          {PATTERN_SORTS.map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn(
                "px-2 py-1 rounded text-[10px] uppercase tracking-wider font-mono transition-colors",
                sort === s
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-thin -mx-1 px-1">
        {PATTERN_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider font-mono border transition-colors",
              filter === f
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-surface-1/40 text-muted-foreground border-border-subtle hover:text-foreground",
            )}
          >
            {f}
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
            Patterns emerge as the agent observes cross-case regularities.
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
        "glass-card rounded-lg p-3 border transition-colors flex flex-col gap-2",
        suppressed && "opacity-60",
        isNew && !suppressed
          ? "border-primary/40 shadow-[0_0_18px_-8px_hsl(var(--primary)/0.6)]"
          : "border-border-subtle hover:border-primary/30",
        promoted && !suppressed && "ring-1 ring-primary/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <TrendingUp className="w-3 h-3 shrink-0 text-primary" strokeWidth={1.75} />
          <span className="px-1.5 py-px rounded border border-border-subtle font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span
              className="text-[10px] font-mono tabular-nums"
              style={{
                color:
                  m.confidence >= 75 ? "hsl(var(--confidence-high))" :
                  m.confidence >= 50 ? "hsl(var(--confidence-mid))" :
                  "hsl(var(--confidence-low))",
              }}
            >
              {m.confidence}%
            </span>
          )}
          {m.hit_count > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] font-mono text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
          {suppressed && (
            <span className="px-1 py-px rounded font-mono text-[9px] uppercase tracking-wider bg-muted/30 text-muted-foreground border border-border-subtle">
              suppressed
            </span>
          )}
          {promoted && !suppressed && (
            <span className="px-1 py-px rounded font-mono text-[9px] uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
              promoted
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
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
                className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-border-subtle text-muted-foreground [overflow-wrap:anywhere]"
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
          <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">Cases:</span>
          <button
            onClick={onOpenCase}
            className="px-1.5 py-0.5 rounded-full bg-white/5 border border-border-subtle text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
            title={threadTitle}
          >
            {threadTitle}
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 mt-auto pt-1 border-t border-border-subtle/40">
        <button
          onClick={onPromote}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-mono transition-colors hover:bg-white/5",
            promoted ? "text-primary" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <ArrowUp className="w-3 h-3" strokeWidth={1.75} />
          Promote
        </button>
        <button
          onClick={onSuppress}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-mono transition-colors hover:bg-white/5",
            suppressed ? "text-primary" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <EyeOff className="w-3 h-3" strokeWidth={1.75} />
          {suppressed ? "Unsuppress" : "Suppress"}
        </button>
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] uppercase tracking-wider font-mono text-muted-foreground/70 hover:text-destructive hover:bg-white/5"
        >
          <Trash2 className="w-3 h-3" strokeWidth={1.75} />
          Delete
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

function reliabilityColor(p: number): string {
  if (p >= 70) return "hsl(var(--brain-status-ok))";
  if (p >= 40) return "hsl(var(--brain-status-warn))";
  return "hsl(var(--brain-status-bad))";
}

function SourcesTab() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary>({ confirmed: 0, key: 0, recheck: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
      const [{ data: logs }, { data: revs }] = await Promise.all([
        supabase
          .from("tool_usage_log")
          .select("tool_name, ok, created_at")
          .in("tool_name", SOURCE_TOOLS)
          .limit(5000),
        supabase.from("artifact_reviews").select("state"),
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
      }).sort((a, b) => b.runs - a.runs);
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
  }, []);

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Your review marks shift how much the agent trusts each source on future runs.
      </p>

      <div className="flex gap-2 flex-wrap">
        <FeedbackChip label="CONFIRMED" value={reviews.confirmed} tone="hsl(var(--brain-status-ok))" />
        <FeedbackChip label="KEY FINDINGS" value={reviews.key} tone="hsl(var(--primary))" />
        <FeedbackChip label="NEEDS RECHECK" value={reviews.recheck} tone="hsl(var(--brain-status-warn))" />
        <FeedbackChip label="DISMISSED" value={reviews.dismissed} tone="hsl(var(--brain-status-bad))" />
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-1/40 overflow-hidden">
        <div className="px-3 py-2 border-b border-border-subtle/60 flex items-center">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            SOURCE WEIGHTS · <span className="text-foreground tabular-nums">{rows.length}</span>
          </span>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Computing source reliability…</div>
        ) : (
          <div className="divide-y divide-border-subtle/40">
            {rows.map((r) => <SourceWeightRow key={r.tool} row={r} />)}
          </div>
        )}
      </div>

      <LearnsExplainer />
    </div>
  );
}

function FeedbackChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg border bg-surface-1/60 px-2.5 py-1.5"
      style={{ borderColor: `${tone}40` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone }} />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-[10px] text-muted-foreground">·</span>
      <span className="text-[10px] font-mono tabular-nums" style={{ color: tone }}>{value}</span>
    </div>
  );
}

function SourceWeightRow({ row }: { row: SourceRow }) {
  const tone = reliabilityColor(row.reliability);
  const hasDelta = row.delta !== 0;
  const deltaUp = row.delta > 0;
  return (
    <div className="px-3 py-2.5 flex items-center gap-3">
      <div className="font-mono text-xs text-foreground min-w-0 w-44 truncate">{row.tool}</div>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.max(2, row.reliability)}%`, background: tone }}
          />
        </div>
      </div>
      <div className="font-mono text-[11px] tabular-nums w-10 text-right" style={{ color: tone }}>
        {row.reliability}%
      </div>
      <div className="w-12 text-right">
        {hasDelta ? (
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: deltaUp ? "hsl(var(--brain-status-ok))" : "hsl(var(--brain-status-bad))" }}
          >
            {deltaUp ? "+" : ""}{row.delta} {deltaUp ? "↑" : "↓"}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-muted-foreground/60">—</span>
        )}
      </div>
      <span className="px-1.5 py-0.5 rounded border border-border-subtle font-mono text-[10px] text-muted-foreground tabular-nums shrink-0">
        {row.runs} runs
      </span>
    </div>
  );
}

function LearnsExplainer() {
  const Step = ({ Icon, label, sub }: { Icon: typeof Wrench; label: string; sub: string }) => (
    <div className="flex flex-col items-center gap-2 min-w-0 w-24 shrink-0">
      <div className="w-12 h-12 rounded-full grid place-items-center border border-border-subtle bg-surface-1">
        <Icon className="w-5 h-5 text-primary" strokeWidth={1.5} />
      </div>
      <div className="text-[11px] font-mono uppercase tracking-wider text-foreground">{label}</div>
      <div className="text-[10px] text-muted-foreground text-center leading-tight">{sub}</div>
    </div>
  );
  return (
    <div
      className="rounded-xl p-5"
      style={{ background: "hsl(var(--brain-card))", border: "1px solid hsl(var(--brain-border))" }}
    >
      <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-4">
        How the agent learns
      </div>
      <div className="flex items-start justify-center gap-2 sm:gap-4">
        <Step Icon={Wrench} label="Tools" sub="returns results" />
        <ArrowRight className="w-4 h-4 mt-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
        <Step Icon={UserCheck} label="You" sub="confirm or dismiss" />
        <ArrowRight className="w-4 h-4 mt-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
        <Step Icon={Brain} label="Agent" sub="adjusts trust weight" />
      </div>
    </div>
  );
}

// ============================================================
// Credits sub-tab
// ============================================================

const SOCIALFETCH_CAP = 10000;

type RunRow = {
  threadId: string;
  title: string;
  date: string;
  tools: number;
  costUsd: number;
};

function CreditsTab({ onOpenCase }: { onOpenCase: (threadId: string) => void }) {
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
    let alive = true;
    (async () => {
      setLoading(true);
      const [{ data: logs }, { data: threads }] = await Promise.all([
        supabase
          .from("tool_usage_log")
          .select("tool_name, thread_id, cost_micro_usd, charged_micro_usd, created_at")
          .order("created_at", { ascending: false })
          .limit(5000),
        supabase
          .from("threads")
          .select("id, title, cost_micro_usd, updated_at")
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
  }, []);

  const sfLeft = Math.max(0, SOCIALFETCH_CAP - socialUsed);
  const sfPct = Math.min(100, (socialUsed / SOCIALFETCH_CAP) * 100);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* SocialFetch Credits card */}
        <div className="rounded-xl p-5 bg-brain-card border border-brain-border">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-3">
            <CreditCard className="w-3.5 h-3.5" strokeWidth={1.5} />
            SocialFetch Credits
          </div>
          <div className="flex items-baseline gap-2">
            <div className="font-display text-3xl text-foreground tabular-nums">
              {sfLeft.toLocaleString()} <span className="text-base text-muted-foreground font-sans">left</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-1">{socialUsed.toLocaleString()} used</div>
          <div className="mt-4 h-2 w-full bg-white/5 rounded" style={{ borderRadius: 4 }}>
            <div
              className="h-2 rounded"
              style={{ width: `${sfPct}%`, backgroundColor: "hsl(var(--brain-status-ok))", borderRadius: 4 }}
            />
          </div>
          <div className="text-[11px] text-muted-foreground mt-3 font-mono">
            Last used: {timeAgo(socialLastUsed)}
          </div>
        </div>

        {/* Total API Spend card */}
        <div className="rounded-xl p-5 bg-brain-card border border-brain-border">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-3">
            <BarChart3 className="w-3.5 h-3.5" strokeWidth={1.5} />
            Total API Spend
          </div>
          <div className="flex items-baseline gap-2">
            <div className="font-display text-3xl text-foreground tabular-nums">
              ${totalSpendUsd.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">across {caseCount} cases</div>
          </div>
          <div className="mt-4">
            <Sparkline data={spark} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-3 font-mono">
            ${lastRunUsd.toFixed(3)} last run · avg ${avgRunUsd.toFixed(3)}/run
          </div>
        </div>
      </div>

      {/* Per-run breakdown */}
      <div className="rounded-xl bg-brain-card border border-brain-border overflow-hidden">
        <div className="px-5 py-3 border-b border-brain-border text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
          Last 10 Runs
        </div>
        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No runs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/70">
                <th className="text-left font-normal px-5 py-2">Case</th>
                <th className="text-left font-normal px-5 py-2">Date</th>
                <th className="text-left font-normal px-5 py-2">Tools</th>
                <th className="text-right font-normal px-5 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.threadId} className="border-t border-brain-border/60 hover:bg-white/[0.02]">
                  <td className="px-5 py-2.5">
                    <button
                      onClick={() => onOpenCase(r.threadId)}
                      className="text-foreground hover:text-primary text-left truncate max-w-[28ch]"
                    >
                      {r.title}
                    </button>
                  </td>
                  <td className="px-5 py-2.5 text-muted-foreground text-xs">{timeAgo(r.date)}</td>
                  <td className="px-5 py-2.5 text-muted-foreground text-xs tabular-nums">{r.tools}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-foreground tabular-nums">
                    ${r.costUsd.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[12px] text-muted-foreground leading-relaxed">
        API costs are driven by tool count and data volume per run. Pivot-heavy investigations cost more.
        Use Cost-Aware Mode in Swarmbot settings to cap per-run spend.
      </p>
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const w = 220, h = 36;
  const max = Math.max(0.0001, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  const areaPoints = `0,${h} ${points} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9" preserveAspectRatio="none">
      <polygon points={areaPoints} fill="hsl(var(--primary) / 0.15)" />
      <polyline points={points} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} />
    </svg>
  );
}
