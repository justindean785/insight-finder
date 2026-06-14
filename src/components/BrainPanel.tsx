import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Brain, Sparkles, Activity, ThumbsUp, ThumbsDown, Lightbulb, Network, Star, TrendingUp, CheckCircle2, XCircle, Zap, Gauge, Phone, AtSign, Mail, MapPin, ShieldAlert, Globe, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";

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
};

type SourceStat = { source: string; total: number; confirmed: number; dismissed: number };

const SOCIALFETCH_QUOTA = 10_000;

/** Classify a memory into a coarse "pattern type" for chip filtering. */
type PatternType = "phone" | "username" | "email" | "geo" | "breach" | "other";
const PATTERN_TYPES: { id: PatternType; label: string; icon: typeof Phone }[] = [
  { id: "phone", label: "Phone", icon: Phone },
  { id: "username", label: "Username", icon: AtSign },
  { id: "email", label: "Email", icon: Mail },
  { id: "geo", label: "Geo", icon: MapPin },
  { id: "breach", label: "Breach", icon: ShieldAlert },
  { id: "other", label: "Other", icon: Globe },
];
function classifyPattern(m: Memory): PatternType {
  const hay = `${m.subject_kind ?? ""} ${m.subject} ${m.content}`.toLowerCase();
  if (/phone|\+\d|country code|sms/.test(hay)) return "phone";
  if (/username|handle|reused|alias/.test(hay)) return "username";
  if (/email|@|mx |smtp/.test(hay)) return "email";
  if (/location|geo|city|country|coords|address/.test(hay)) return "geo";
  if (/breach|leak|credential|password|hibp/.test(hay)) return "breach";
  return "other";
}
function severityOf(m: Memory): "high" | "mid" | "low" {
  const c = m.confidence ?? 0;
  if (c >= 75) return "high";
  if (c >= 50) return "mid";
  return "low";
}

const KIND_META: Record<string, { label: string; icon: typeof Lightbulb; color: string }> = {
  pattern: { label: "Patterns", icon: TrendingUp, color: "text-primary" },
  lesson: { label: "Lessons", icon: Lightbulb, color: "text-[hsl(var(--confidence-mid))]" },
  identity: { label: "Identities", icon: Star, color: "text-primary" },
  connection: { label: "Connections", icon: Network, color: "text-accent" },
};


