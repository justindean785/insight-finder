import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { InsightsOverview } from "@/pages/Insights";
import { AnalysisTab } from "@/components/panel/AnalysisTab";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { ShellTopBar, ShellTopBarTitle } from "@/components/shell/AppShell";
import { FullPageLoader } from "@/components/ui/full-page-loader";
import {
  Brain, Sparkles, Lightbulb, Star, Network, Zap,
  Target, ThumbsUp, CreditCard, TrendingUp,
  Search, X, EyeOff, Trash2, HelpCircle, ArrowUp, User, Building2,
  ArrowRight, Wrench, UserCheck,
} from "lucide-react";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToolObservations } from "@/hooks/useToolObservations";
import { ToolObservationsPanel } from "@/components/brain/ToolObservationsPanel";
import { MEMORY_SAMPLE_CAP, describeMemorySample, type MemoryTotal } from "@/lib/memory-population";
import { describeCreditAccount, type CreditAccount } from "@/lib/credit-account";
import { formatUsd, latestRun } from "@/lib/run-economics";
import { useRunEconomics } from "@/hooks/useRunEconomics";
import { RunEconomicsPanel } from "@/components/brain/RunEconomicsPanel";
import {
  SOURCE_RELIABILITY_ROW_LIMIT,
  describeSourceReliability,
  summarizeSourceReliability,
  windowStartIso,
  type SourceLogRow,
  type SourceReliability,
} from "@/lib/source-reliability";

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
  { id: "overview", label: "OVERVIEW" },
  { id: "analysis", label: "ANALYSIS" },
  { id: "memories", label: "MEMORIES" },
  { id: "patterns", label: "PATTERNS" },
  { id: "sources",  label: "SOURCES" },
  { id: "credits",  label: "CREDITS" },
];
const IS_SUB_TAB = (v: string | null): v is SubTab =>
  !!v && SUB_TABS.some((t) => t.id === v);

const MEMORY_FILTERS = ["ALL", "IDENTITY", "EMAIL", "USERNAME", "PHONE", "BREACH", "GEO", "SOCIAL"] as const;
type MemoryFilter = typeof MEMORY_FILTERS[number];

