import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Mail, Phone, Globe, User as UserIcon, Network, ShieldAlert, MapPin, Image as ImgIcon, Tag,
  Copy, CheckCircle2, XCircle, PanelRightOpen, PanelRightClose, Star, ShieldQuestion, EyeOff,
  Database, BarChart3, Lock, FileOutput,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { ConfidenceExplain } from "@/components/ConfidenceExplain";
import { SourceBadge } from "@/components/SourceBadge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useThreadArtifacts, type Artifact } from "@/hooks/useThreadArtifacts";
import {
  groupForKind, GROUP_LABEL, GROUP_ORDER, type Group,
  extractSourceInfo, CACHE_LAYER_LABEL, CACHE_LAYER_CLASS,
} from "@/lib/intel";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_SHORT,
  type ReviewState,
} from "@/lib/review";
import { OverviewTab } from "./panel/OverviewTab";
import { EvidenceMatrixTab } from "./panel/EvidenceMatrixTab";
import { PivotsTab } from "./panel/PivotsTab";
import { ReportTab } from "./panel/ReportTab";
import { TimelineTab } from "./panel/TimelineTab";
import { MapTab } from "./panel/MapTab";
import { CustodyTab } from "./panel/CustodyTab";
import { AuditTab } from "./panel/AuditTab";
import { FailedSkippedTab } from "./panel/FailedSkippedTab";
import { ClustersTab } from "./panel/ClustersTab";
import { NotesTab } from "./panel/NotesTab";
import { StreakIndicator } from "./StreakIndicator";
import { DensityToggle } from "./DensityToggle";

/**
 * Compact a long seed (typically a signed URL) into a host + filename
 * representation so the case header stays one calm line instead of a
 * 200-char truncated blob with random query-string fragments.
 */
function compactSeed(raw: string | null | undefined): { display: string; isUrl: boolean } {
  if (!raw) return { display: "—", isUrl: false };
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    const file = segs[segs.length - 1] ?? "";
    if (file) {
      const short = file.length > 36 ? file.slice(0, 18) + "…" + file.slice(-14) : file;
      return { display: `${u.hostname}/…/${short}`, isUrl: true };
    }
    return { display: u.hostname, isUrl: true };
  } catch {
    return { display: raw, isUrl: false };
  }
}

const GROUP_ICON: Record<Group, React.ComponentType<{ className?: string }>> = {
  identity: Tag,
  contact: Mail,
  social: UserIcon,
  infrastructure: Network,
  breach: ShieldAlert,
  web: Globe,
  crypto: ImgIcon,
  other: Tag,
};

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  email: Mail, phone: Phone, ip: Network, username: UserIcon, domain: Globe,
  avatar: ImgIcon, breach: ShieldAlert, address: MapPin, name: Tag, social: UserIcon,
};