export function BrainPanel({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [sources, setSources] = useState<SourceStat[]>([]);
  const [reviewCounts, setReviewCounts] = useState({ confirmed: 0, key: 0, dismissed: 0, recheck: 0 });
  const [socialfetchUsed, setSocialfetchUsed] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const [{ data: mem }, { data: arts }, { data: revs }, { count: sfCount }] = await Promise.all([
        supabase
          .from("agent_memory")
          .select("id,kind,subject,subject_kind,content,related_values,confidence,hit_count,last_used_at,created_at")
          .order("hit_count", { ascending: false })
          .order("last_used_at", { ascending: false, nullsFirst: false })
          .limit(500),
        supabase.from("artifacts").select("id,source").limit(2000),
        supabase.from("artifact_reviews").select("artifact_id,state").limit(2000),
        supabase
          .from("tool_usage_log")
          .select("id", { count: "exact", head: true })
          .eq("tool_name", "socialfetch_lookup")
          .eq("ok", true)
          .eq("cached", false),
      ]);
      if (!alive) return;

      setSocialfetchUsed(sfCount ?? 0);

      setMemories((mem as Memory[] | null) ?? []);

      // Build source stats with confirmed/dismissed weighting
      const reviewByArt = new Map<string, string>();
      const rc = { confirmed: 0, key: 0, dismissed: 0, recheck: 0 };
      for (const r of (revs ?? []) as { artifact_id: string; state: string }[]) {
        reviewByArt.set(r.artifact_id, r.state);
        if (r.state in rc) (rc as Record<string, number>)[r.state]++;
      }
      setReviewCounts(rc);

      const agg = new Map<string, SourceStat>();
      for (const a of (arts ?? []) as { id: string; source: string | null }[]) {
        if (!a.source) continue;
        const cur = agg.get(a.source) ?? { source: a.source, total: 0, confirmed: 0, dismissed: 0 };
        cur.total++;
        const rv = reviewByArt.get(a.id);
        if (rv === "confirmed" || rv === "key") cur.confirmed++;
        if (rv === "dismissed") cur.dismissed++;
        agg.set(a.source, cur);
      }
      setSources(Array.from(agg.values()).sort((a, b) => b.total - a.total));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [open]);

  const grouped = useMemo(() => {
    const g: Record<string, Memory[]> = {};
    for (const m of memories) (g[m.kind] ??= []).push(m);
    return g;
  }, [memories]);

  const totalHits = memories.reduce((s, m) => s + (m.hit_count || 0), 0);
  const avgConf = memories.length
    ? Math.round(memories.reduce((s, m) => s + (m.confidence ?? 0), 0) / memories.length)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[88vh] p-0 overflow-hidden bg-[hsl(230_14%_4%)] border-border-subtle">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border-subtle bg-gradient-to-b from-primary/5 to-transparent">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl glass-strong grid place-items-center ring-1 ring-primary/40 shadow-[0_0_24px_-6px_hsl(var(--primary)/0.7)]">
                <Brain className="w-5 h-5 text-primary" />
              </div>
              <Sparkles className="absolute -top-1 -right-1 w-3 h-3 text-primary animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-display tracking-tight">
                Agent Brain · Learning Log
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Patterns, lessons and source weighting the agent has accumulated across investigations.
              </DialogDescription>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
            <Stat icon={Brain} label="Memories" value={memories.length} />
            <Stat icon={Zap} label="Recalls" value={totalHits} />
            <Stat icon={CheckCircle2} label="Avg confidence" value={`${avgConf}%`} />
            <Stat icon={ThumbsUp} label="User confirmed" value={reviewCounts.confirmed + reviewCounts.key} />
          </div>

          <SocialFetchQuotaBar used={socialfetchUsed} total={SOCIALFETCH_QUOTA} />
        </DialogHeader>

        <Tabs defaultValue="memories" className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-6 mt-3 bg-transparent border border-border-subtle rounded-lg p-1 grid grid-cols-4 h-9">
            <TabsTrigger value="memories" className="text-xs h-7 data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Memories</TabsTrigger>
            <TabsTrigger value="patterns" className="text-xs h-7 data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Patterns</TabsTrigger>
            <TabsTrigger value="sources" className="text-xs h-7 data-[state=active]:bg-primary/15 data-[state=active]:text-primary">API sources</TabsTrigger>
            <TabsTrigger value="feedback" className="text-xs h-7 data-[state=active]:bg-primary/15 data-[state=active]:text-primary">Feedback</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto px-6 py-4 max-h-[60vh]">
            {loading ? (
              <div className="text-center text-xs text-muted-foreground py-12">Loading brain state…</div>
            ) : (
              <>
                <TabsContent value="memories" className="m-0 space-y-4">
                  {memories.length === 0 ? (
                    <EmptyState text="No memories yet. As you run investigations and mark findings, the agent will record patterns and lessons here." />
                  ) : (
                    Object.entries(grouped).map(([kind, list]) => {
                      const meta = KIND_META[kind] ?? { label: kind, icon: Lightbulb, color: "text-muted-foreground" };
                      const Icon = meta.icon;
                      return (
                        <div key={kind}>
                          <div className="flex items-center gap-2 mb-2">
                            <Icon className={cn("w-3.5 h-3.5", meta.color)} />
                            <span className="text-eyebrow uppercase tracking-[0.12em] font-semibold text-muted-foreground">{meta.label}</span>
                            <span className="text-data font-mono opacity-60">{list.length}</span>
                          </div>
                          <div className="space-y-2">
                            {list.slice(0, 30).map((m) => (
                              <MemoryCard key={m.id} m={m} />
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </TabsContent>

                <TabsContent value="patterns" className="m-0 space-y-2">
                  <PatternsView memories={[...(grouped.pattern ?? []), ...(grouped.lesson ?? [])]} />
                </TabsContent>

                <TabsContent value="sources" className="m-0">
                  {sources.length === 0 ? (
                    <EmptyState text="No source data yet." />
                  ) : (
                    <div className="space-y-1.5">
                      {sources.map((s) => {
                        const max = sources[0]?.total || 1;
                        const pct = (s.total / max) * 100;
                        const score = s.confirmed - s.dismissed;
                        return (
                          <div key={s.source} className="glass-card rounded-lg px-3 py-2.5 border border-border-subtle">
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="font-mono text-xs text-foreground truncate">{s.source}</span>
                              <div className="flex items-center gap-2 text-data font-mono shrink-0">
                                {s.confirmed > 0 && (
                                  <span className="flex items-center gap-0.5 text-[hsl(var(--confidence-high))]">
                                    <ThumbsUp className="w-2.5 h-2.5" />{s.confirmed}
                                  </span>
                                )}
                                {s.dismissed > 0 && (
                                  <span className="flex items-center gap-0.5 text-destructive">
                                    <ThumbsDown className="w-2.5 h-2.5" />{s.dismissed}
                                  </span>
                                )}
                                <span className="text-muted-foreground">{s.total} hits</span>
                                <span
                                  className={cn(
                                    "px-1.5 py-0.5 rounded border text-[9px]",
                                    score > 0 && "border-[hsl(var(--confidence-high))]/40 text-[hsl(var(--confidence-high))] bg-[hsl(var(--confidence-high))]/10",
                                    score === 0 && "border-border-subtle text-muted-foreground",
                                    score < 0 && "border-destructive/40 text-destructive bg-destructive/10",
                                  )}
                                >
                                  {score > 0 ? `+${score}` : score}
                                </span>
                              </div>
                            </div>
                            <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-primary to-accent"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="feedback" className="m-0 space-y-3">
                  <FeedbackView reviewCounts={reviewCounts} sources={sources} />
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Brain; label: string; value: string | number }) {
  return (
    <div className="glass-card rounded-lg px-3 py-2 border border-border-subtle">
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="font-mono text-lg text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function MemoryCard({ m }: { m: Memory }) {
  const meta = KIND_META[m.kind] ?? { label: m.kind, icon: Lightbulb, color: "text-muted-foreground" };
  const Icon = meta.icon;
  return (
    <div className="glass-card rounded-lg p-3 border border-border-subtle hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={cn("w-3 h-3 shrink-0", meta.color)} />
          <span className="text-eyebrow uppercase tracking-wider text-muted-foreground">{meta.label}</span>
          {m.subject_kind && (
            <span className="px-1 py-px rounded border border-border-subtle font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              {m.subject_kind}
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
              <Zap className="w-2.5 h-2.5" />{m.hit_count}
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

function PatternsView({ memories }: { memories: Memory[] }) {
  const [filters, setFilters] = useState<Set<PatternType>>(new Set());
  const tagged = useMemo(
    () => memories
      .map((m) => ({ m, type: classifyPattern(m), sev: severityOf(m) }))
      .sort((a, b) => (b.m.hit_count || 0) - (a.m.hit_count || 0)),
    [memories],
  );
  const counts = useMemo(() => {
    const c: Record<PatternType, number> = { phone: 0, username: 0, email: 0, geo: 0, breach: 0, other: 0 };
    tagged.forEach((t) => { c[t.type]++; });
    return c;
  }, [tagged]);
  const visible = filters.size === 0 ? tagged : tagged.filter((t) => filters.has(t.type));

  if (memories.length === 0) {
    return <EmptyState text="No patterns learned yet. Example: if a phone search misses without +1 country code, the agent will record that as a pattern." />;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="chip-group-label">Filter</span>
        {PATTERN_TYPES.map(({ id, label, icon: Ico }) => {
          const active = filters.has(id);
          return (
            <button
              key={id}
              type="button"
              className="pattern-chip"
              data-active={active}
              onClick={() => {
                const next = new Set(filters);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setFilters(next);
              }}
            >
              <Ico className="w-3 h-3" />
              {label}
              <span className="opacity-60">{counts[id]}</span>
            </button>
          );
        })}
        {filters.size > 0 && (
          <button
            type="button"
            className="text-eyebrow uppercase tracking-wider text-muted-foreground hover:text-foreground ml-1"
            onClick={() => setFilters(new Set())}
          >clear</button>
        )}
      </div>
      <div className="space-y-2">
        {visible.map(({ m, type, sev }) => (
          <PatternCard key={m.id} m={m} type={type} sev={sev} />
        ))}
        {visible.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">No patterns match the active filters.</div>
        )}
      </div>
    </div>
  );
}

function PatternCard({ m, type, sev }: { m: Memory; type: PatternType; sev: "high" | "mid" | "low" }) {
  const typeMeta = PATTERN_TYPES.find((t) => t.id === type)!;
  const TypeIcon = typeMeta.icon;
  const sevClass =
    sev === "high" ? "evidence-tile--highconf" :
    sev === "mid" ? "evidence-tile--active" :
    "";
  const sevLabel = sev === "high" ? "High" : sev === "mid" ? "Mid" : "Low";
  const sevColor =
    sev === "high" ? "text-[hsl(var(--confidence-high))]" :
    sev === "mid" ? "text-[hsl(var(--confidence-mid))]" :
    "text-[hsl(var(--confidence-low))]";
  return (
    <div className={cn("evidence-tile neuron-frame p-3", sevClass)}>
      <div className="relative flex items-center justify-between gap-2 mb-2 pb-2 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn(
            "inline-grid place-items-center w-6 h-6 rounded-md border",
            "border-border-subtle bg-surface-1",
          )}>
            <TypeIcon className="w-3 h-3 text-primary" />
          </span>
          <span className="font-mono text-eyebrow uppercase tracking-[0.14em] text-foreground/90">{typeMeta.label}</span>
          {m.subject_kind && (
            <span className="px-1 py-px rounded border border-border-subtle font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              {m.subject_kind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-data font-mono">
          <span className={cn("px-1.5 py-0.5 rounded border tracking-wider uppercase", sevColor,
            sev === "high" && "border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
            sev === "mid"  && "border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
            sev === "low"  && "border-[hsl(var(--confidence-low))]/40 bg-[hsl(var(--confidence-low))]/10",
          )}>
            {sevLabel} · {m.confidence ?? 0}%
          </span>
          <span className="flex items-center gap-0.5 text-primary" title="Recalls">
            <Zap className="w-2.5 h-2.5" />{m.hit_count}
          </span>
          <span className="text-muted-foreground" title="Last seen">{timeAgo(m.last_used_at ?? m.created_at)}</span>
        </div>
      </div>
      <div className="relative text-xs text-foreground leading-relaxed [overflow-wrap:anywhere]">{m.content}</div>
      {m.related_values && m.related_values.length > 0 && (
        <div className="relative flex items-center gap-1 mt-2 flex-wrap">
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

function FeedbackCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Brain; tone: "good" | "bad" | "warn" }) {
  const toneClass =
    tone === "good" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/30" :
    tone === "bad" ? "text-destructive border-destructive/30" :
    "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/30";
  return (
    <div className={cn("glass-card rounded-lg p-3 border", toneClass)}>
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="font-mono text-2xl tabular-nums mt-1">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-center py-12 px-6">
      <Brain className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
      <div className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">{text}</div>
    </div>
  );
}

function SocialFetchQuotaBar({ used, total }: { used: number; total: number }) {
  const remaining = Math.max(0, total - used);
  const pct = Math.min(100, (used / total) * 100);
  const low = remaining < total * 0.15;
  return (
    <div className="mt-3 glass-card rounded-lg px-3 py-2.5 border border-border-subtle">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider text-muted-foreground">
          <Gauge className="w-3 h-3" />
          SocialFetch credits
        </div>
        <div className="flex items-center gap-2 text-data font-mono">
          <span className="text-muted-foreground">{used.toLocaleString()} used</span>
          <span className="opacity-40">·</span>
          <span className={cn("tabular-nums", low ? "text-destructive" : "text-primary")}>
            {remaining.toLocaleString()} left
          </span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            low ? "bg-gradient-to-r from-destructive to-destructive/70" : "bg-gradient-to-r from-primary to-accent"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FeedbackView({
  reviewCounts, sources,
}: {
  reviewCounts: { confirmed: number; key: number; dismissed: number; recheck: number };
  sources: SourceStat[];
}) {
  // Weight score = confirmed - dismissed; rank for the bar chart.
  const weighted = useMemo(() => sources
    .map((s) => ({ ...s, score: s.confirmed - s.dismissed }))
    .sort((a, b) => b.score - a.score || b.total - a.total)
    .slice(0, 8),
  [sources]);
  const maxAbs = Math.max(1, ...weighted.map((s) => Math.abs(s.score)));
  const total = reviewCounts.confirmed + reviewCounts.key + reviewCounts.recheck + reviewCounts.dismissed;

  return (
    <div className="space-y-4">
      {/* Status counter strip */}
      <div className="grid grid-cols-4 gap-2">
        <FeedbackCard label="Confirmed" value={reviewCounts.confirmed} icon={CheckCircle2} tone="good" />
        <FeedbackCard label="Key" value={reviewCounts.key} icon={Star} tone="good" />
        <FeedbackCard label="Recheck" value={reviewCounts.recheck} icon={Activity} tone="warn" />
        <FeedbackCard label="Dismissed" value={reviewCounts.dismissed} icon={XCircle} tone="bad" />
      </div>

      {/* Source weighting bar chart */}
      <div className="evidence-tile p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="label-eyebrow flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3 text-primary" />
            Source weighting
          </div>
          <span className="text-data font-mono text-muted-foreground">
            {total} marks · {sources.length} sources
          </span>
        </div>
        {weighted.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No source data yet — confirm or dismiss artifacts to build weights.
          </div>
        ) : (
          <div className="space-y-2">
            {weighted.map((s) => {
              const pos = s.score > 0;
              const neg = s.score < 0;
              const widthPct = (Math.abs(s.score) / maxAbs) * 50; // half-axis
              return (
                <div key={s.source} className="grid grid-cols-[110px_1fr_72px] items-center gap-2 text-data">
                  <span className="font-mono text-foreground/90 truncate" title={s.source}>{s.source}</span>
                  <div className="relative h-3 rounded-sm bg-white/[0.04] border border-border-subtle overflow-hidden">
                    {/* center axis */}
                    <span className="absolute left-1/2 top-0 bottom-0 w-px bg-border-strong/60" />
                    {pos && (
                      <span
                        className="absolute top-0 bottom-0 left-1/2 bg-[hsl(var(--confidence-high))]/70"
                        style={{ width: `${widthPct}%` }}
                      />
                    )}
                    {neg && (
                      <span
                        className="absolute top-0 bottom-0 bg-[hsl(var(--danger))]/70"
                        style={{ right: "50%", width: `${widthPct}%` }}
                      />
                    )}
                  </div>
                  <span className={cn(
                    "font-mono text-right tabular-nums",
                    pos && "text-[hsl(var(--confidence-high))]",
                    neg && "text-[hsl(var(--danger))]",
                    !pos && !neg && "text-muted-foreground",
                  )}>
                    {s.score > 0 ? `+${s.score}` : s.score} · {s.total}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Learning loop diagram */}
      <div className="evidence-tile p-4">
        <div className="label-eyebrow flex items-center gap-1.5 mb-3">
          <Sparkles className="w-3 h-3 text-primary" />
          Learning loop
        </div>
        <div className="flex items-center justify-between gap-2">
          <LoopNode icon={Wrench} label="Tools" sub="Run & return" tone="info" />
          <LoopArrow />
          <LoopNode icon={ThumbsUp} label="You" sub="Confirm or dismiss" tone="good" />
          <LoopArrow />
          <LoopNode icon={Brain} label="Agent" sub="Reweight sources" tone="brand" />
        </div>
        <div className="mt-3 text-data text-muted-foreground leading-relaxed">
          Every mark shifts source weight. Repeated misses become patterns — the next run skips the failing format.
        </div>
      </div>
    </div>
  );
}

function LoopNode({
  icon: Icon, label, sub, tone,
}: { icon: typeof Brain; label: string; sub: string; tone: "info" | "good" | "brand" }) {
  const toneCls =
    tone === "good" ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 shadow-[0_0_18px_-6px_hsl(var(--confidence-high)/0.6)]"
    : tone === "info" ? "text-[hsl(var(--info))] border-[hsl(var(--info))]/40 shadow-[0_0_18px_-6px_hsl(var(--info)/0.6)]"
    : "text-primary border-primary/40 shadow-[0_0_18px_-6px_hsl(var(--primary)/0.6)]";
  return (
    <div className="flex-1 flex flex-col items-center text-center min-w-0">
      <div className={cn("w-12 h-12 rounded-full grid place-items-center border-2 bg-surface-1", toneCls)}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="mt-2 text-eyebrow font-semibold uppercase tracking-wider text-foreground">{label}</div>
      <div className="text-data text-muted-foreground">{sub}</div>
    </div>
  );
}

function LoopArrow() {
  return (
    <div className="flex-shrink-0 flex flex-col items-center pt-[18px] text-muted-foreground">
      <svg width="38" height="14" viewBox="0 0 38 14" fill="none" aria-hidden>
        <path d="M2 7 H32" stroke="hsl(var(--border-strong))" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d="M28 2 L34 7 L28 12" stroke="hsl(var(--primary))" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}