const PATTERN_FILTERS = ["ALL", "PHONE", "USERNAME", "EMAIL", "BREACH", "GEO"] as const;
type PatternFilter = typeof PATTERN_FILTERS[number];
const PATTERN_SORTS = ["NEWEST", "CONFIDENCE", "HITS"] as const;
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
  // Exact stored row count on `agent_memory` for this user, independent of the
  // 500-row recent sample this page renders. Tri-state on purpose: "not read
  // yet" and "the count query failed" used to collapse into one `null`, and
  // that null rendered "all memories fit in the slice" — a completeness claim
  // made while the count was still loading or had errored (plan 2026-10-31,
  // D10). `loading` is set only on the first read, so a realtime refresh
  // does not flash the caption back to a skeleton.
  const [memoriesTotal, setMemoriesTotal] = useState<MemoryTotal>({ state: "loading" });

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
      // The recent sample and its denominator are read together, in the same
      // loader, so the realtime channel below refreshes both at once and the
      // caption never pairs a fresh sample with a stale total. The sample is
      // capped at 500 newest rows for rendering; the count is the stored
      // population, exact, no cap.
      const [sampleRes, countRes] = await Promise.all([
        supabase
          .from("agent_memory")
          .select("id,kind,subject,subject_kind,content,related_values,confidence,hit_count,last_used_at,created_at,source_thread_id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(MEMORY_SAMPLE_CAP),
        supabase
          .from("agent_memory")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id),
      ]);
      if (!alive) return;
      const list = (sampleRes.data as Memory[] | null) ?? [];
      setMemories(list);
      setMemLoading(false);
      // A failed count is NOT zero and NOT "everything fit". It is unavailable,
      // and the caption says so.
      setMemoriesTotal(
        countRes.error || countRes.count == null
          ? { state: "error" }
          : { state: "ok", total: countRes.count },
      );
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

  // Three populations, each named where it is shown (plan 2026-10-31 §4.1):
  //   stored  — exact count of every agent_memory row (memoriesTotal)
  //   sample  — the 500 newest rows this page fetched (memories.length)
  //   shown   — the sample minus rows hidden in THIS browser (`deleted` set)
  // Every statistic in the header is over `shown`. Muting (`suppressed`) is a
  // view effect only and changes none of these numbers.
  const stats = useMemo(() => {
    const visible = memories.filter((m) => !deleted.has(m.id));
    const sample = memories.length;
    const total = visible.length;
    const hidden = sample - total;
    const hits = visible.reduce((s, m) => s + (m.hit_count ?? 0), 0);
    // `null`, not 0: an empty sample has no average, and "0%" would read as a
    // measured low score.
    const avgConf = total
      ? Math.round(visible.reduce((s, m) => s + (m.confidence ?? 0), 0) / total)
      : null;
    const newSince = sinceVisit
      ? visible.filter((m) => new Date(m.created_at).getTime() > new Date(sinceVisit).getTime()).length
      : 0;
    const highConfidence = visible.filter((m) => (m.confidence ?? 0) >= 75).length;
    return { sample, total, hidden, hits, avgConf, newSince, highConfidence };
  }, [memories, sinceVisit, deleted]);

  // `loading` is the FIRST read only. `loadMemories` sets memLoading on every
  // realtime refresh (an agent_memory change, or a tool_usage_log INSERT on
  // each tool call of a live scan); without this guard the sticky caption
  // flashed to "… of —" on every one of them.
  const sampleCaption = describeMemorySample({
    loading: memLoading && memoriesTotal.state === "loading",
    sample: stats.sample,
    shown: stats.total,
    hidden: stats.hidden,
    total: memoriesTotal,
  });

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
      if (patternSort === "HITS") return (b.hit_count ?? 0) - (a.hit_count ?? 0);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return sorted;
  }, [memories, deleted, patternFilter, patternSort]);

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/auth" replace />;

  const content = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <header className="sticky top-0 z-10 glass-card border-b border-border-subtle">
        {/* Phone: this header is sticky, so every pixel it takes is permanently
            gone. Measured at 390px before 2026-10 it stood ~330px tall — 39% of
            an 844px viewport — ahead of any content. The decorative sub-line
            ("Aggregate stats, evidence-quality analysis…") is gone at every
            width now: it restated the title and the tabs. The governance note
            is NOT decorative and stays at every width. Tokens untouched. */}
        <div className="px-4 sm:px-6 pt-3 sm:pt-4 pb-2 flex items-start gap-2.5 sm:gap-3">
          <Link
            to="/"
            aria-label="Home"
            className="relative shrink-0 rounded-xl"
          >
            <div className="w-10 h-10 rounded-xl glass-strong grid place-items-center ring-1 ring-primary/40 hover:bg-white/[0.04] transition-colors">
              <Brain className="w-5 h-5 text-primary" strokeWidth={1.5} />
            </div>
            <Sparkles className="absolute -top-1 -right-1 w-3 h-3 text-primary animate-pulse" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-base sm:text-xl tracking-tight text-foreground">
              INTELLIGENCE · CROSS-CASE VIEW
            </h1>
            <p className="mt-1 text-micro text-muted-foreground">
              Pin / mute / hide actions on this screen are local view controls — they do not modify
              the source memory or create an audited governance record.
              {stats.newSince > 0 && " “New” counts memories created since this browser last opened this screen."}
            </p>
          </div>
          {stats.newSince > 0 && (
            <span className="mt-1 px-2 py-1 rounded-full bg-primary/15 border border-primary/30 text-primary text-eyebrow font-mono uppercase tracking-wider shrink-0">
              {stats.newSince} new
            </span>
          )}
        </div>

        {/* Two chip groups, each titled by the population it describes. The
            scope is on-screen text, never a `title=` tooltip: a phone has no
            hover, and the 2026-10-31 audit found "MEMORIES · 500" beside
            "Memories 1,672" and "AVG CONFIDENCE 66%" beside "Avg confidence 49%"
            — same labels, two populations (recent sample vs. stored) and two
            nouns (memory confidence vs. artifact confidence). */}
        <div className="px-4 sm:px-6 pb-2.5 sm:pb-3 flex flex-col gap-2">
          <section aria-labelledby="memory-sample-title" data-testid="memory-sample-group">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 id="memory-sample-title" className="text-eyebrow uppercase tracking-wider text-muted-foreground">
                Recent memory sample
              </h2>
              <span className="text-eyebrow text-muted-foreground" aria-hidden="true">·</span>
              <span className="text-meta text-foreground tabular-nums" data-testid="memory-sample-caption">
                {sampleCaption}
              </span>
            </div>
            <div className="mt-1.5 flex gap-2 overflow-x-auto scrollbar-thin edge-fade-x">
              <MetricChip icon={Zap} label="Hits (recalls + re-saves)" value={stats.hits} />
              <MetricChip
                icon={Target}
                label="Memory confidence (sample)"
                value={stats.avgConf == null ? "—" : `${stats.avgConf}%`}
              />
              <MetricChip icon={TrendingUp} label="High confidence (≥75)" value={stats.highConfidence} />
            </div>
            {/* Phone: the sticky header measured 349px at 375 wide with this
                paragraph open (43% of the viewport), so below `sm` it is a
                tap-to-open disclosure — still text, still no hover. Desktop
                keeps it open; the summary is hidden there. */}
            <details open={!isMobile} className="mt-1.5">
              <summary className="sm:hidden cursor-pointer text-micro text-muted-foreground underline underline-offset-2 [&::-webkit-details-marker]:hidden list-none">
                What these numbers mean
              </summary>
            <p className="text-micro text-muted-foreground">
              Over the {stats.total.toLocaleString()} shown rows. A row's hit count rises when
              {" "}<code className="font-mono">memory_recall</code> surfaces it and when the same lesson is saved again, so
              hits are not recalls. Memory confidence is a per-memory source/tool score — not the Overview's artifact
              confidence, not analyst review.
              {stats.hidden > 0 && " Rows hidden in this browser are excluded from these numbers and still exist in the database."}
              {" "}Muting changes no number.
            </p>
            </details>
          </section>
          <section aria-labelledby="credits-group-title" data-testid="credits-group">
            <h2 id="credits-group-title" className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              Credits
            </h2>
            <div className="mt-1.5 flex gap-2 overflow-x-auto scrollbar-thin edge-fade-x">
              <MetricChip
                icon={CreditCard}
                label="SocialFetch"
                value={sfCreditsLeft != null ? `${sfCreditsLeft.toLocaleString()} left` : "—"}
              />
            </div>
          </section>
        </div>
        <div className="px-6 pb-3 flex gap-1 border-t border-border-subtle/40 pt-3">
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={cn(
                "px-3 py-1.5 rounded-md text-eyebrow uppercase tracking-wider font-mono transition-colors",
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

  // The cases rail / phone drawer belong to AppShell. On a phone this page
  // adds the shell's top bar so the drawer stays one tap away.
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      {isMobile && (
        <ShellTopBar>
          <ShellTopBarTitle>Intelligence</ShellTopBarTitle>
        </ShellTopBar>
      )}
      <main className="flex min-h-0 w-full flex-1 flex-col">{content}</main>
    </div>
  );
}