export function ResourcesPanel({
  threadId,
  collapsed,
  onToggleCollapse,
}: {
  threadId: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { items, updateLocal } = useThreadArtifacts(threadId);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const review = useReviewStates(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null } | null>(null);
  const [section, setSection] = useState<"evidence" | "analysis" | "provenance" | "output">("evidence");
  const [tab, setTab] = useState<string>("artifacts");

  const SECTIONS = [
    { key: "evidence" as const, label: "Evidence", icon: Database, tabs: [
      { v: "artifacts", l: "Artifacts" },
      { v: "clusters",  l: "Clusters" },
      { v: "matrix",    l: "Matrix" },
    ] },
    { key: "analysis" as const, label: "Analysis", icon: BarChart3, tabs: [
      { v: "overview", l: "Overview" },
      { v: "pivots",   l: "Pivots" },
      { v: "timeline", l: "Timeline" },
      { v: "map",      l: "Map" },
    ] },
    { key: "provenance" as const, label: "Provenance", icon: Lock, tabs: [
      { v: "custody", l: "Custody" },
      { v: "audit",   l: "Audit" },
      { v: "issues",  l: "Issues" },
    ] },
    { key: "output" as const, label: "Output", icon: FileOutput, tabs: [
      { v: "notes",  l: "Notes" },
      { v: "report", l: "Report" },
    ] },
  ];

  const TAB_COUNTS: Record<string, number | undefined> = {
    artifacts: items.length,
    matrix: items.length,
  };

  const activeSection = SECTIONS.find((s) => s.key === section)!;

  const onSectionChange = (next: typeof section) => {
    setSection(next);
    const first = SECTIONS.find((s) => s.key === next)?.tabs[0]?.v;
    if (first) setTab(first);
  };

  // Command palette / external navigation requests.
  // Dispatch: window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { section, tab } }))
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { section?: typeof section; tab?: string };
      if (detail?.section) setSection(detail.section);
      if (detail?.tab) setTab(detail.tab);
    };
    window.addEventListener("swarmbot:navigate", onNav);
    return () => window.removeEventListener("swarmbot:navigate", onNav);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("threads")
        .select("seed_value,seed_type")
        .eq("id", threadId)
        .maybeSingle();
      if (alive) setSeed(data ? { value: data.seed_value, type: data.seed_type } : null);
    };
    load();
    const ch = supabase
      .channel(`rp-seed-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [threadId]);

  if (collapsed) {
    return (
      <div className="w-14 h-full flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggleCollapse}
          className="w-8 h-8 rounded-md glass-interactive grid place-items-center"
          title="Expand panel"
        >
          <PanelRightOpen className="w-4 h-4 text-muted-foreground" />
        </button>

        <div className="w-8 h-px bg-border-subtle" />

        <div className="text-[10px] text-muted-foreground font-mono">{items.length}</div>

        <div className="flex-1 overflow-y-auto w-full flex flex-col items-center gap-2 px-1">
          {GROUP_ORDER.filter((g) => items.some((a) => groupForKind(a.kind) === g)).map((g) => {
            const Icon = GROUP_ICON[g];
            const count = items.filter((a) => groupForKind(a.kind) === g).length;
            return (
              <button
                key={g}
                onClick={onToggleCollapse}
                className="w-8 h-8 rounded-md flex items-center justify-center glass-interactive relative"
                title={`${GROUP_LABEL[g]} (${count})`}
              >
                <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="absolute -top-0.5 -right-0.5 text-[9px] glass-card text-muted-foreground border border-border-subtle rounded-full w-3.5 h-3.5 flex items-center justify-center font-mono">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full md:w-[430px] h-full flex flex-col">
      <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col min-h-0">
        {/* Header strip — calm, single-row */}
        <div className="sticky top-0 z-10 glass-card border-b border-border-subtle">
          <div className="px-4 h-14 flex items-center gap-3">
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground shrink-0 uppercase">Case</div>
            <button
              onClick={() => {
                if (!seed?.value) return;
                navigator.clipboard.writeText(seed.value).then(
                  () => toast.success("Copied"),
                  () => toast.error("Copy failed"),
                );
              }}
              className="flex-1 min-w-0 group flex items-center gap-1.5 text-left"
              title={seed?.value ?? ""}
            >
              <span className="font-mono text-[13px] tabular-nums text-foreground truncate">
                {compactSeed(seed?.value).display}
              </span>
              {seed?.value && (
                <Copy className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              )}
            </button>
            <span className="px-2 py-0.5 rounded-full border border-border-subtle bg-surface-2 text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
              {items.length}
            </span>
            <StreakIndicator artifacts={items} />
            <DensityToggle className="hidden md:inline-flex" />
            <button
              onClick={onToggleCollapse}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Collapse panel"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
          {/* Section nav — 4 groups */}
          <div className="px-3 pt-2 pb-1.5 flex items-center gap-1 border-t border-border-subtle">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => onSectionChange(s.key)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 h-7 rounded-md text-[10px] font-medium uppercase tracking-[0.1em] transition-colors",
                    active
                      ? "bg-[hsl(var(--brain-cyan))/10] text-[hsl(var(--brain-cyan))] border border-[hsl(var(--brain-cyan))/25]"
                      : "text-muted-foreground hover:text-foreground hover:bg-surface-2 border border-transparent",
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {s.label}
                </button>
              );
            })}
          </div>
          {/* Tabs for active section */}
          <div className="px-3 pb-3 pt-1">
            <TabsList className="w-full h-8 bg-transparent rounded-md p-0 gap-1 justify-start">
              {activeSection.tabs.map((t) => {
                const count = TAB_COUNTS[t.v];
                return (
                  <TabsTrigger
                    key={t.v}
                    value={t.v}
                    className="relative h-8 px-2.5 rounded-md bg-transparent text-[12px] font-medium text-muted-foreground border border-transparent data-[state=active]:bg-surface-3 data-[state=active]:text-foreground data-[state=active]:border-border-subtle data-[state=active]:shadow-none transition-colors"
                  >
                    <span>{t.l}</span>
                    {count != null && count > 0 && (
                      <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                        {count}
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <TabsContent value="overview" className="m-0">
            <OverviewTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="artifacts" className="m-0">
            <ArtifactsList items={items} onSelect={setSelected} threadId={threadId} />
          </TabsContent>
          <TabsContent value="matrix" className="m-0">
            <EvidenceMatrixTab artifacts={items} onLocalUpdate={updateLocal} threadId={threadId} />
          </TabsContent>
          <TabsContent value="clusters" className="m-0">
            <ClustersTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="pivots" className="m-0">
            <PivotsTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="timeline" className="m-0">
            <TimelineTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="map" className="m-0">
            <MapTab artifacts={items} />
          </TabsContent>
          <TabsContent value="custody" className="m-0">
            <CustodyTab threadId={threadId} />
          </TabsContent>
          <TabsContent value="notes" className="m-0">
            <NotesTab threadId={threadId} />
          </TabsContent>
          <TabsContent value="audit" className="m-0">
            <AuditTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="issues" className="m-0">
            <FailedSkippedTab threadId={threadId} />
          </TabsContent>
          <TabsContent value="report" className="m-0">
            <ReportTab threadId={threadId} artifacts={items} />
          </TabsContent>
        </div>
      </Tabs>
      <ArtifactDrawer
        artifact={selected}
        onClose={() => setSelected(null)}
        onChanged={(a) => { updateLocal(a); setSelected(a); }}
        reviewGet={review.get}
        reviewSet={review.set}
        threadId={threadId}
      />
    </div>
  );
}

function ArtifactsList({
  items, onSelect, threadId,
}: { items: Artifact[]; onSelect: (a: Artifact) => void; threadId: string }) {
  const review = useReviewStates(threadId);
  if (items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-4 space-y-1">
        <div>No artifacts recorded yet.</div>
        <div>Submit a seed (email, username, domain, IP, wallet, phone) to start the investigation.</div>
      </div>
    );
  }
  const grouped = items.reduce<Record<Group, Artifact[]>>((acc, a) => {
    const g = groupForKind(a.kind);
    (acc[g] ??= []).push(a);
    return acc;
  }, {} as Record<Group, Artifact[]>);

  return (
    <div className="p-2 space-y-3">
      {GROUP_ORDER.filter((g) => grouped[g]?.length).map((g) => {
        const Icon = GROUP_ICON[g];
        const list = grouped[g];
        // Per-cluster severity breakdown for the header summary.
        let high = 0, mid = 0, low = 0, failedC = 0;
        for (const a of list) {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          if (meta.false_positive === true) { failedC++; continue; }
          const c = a.confidence ?? 0;
          if (c >= 70) high++;
          else if (c >= 50) mid++;
          else low++;
        }
        const sevColor =
          failedC > 0 ? "hsl(var(--danger))" :
          low > 0 ? "hsl(var(--confidence-low))" :
          mid > 0 ? "hsl(var(--confidence-mid))" :
          "hsl(var(--brain-cyan))";
        return (
          <div key={g} className="evidence-tile p-0 overflow-hidden border-l-2 border-l-[hsl(var(--brain-cyan))]">
            {/* Cluster header: icon · label · count · severity breakdown · severity dot */}
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border-subtle bg-surface-1/60">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-surface-2 border border-border-subtle">
                  <Icon className="w-3 h-3 text-muted-foreground" />
                </span>
                <div className="flex flex-col leading-tight min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground truncate">
                    {GROUP_LABEL[g]}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                    {list.length} artifact{list.length === 1 ? "" : "s"}
                    {high > 0 && <> · <span className="text-[hsl(var(--brain-cyan))]">{high} high</span></>}
                    {mid > 0 && <> · <span className="text-[hsl(var(--confidence-mid))]">{mid} med</span></>}
                    {low > 0 && <> · <span className="text-[hsl(var(--confidence-low))]">{low} low</span></>}
                    {failedC > 0 && <> · <span className="text-danger">{failedC} false</span></>}
                  </span>
                </div>
              </div>
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  background: sevColor,
                  boxShadow: `0 0 8px -1px ${sevColor}`,
                }}
                title={failedC > 0 ? "Contains false positives" : low > 0 ? "Contains low-confidence" : mid > 0 ? "Contains medium-confidence" : "All high-confidence"}
              />
            </div>

            <div className="px-1 py-0.5 text-[11px]">
              {list.map((a) => {
                const meta = (a.metadata ?? {}) as Record<string, unknown>;
                const fp = meta.false_positive === true;
                const KIcon = KIND_ICON[a.kind.toLowerCase()] ?? Tag;
                const rState = review.get(a.id);
                const dismissed = rState === "dismissed";
                const conf = a.confidence ?? 0;
                const confTier =
                  conf >= 70 ? "high" : conf >= 50 ? "mid" : "low";
                const confColor =
                  confTier === "high" ? "hsl(var(--brain-cyan))" :
                  confTier === "mid" ? "hsl(var(--confidence-mid))" :
                  "hsl(var(--confidence-low))";
                return (
                  <HoverCard key={a.id} openDelay={250} closeDelay={80}>
                    <HoverCardTrigger asChild>
                      <button
                        onClick={() => onSelect(a)}
                        data-density-row
                        className={cn(
                          "w-full grid grid-cols-[1fr_auto] items-center gap-3 px-1.5 py-1 font-mono text-left transition-colors border-b border-border-subtle/25 last:border-b-0",
                          fp
                            ? "bg-danger-muted/30 hover:bg-danger-muted/50 line-through opacity-70"
                            : dismissed
                            ? "opacity-50 hover:bg-white/[0.025]"
                            : "hover:bg-white/[0.03]",
                        )}
                      >
                        <span className="truncate flex items-center gap-1.5 min-w-0">
                          <KIcon className="w-3 h-3 text-muted-foreground/70 shrink-0" />
                          {/* typed kind column — reads as a forensic data table */}
                          <span className="shrink-0 w-[52px] text-[8.5px] uppercase tracking-[0.12em] text-muted-foreground/45 truncate">{a.kind}</span>
                          {rState === "confirmed" && <CheckCircle2 className="w-3 h-3 text-[hsl(var(--confidence-high))] shrink-0" />}
                          {rState === "key" && <Star className="w-3 h-3 text-primary shrink-0" />}
                          {rState === "recheck" && <ShieldQuestion className="w-3 h-3 text-[hsl(var(--confidence-mid))] shrink-0" />}
                          {rState === "dismissed" && <EyeOff className="w-3 h-3 text-muted-foreground shrink-0" />}
                          {fp && <XCircle className="w-3 h-3 text-destructive shrink-0" />}
                          <span className="truncate text-foreground/90">{a.value}</span>
                        </span>
                        {a.confidence != null && (
                          <span className="flex items-center gap-2 shrink-0">
                            <span className="confidence-track block w-10">
                              <span
                                className="confidence-fill"
                                style={{ width: `${Math.min(100, Math.max(4, conf))}%`, backgroundColor: confColor }}
                              />
                            </span>
                            <span
                              className="text-[10px] font-sans tabular-nums w-8 text-right"
                              style={{ color: confColor }}
                            >
                              {conf}%
                            </span>
                            <ConfidenceExplain artifact={a} review={rState} />
                          </span>
                        )}
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent side="left" align="start" className="w-72 p-0 overflow-hidden border-border-subtle">
                      <ArtifactPeek artifact={a} confColor={confColor} />
                    </HoverCardContent>
                  </HoverCard>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactDrawer({
  artifact, onClose, onChanged, reviewGet, reviewSet, threadId,
}: {
  artifact: Artifact | null;
  onClose: () => void;
  onChanged: (a: Artifact) => void;
  reviewGet: (id: string) => ReviewState;
  reviewSet: (id: string, s: ReviewState | null) => void;
  threadId: string;
}) {
  // (component body unchanged below)
  if (!artifact) return null;
  return (
    <ArtifactDrawerInner
      key={artifact.id}
      artifact={artifact}
      onClose={onClose}
      onChanged={onChanged}
      reviewGet={reviewGet}
      reviewSet={reviewSet}
      threadId={threadId}
    />
  );
}

function ArtifactDrawerInner({
  artifact, onClose, onChanged, reviewGet, reviewSet, threadId,
}: {
  artifact: Artifact;
  onClose: () => void;
  onChanged: (a: Artifact) => void;
  reviewGet: (id: string) => ReviewState;
  reviewSet: (id: string, s: ReviewState | null) => void;
  threadId: string;
}) {
  const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
  const falsePositive = meta.false_positive === true;
  const rState = reviewGet(artifact.id);
  const src = extractSourceInfo(artifact);
  const review = useReviewStates(threadId);
  const [noteDraft, setNoteDraft] = useState(review.getNote(artifact.id));

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(label),
      () => toast.error("Copy failed"),
    );
  };

  const updateMeta = async (patch: Record<string, unknown>) => {
    const next = { ...meta, ...patch };
    const { data, error } = await supabase
      .from("artifacts")
      .update({ metadata: next as never })
      .eq("id", artifact.id)
      .select("id,kind,value,confidence,source,created_at,metadata")
      .maybeSingle();
    if (error || !data) return toast.error(error?.message ?? "Update failed");
    onChanged(data as Artifact);
    toast.success("Updated");
  };

  const citation = `\`${artifact.value}\` (${artifact.kind}${artifact.source ? `, via ${artifact.source}` : ""}${artifact.confidence != null ? `, ${artifact.confidence}%` : ""})`;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono break-words [overflow-wrap:anywhere]">{artifact.value}</SheetTitle>
          <SheetDescription>
            <span className="uppercase text-xs tracking-wider">{artifact.kind}</span>
            {artifact.confidence != null && <span className="ml-2 text-xs">{artifact.confidence}% confidence</span>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-4 text-sm">
          <Field label="Source">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono">{src.primary}</span>
                <span className={"px-1.5 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider " + CACHE_LAYER_CLASS[src.cacheLayer]}>
                  {CACHE_LAYER_LABEL[src.cacheLayer]}
                </span>
                {src.all.length > 1 && (
                  <span className="text-[10px] text-muted-foreground">+{src.all.length - 1} more</span>
                )}
              </div>
              {src.parent && (
                <div className="text-[11px] text-muted-foreground">
                  Parent: <span className="font-mono text-foreground">{src.parent}</span>
                </div>
              )}
            </div>
          </Field>
          <Field label="Sources">
            {!src.hasMetadata ? (
              <div className="text-muted-foreground text-xs">source metadata unavailable</div>
            ) : src.all.length === 0 ? (
              <div className="text-muted-foreground text-xs">No source recorded.</div>
            ) : (
              <ul className="space-y-1 text-xs">
                {src.all.map((s) => (
                  <li key={s} className="flex items-center justify-between font-mono">
                    <span className="truncate">{s}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {artifact.confidence != null ? `${artifact.confidence}%` : "—"}
                    </span>
                  </li>
                ))}
                {src.rawValue && src.rawValue !== artifact.value && (
                  <li className="text-[11px] text-muted-foreground">
                    raw: <span className="font-mono text-foreground break-all">{src.rawValue}</span>
                  </li>
                )}
              </ul>
            )}
          </Field>
          <Field label="First seen">{new Date(artifact.created_at).toLocaleString()}</Field>
          <Field label="Review">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className={"px-2 py-0.5 rounded-full border font-mono text-[10px] uppercase tracking-wider " + REVIEW_CLASS[rState]}>
                {REVIEW_SHORT[rState]}
              </span>
              {falsePositive && <span className="px-2 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/40 text-[10px] uppercase">false positive</span>}
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              <ReviewBtn current={rState} target="confirmed" onClick={() => reviewSet(artifact.id, "confirmed")}>
                <CheckCircle2 className="w-3 h-3" /> Confirm
              </ReviewBtn>
              <ReviewBtn current={rState} target="key" onClick={() => reviewSet(artifact.id, "key")}>
                <Star className="w-3 h-3" /> Key
              </ReviewBtn>
              <ReviewBtn current={rState} target="recheck" onClick={() => reviewSet(artifact.id, "recheck")}>
                <ShieldQuestion className="w-3 h-3" /> Recheck
              </ReviewBtn>
              <ReviewBtn current={rState} target="dismissed" onClick={() => reviewSet(artifact.id, "dismissed")}>
                <EyeOff className="w-3 h-3" /> Dismiss
              </ReviewBtn>
              <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-[10px]" onClick={() => reviewSet(artifact.id, null)}>
                Reset
              </Button>
            </div>
          </Field>
          <Field label="Note">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Why is this key? Add justification, link, or context…"
              rows={3}
              className="w-full text-xs font-mono bg-secondary/40 border border-border rounded p-2 outline-none focus:border-primary/60 resize-y"
            />
            <div className="flex justify-end mt-1">
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[10px]"
                onClick={() => {
                  review.setNote(artifact.id, noteDraft);
                  toast.success("Note saved");
                }}
              >
                Save note
              </Button>
            </div>
          </Field>
          <Field label="Metadata">
            <pre className="text-[11px] font-mono bg-secondary/40 border border-border rounded p-2 overflow-x-auto max-h-48">{JSON.stringify(meta, null, 2)}</pre>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(artifact.value, "Value copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy value</Button>
            <Button size="sm" variant="outline" onClick={() => copy(citation, "Citation copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy citation</Button>
            <Button size="sm" variant={falsePositive ? "destructive" : "secondary"} onClick={() => updateMeta({ false_positive: !falsePositive })} className="gap-1.5">
              <XCircle className="w-3.5 h-3.5" /> {falsePositive ? "Unmark FP" : "Mark false positive"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReviewBtn({
  current, target, onClick, children,
}: {
  current: ReviewState;
  target: ReviewState;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const active = current === target;
  return (
    <Button
      size="sm"
      variant={active ? "default" : "secondary"}
      onClick={onClick}
      className="h-6 px-2 gap-1 text-[10px]"
    >
      {children}
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/* Entity peek — compact on-hover preview surfaced from an artifact row.
   Mirrors detail surface (category, confidence, source, timestamp) plus
   a "Open detail" affordance hint. Click still routes through the row. */
function ArtifactPeek({ artifact: a, confColor }: { artifact: Artifact; confColor: string }) {
  const src = extractSourceInfo(a);
  const created = a.created_at ? new Date(a.created_at) : null;
  const conf = a.confidence ?? 0;
  const group = GROUP_LABEL[groupForKind(a.kind)];
  return (
    <div className="bg-popover text-popover-foreground">
      <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{group}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-[10px] font-mono uppercase text-muted-foreground">{a.kind}</span>
        </div>
        {a.confidence != null && (
          <span className="text-[10px] font-mono tabular-nums" style={{ color: confColor }}>{conf}%</span>
        )}
      </div>
      <div className="px-3 py-2 space-y-2">
        <div className="font-mono text-[12px] text-foreground break-all">{a.value}</div>
        {a.confidence != null && (
          <div className="confidence-track">
            <span
              className="confidence-fill"
              style={{ width: `${Math.min(100, Math.max(4, conf))}%` }}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
          {src?.all && src.all.length > 0 && (
            <div className="col-span-2">
              <div className="uppercase tracking-[0.1em] text-[9px] text-muted-foreground/70 mb-1">Sources</div>
              <div className="flex items-center gap-1 flex-wrap">
                {src.all.map((s) => (
                  <SourceBadge key={s} source={s} size="xs" />
                ))}
              </div>
            </div>
          )}
          {created && <PeekField label="Captured">{created.toLocaleString()}</PeekField>}
          {src?.cacheLayer && src.cacheLayer !== "unknown" && (
            <PeekField label="Layer">{CACHE_LAYER_LABEL[src.cacheLayer] ?? src.cacheLayer}</PeekField>
          )}
        </div>
      </div>
      <div className="px-3 py-1.5 border-t border-border-subtle text-[10px] text-muted-foreground flex items-center justify-between">
        <span>Click row to open detail</span>
        <kbd className="px-1 py-0.5 rounded border border-border-subtle bg-surface-2 font-mono">↵</kbd>
      </div>
    </div>
  );
}

function PeekField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-[0.1em] text-[9px] text-muted-foreground/70">{label}</div>
      <div className="text-foreground truncate" title={typeof children === "string" ? children : undefined}>{children}</div>
    </div>
  );
}