/**
 * One reading in the header strip. It carries NO `title`: the population a
 * chip describes is stated by its group caption as text, because a tooltip is
 * unreachable on a phone and was where the old scope explanations hid.
 */
function MetricChip({
  icon: Icon, label, value,
}: { icon: typeof Brain; label: string; value: string | number }) {
  return (
    <div className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1/60 px-2.5 py-1.5">
      <Icon className="w-3 h-3 text-muted-foreground" strokeWidth={1.75} />
      <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-data text-muted-foreground">·</span>
      <span className="text-data font-mono text-foreground tabular-nums">{value}</span>
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
          <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">{meta.label}</span>
          {m.subject_kind && (
            <span className="px-1 py-px rounded border border-border-subtle font-mono text-micro uppercase tracking-wider text-muted-foreground">
              {m.subject_kind}
            </span>
          )}
          {isNew && (
            <span className="px-1 py-px rounded font-mono text-micro uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
              new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-data font-mono">
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
            className="w-full h-9 pl-8 pr-8 rounded-lg bg-surface-1/60 border border-border-subtle text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
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
        {/* "MEMORIES · 497" here used to sit under an Overview tile "Memories
            1,672": same noun, different population. This is the shown count
            (recent sample minus locally hidden rows), after search and filter. */}
        <div className="ml-auto text-eyebrow uppercase tracking-wider text-muted-foreground" data-testid="memories-tab-caption">
          Showing <span className="text-foreground tabular-nums">{memories.length}</span>
          {memories.length !== totalCount && <> of <span className="text-foreground tabular-nums">{totalCount}</span></>}
          {" "}in sample
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-thin edge-fade-x -mx-1 px-1">
        {MEMORY_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 px-2.5 py-1 rounded-full text-eyebrow uppercase tracking-wider font-mono border transition-colors",
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
        "glass-card rounded-lg p-3 border transition-colors flex flex-col gap-2",
        suppressed && "opacity-50",
        isNew
          ? "border-primary/40 shadow-[0_0_18px_-8px_hsl(var(--primary)/0.6)]"
          : "border-border-subtle hover:border-primary/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-px rounded border border-border-subtle font-mono text-micro uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span
              className="text-data font-mono tabular-nums"
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
              className="px-1.5 py-0.5 rounded-full bg-white/5 border border-border-subtle text-data text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
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
        <div className="text-eyebrow font-mono uppercase tracking-wider text-muted-foreground">
          PATTERNS · <span className="text-foreground tabular-nums">{patterns.length}</span>
        </div>
        <div className="ml-auto inline-flex items-center gap-0.5 rounded-lg bg-surface-1/60 border border-border-subtle p-0.5">
          {PATTERN_SORTS.map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn(
                "px-2 py-1 rounded text-eyebrow uppercase tracking-wider font-mono transition-colors",
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

      <div className="flex gap-1.5 overflow-x-auto scrollbar-thin edge-fade-x -mx-1 px-1">
        {PATTERN_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 px-2.5 py-1 rounded-full text-eyebrow uppercase tracking-wider font-mono border transition-colors",
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
          <span className="px-1.5 py-px rounded border border-border-subtle font-mono text-micro uppercase tracking-wider text-muted-foreground">
            {typeLabel}
          </span>
          {m.confidence != null && (
            <span
              className="text-data font-mono tabular-nums"
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
            <span className="flex items-center gap-0.5 text-data font-mono text-primary">
              <Zap className="w-2.5 h-2.5" strokeWidth={1.75} />{m.hit_count}
            </span>
          )}
          {suppressed && (
            <span className="px-1 py-px rounded font-mono text-micro uppercase tracking-wider bg-muted/30 text-muted-foreground border border-border-subtle">
              suppressed
            </span>
          )}
          {promoted && !suppressed && (
            <span className="px-1 py-px rounded font-mono text-micro uppercase tracking-wider bg-primary/15 text-primary border border-primary/30">
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
          <span className="text-eyebrow uppercase tracking-wider font-mono text-muted-foreground">Cases:</span>
          <button
            onClick={onOpenCase}
            className="px-1.5 py-0.5 rounded-full bg-white/5 border border-border-subtle text-data text-muted-foreground hover:text-foreground hover:border-primary/30 truncate max-w-[200px]"
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
            "inline-flex items-center gap-1 px-2 py-1 rounded text-eyebrow uppercase tracking-wider font-mono transition-colors hover:bg-white/5",
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
            "inline-flex items-center gap-1 px-2 py-1 rounded text-eyebrow uppercase tracking-wider font-mono transition-colors hover:bg-white/5",
            suppressed ? "text-primary" : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <EyeOff className="w-3 h-3" strokeWidth={1.75} />
          {suppressed ? "Unmute" : "Mute locally"}
        </button>
        <button
          onClick={onDelete}
          title="Hide in your local view — no audited deletion"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-eyebrow uppercase tracking-wider font-mono text-muted-foreground/70 hover:text-foreground hover:bg-white/5"
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

type ReviewSummary = { confirmed: number; key: number; recheck: number; dismissed: number };

function reliabilityColor(p: number | null): string {
  if (p === null) return "hsl(var(--muted-foreground))";
  if (p >= 70) return "hsl(var(--brain-status-ok))";
  if (p >= 40) return "hsl(var(--brain-status-warn))";
  return "hsl(var(--brain-status-bad))";
}

export function SourcesTab() {
  const { user } = useAuth();
  const observations = useToolObservations(user?.id);
  const [rows, setRows] = useState<SourceReliability[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [reviews, setReviews] = useState<ReviewSummary>({ confirmed: 0, key: 0, recheck: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      setLoading(true);
      // Same definition as the tool_health view: outcome over real attempts, live calls,
      // last 30 days. Newest first, so a row cap can only ever drop the oldest.
      const [{ data: logs }, { data: revs }] = await Promise.all([
        supabase
          .from("tool_usage_log")
          .select("tool_name, outcome, cached, created_at")
          .eq("user_id", user.id)
          .eq("cached", false)
          .gte("created_at", windowStartIso(Date.now()))
          .in("tool_name", SOURCE_TOOLS)
          .order("created_at", { ascending: false })
          .limit(SOURCE_RELIABILITY_ROW_LIMIT),
        supabase.from("artifact_reviews").select("state").eq("user_id", user.id),
      ]);
      if (!alive) return;
      // `outcome` is live in the table but missing from the generated types (same cast as useThreadToolHealth).
      const logRows = (logs as unknown as SourceLogRow[] | null) ?? [];
      setTruncated(logRows.length >= SOURCE_RELIABILITY_ROW_LIMIT);
      const computed = summarizeSourceReliability(logRows, SOURCE_TOOLS);
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
        Reliability is successes ÷ real attempts (succeeded + failed) over the last 30 days, live calls only.
        Skipped and no-record calls are not counted either way. The arrow compares the last 14 days with the 16 before.
        Review totals summarize your saved case decisions.
        {truncated && " Showing the most recent calls only."}
      </p>

      <div className="flex gap-2 flex-wrap">
        <FeedbackChip label="CONFIRMED" value={reviews.confirmed} tone="hsl(var(--brain-status-ok))" />
        <FeedbackChip label="KEY FINDINGS" value={reviews.key} tone="hsl(var(--primary))" />
        <FeedbackChip label="NEEDS RECHECK" value={reviews.recheck} tone="hsl(var(--brain-status-warn))" />
        <FeedbackChip label="DISMISSED" value={reviews.dismissed} tone="hsl(var(--brain-status-bad))" />
      </div>

      <ToolObservationsPanel state={observations} />

      <div className="rounded-xl border border-border-subtle bg-surface-1/40 overflow-hidden">
        <div className="px-3 py-2 border-b border-border-subtle/60 flex items-center">
          <span className="text-eyebrow font-mono uppercase tracking-wider text-muted-foreground">
            SOURCE WEIGHTS · <span className="text-foreground tabular-nums">{rows.length}</span>
          </span>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Computing source reliability…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No source activity yet — run an investigation to see tool outcomes here.</div>
        ) : (
          <div className="divide-y divide-border-subtle/40">
            {rows.map((r) => <SourceWeightRow key={r.tool} row={r} />)}
          </div>
        )}
      </div>

      <SavedContextExplainer />
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
      <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-data text-muted-foreground">·</span>
      <span className="text-data font-mono tabular-nums" style={{ color: tone }}>{value}</span>
    </div>
  );
}

function SourceWeightRow({ row }: { row: SourceReliability }) {
  const tone = reliabilityColor(row.reliability);
  const hasDelta = row.delta !== 0;
  const deltaUp = row.delta > 0;
  return (
    <div className="px-3 py-2.5 flex items-center gap-3" title={describeSourceReliability(row)}>
      <div className="font-mono text-xs text-foreground min-w-0 w-44 truncate">{row.tool}</div>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full transition-[width] duration-slow ease-standard"
            style={{ width: `${Math.max(2, row.reliability ?? 0)}%`, background: tone }}
          />
        </div>
      </div>
      <div className="font-mono text-data tabular-nums w-10 text-right" style={{ color: tone }}>
        {row.reliability === null ? "—" : `${row.reliability}%`}
      </div>
      <div className="w-12 text-right">
        {hasDelta ? (
          <span
            className="font-mono text-data tabular-nums"
            style={{ color: deltaUp ? "hsl(var(--brain-status-ok))" : "hsl(var(--brain-status-bad))" }}
          >
            {deltaUp ? "+" : ""}{row.delta} {deltaUp ? "↑" : "↓"}
          </span>
        ) : (
          <span className="font-mono text-data text-muted-foreground/60">—</span>
        )}
      </div>
      <span className="px-1.5 py-0.5 rounded border border-border-subtle font-mono text-data text-muted-foreground tabular-nums shrink-0">
        {row.attempts === 0 ? "no attempts" : `${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"}`}
      </span>
    </div>
  );
}

function SavedContextExplainer() {
  const Step = ({ Icon, label, sub }: { Icon: typeof Wrench; label: string; sub: string }) => (
    <div className="flex flex-col items-center gap-2 min-w-0 w-24 shrink-0">
      <div className="w-12 h-12 rounded-full grid place-items-center border border-border-subtle bg-surface-1">
        <Icon className="w-5 h-5 text-primary" strokeWidth={1.5} />
      </div>
      <div className="text-eyebrow font-mono uppercase tracking-wider text-foreground">{label}</div>
      <div className="text-data text-muted-foreground text-center leading-tight">{sub}</div>
    </div>
  );
  return (
    <div
      className="rounded-xl p-5"
      style={{ background: "hsl(var(--brain-card))", border: "1px solid hsl(var(--brain-border))" }}
    >
      <div className="text-eyebrow font-mono uppercase tracking-wider text-muted-foreground mb-4">
        What this page shows
      </div>
      <div className="flex items-start justify-center gap-2 sm:gap-4">
        <Step Icon={Wrench} label="Tools" sub="return findings" />
        <ArrowRight className="w-4 h-4 mt-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
        <Step Icon={UserCheck} label="Reviews" sub="save decisions" />
        <ArrowRight className="w-4 h-4 mt-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
        <Step Icon={Brain} label="Brain" sub="shows saved context" />
      </div>
    </div>
  );
}

// ============================================================
// Credits sub-tab
// ============================================================

export const SOCIALFETCH_CAP = 10000;

function CreditsTab({ onOpenCase }: { onOpenCase: (threadId: string) => void }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [socialUsed, setSocialUsed] = useState(0);
  const [socialLastUsed, setSocialLastUsed] = useState<string | null>(null);
  const [allTimeUsd, setAllTimeUsd] = useState(0);
  const [caseCount, setCaseCount] = useState(0);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [account, setAccount] = useState<CreditAccount>({ kind: "unavailable" });
  const economics = useRunEconomics(user?.id);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      setLoading(true);
      // SocialFetch is counted exactly (head count) and only for its own tool, so a large
      // log of other tools can no longer push its calls out of a row-capped read.
      const [sfCount, sfLast, { data: threads }, { data: creditRow }] = await Promise.all([
        supabase.from("tool_usage_log").select("id", { count: "exact", head: true })
          .eq("user_id", user.id).eq("tool_name", "socialfetch_lookup"),
        supabase.from("tool_usage_log").select("created_at")
          .eq("user_id", user.id).eq("tool_name", "socialfetch_lookup")
          .order("created_at", { ascending: false }).limit(1),
        supabase.from("threads").select("id, title, cost_micro_usd, updated_at")
          .eq("user_id", user.id).order("updated_at", { ascending: false }).limit(500),
        supabase.from("user_credits")
          .select("balance_micro_usd,spent_micro_usd,daily_spent_micro_usd,daily_window_start,unlimited,blocked")
          .eq("user_id", user.id).maybeSingle(),
      ]);
      if (!alive) return;

      setSocialUsed(sfCount.count ?? 0);
      setSocialLastUsed((sfLast.data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null);
      setAccount(describeCreditAccount(creditRow));

      const threadRows = (threads ?? []) as Array<{ id: string; title: string; cost_micro_usd: number }>;
      setTitles(new Map(threadRows.map((t) => [t.id, t.title])));
      // Per-case meter totals. These include runs from before per-run telemetry existed, so
      // they are labelled "all time" and are not expected to equal the 30-day figure.
      setAllTimeUsd(threadRows.reduce((sum, t) => sum + (Number(t.cost_micro_usd) || 0), 0) / 1_000_000);
      setCaseCount(threadRows.filter((t) => (Number(t.cost_micro_usd) || 0) > 0).length);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user]);

  const sfLeft = Math.max(0, SOCIALFETCH_CAP - socialUsed);
  const sfPct = Math.min(100, (socialUsed / SOCIALFETCH_CAP) * 100);
  // The newest run, even if its cost was never recorded: formatUsd then shows an em dash.
  const lastRun = latestRun(economics.recent);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Account card — what the account can spend, said plainly for each account kind. */}
        <div className="rounded-xl p-5 bg-brain-card border border-brain-border" data-testid="credit-account">
          <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider font-mono text-muted-foreground mb-3">
            <CreditCard className="w-3.5 h-3.5" strokeWidth={1.5} />
            Account
          </div>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : account.kind === "unlimited" ? (
            <>
              <div className="stat-figure font-display text-2xl font-semibold">Unlimited</div>
              <div className="text-xs text-muted-foreground mt-1 leading-snug">
                This account is never debited, so there is no balance to run down. Spend is read from the per-run
                meter below.
              </div>
            </>
          ) : account.kind === "beta" ? (
            <>
              <div className="flex items-baseline gap-2">
                <div className="stat-figure font-display text-3xl font-semibold">{formatUsd(account.balanceUsd)}</div>
                <div className="text-xs text-muted-foreground">{account.depleted ? "balance used up" : "balance left"}</div>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {formatUsd(account.spentUsd)} spent in total · {formatUsd(account.todayUsd)} today
              </div>
            </>
          ) : account.kind === "blocked" ? (
            <div className="text-sm text-muted-foreground">This account is blocked from running investigations.</div>
          ) : (
            <div className="text-sm text-muted-foreground">Account balance could not be read.</div>
          )}
        </div>

        {/* SocialFetch Credits card */}
        <div className="rounded-xl p-5 bg-brain-card border border-brain-border">
          <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider font-mono text-muted-foreground mb-3">
            <CreditCard className="w-3.5 h-3.5" strokeWidth={1.5} />
            SocialFetch Credits
          </div>
          <div className="flex items-baseline gap-2">
            <div className="stat-figure font-display text-3xl font-semibold">
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
          <div className="text-data text-muted-foreground mt-3 font-mono">
            Last used: {timeAgo(socialLastUsed)}
          </div>
        </div>

        {/* Spend card — all-time per-case meter, with the last 14 days drawn from per-run data. */}
        <div className="rounded-xl p-5 bg-brain-card border border-brain-border" data-testid="spend-card">
          <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider font-mono text-muted-foreground mb-3">
            <BarChart3 className="w-3.5 h-3.5" strokeWidth={1.5} />
            Spend · all time
          </div>
          <div className="flex items-baseline gap-2">
            <div className="stat-figure font-display text-3xl font-semibold">{formatUsd(allTimeUsd)}</div>
            <div className="text-xs text-muted-foreground">across {caseCount} {caseCount === 1 ? "case" : "cases"}</div>
          </div>
          <div className="mt-4">
            <Sparkline data={economics.daily} />
          </div>
          <div className="text-data text-muted-foreground mt-3 font-mono">
            per day, last 14 days · {formatUsd(lastRun?.credits_micro_usd == null ? null : lastRun.credits_micro_usd / 1_000_000)} last run
          </div>
        </div>
      </div>

      <RunEconomicsPanel state={economics} titles={titles} onOpenCase={onOpenCase} />
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
