import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Mail, Phone, Globe, User as UserIcon, Network, ShieldAlert, MapPin, Image as ImgIcon, Tag,
  Copy, CheckCircle2, XCircle, PanelRightOpen, PanelRightClose, Star, ShieldQuestion, EyeOff,
  Database, BarChart3, Lock, FileOutput, ChevronRight, Layers,
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
  // Two-level chrome: a flat strip of the few main views, plus a "Full review"
  // tab that reveals the complete section/sub-tab navigation. Keeps the common
  // case to 3 tabs instead of 4 sections × 12 sub-tabs.
  const [mode, setMode] = useState<"main" | "full">("main");

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

  // The handful of views surfaced at the top level. Each already exists as a
  // sub-tab inside SECTIONS, so Full review just re-exposes the complete nav.
  const MAIN_TABS = [
    { v: "overview", l: "Overview", icon: BarChart3 },
    { v: "artifacts", l: "Artifacts", icon: Database },
    { v: "report", l: "Report", icon: FileOutput },
  ] as const;
  const sectionForTab = (v: string) =>
    SECTIONS.find((s) => s.tabs.some((t) => t.v === v))?.key;

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
      if (detail?.section) { setSection(detail.section); setMode("full"); }
      if (detail?.tab) {
        setTab(detail.tab);
        const isMain = ["overview", "artifacts", "report"].includes(detail.tab);
        if (!detail.section) {
          setMode(isMain ? "main" : "full");
          if (!isMain) {
            const sec = SECTIONS.find((s) => s.tabs.some((t) => t.v === detail.tab))?.key;
            if (sec) setSection(sec);
          }
        }
      }
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
        <div className="sticky top-0 z-10 border-b border-border-subtle bg-background">
          <div className="px-4 h-14 flex items-center gap-3">
            <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground shrink-0 uppercase">Case</div>
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
                {seed?.value ? compactSeed(seed.value).display : "—"}
              </span>
              {seed?.value && (
                <Copy className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              )}
            </button>
            <span className="px-2.5 py-1 rounded-full border border-border-subtle bg-surface-1 text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
              {items.length}
            </span>
            <DensityToggle className="hidden md:inline-flex" />
            <button
              onClick={onToggleCollapse}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title="Collapse panel"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
          {/* Primary nav — the few main views plus a Full review tab that opens everything */}
          <div className="px-3 py-2 flex items-center gap-1 border-t border-border-subtle">
            {MAIN_TABS.map((t) => {
              const Icon = t.icon;
              const active = mode === "main" && tab === t.v;
              const count = TAB_COUNTS[t.v];
              return (
                <button
                  key={t.v}
                  onClick={() => { setMode("main"); setTab(t.v); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[10px] font-medium uppercase tracking-[0.16em] transition-colors",
                    active
                      ? "bg-surface-1 text-foreground border border-white/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {t.l}
                  {count != null && count > 0 && (
                    <span className="font-mono text-[9px] tabular-nums text-muted-foreground/70">{count}</span>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => { setMode("full"); setSection(sectionForTab(tab) ?? "evidence"); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[10px] font-medium uppercase tracking-[0.16em] transition-colors",
                mode === "full"
                  ? "bg-surface-1 text-foreground border border-white/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
              )}
            >
              <Layers className="w-3 h-3" />
              Full review
            </button>
          </div>

          {/* Full review only: the complete section + sub-tab navigation */}
          {mode === "full" && (
            <>
              <div className="px-3 py-2 flex items-center gap-1 border-t border-border-subtle">
                {SECTIONS.map((s) => {
                  const Icon = s.icon;
                  const active = section === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => onSectionChange(s.key)}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-[10px] font-medium uppercase tracking-[0.16em] transition-colors",
                        active
                          ? "bg-surface-1 text-foreground border border-white/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <div className="px-3 pb-3 pt-0.5">
                <TabsList className="w-full h-9 bg-transparent rounded-none p-0 gap-2 justify-start">
                  {activeSection.tabs.map((t) => {
                    const count = TAB_COUNTS[t.v];
                    return (
                      <TabsTrigger
                        key={t.v}
                        value={t.v}
                        className="relative h-9 px-0 rounded-none bg-transparent text-[13px] font-medium text-muted-foreground border-b border-transparent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-white/30 data-[state=active]:shadow-none transition-colors"
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
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-background">
          <TabsContent value="overview" className="m-0">
            <OverviewTab threadId={threadId} artifacts={items} />
          </TabsContent>
          <TabsContent value="artifacts" className="m-0">
            <ArtifactsList items={items} onSelect={setSelected} review={review} />
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

// Provenance string shown under a row / in a cluster header.
function provFor(a: Artifact): string {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.platform === "string" ? meta.platform
    : typeof meta.breach_source === "string" ? `breach · ${meta.breach_source}`
    : a.source ?? "";
}

// Title-case a kind for a subheader, with light pluralization.
function kindHeading(kind: string, n: number): string {
  const base = kind.replace(/_/g, " ");
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  if (n === 1) return label;
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(label)) return label + "es";
  return label + "s";
}

// Same-kind clusters larger than this collapse by default — they're the source
// of the "wall of identical rows" (e.g. 11 subdomains, all hackertarget @70%).
const CLUSTER_COLLAPSE_THRESHOLD = 4;

function ArtifactsList({
  items, onSelect, review,
}: { items: Artifact[]; onSelect: (a: Artifact) => void; review: ReturnType<typeof useReviewStates> }) {
  // Track which kind-clusters the user has manually toggled open/closed.
  // Keyed by `${group}:${kind}`; undefined = use the default (collapsed when big).
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>({});

  // Group → kind → artifacts, with kinds and rows sorted by confidence so the
  // strongest evidence surfaces first. Memoized so hover / review-state changes
  // don't re-bucket the whole evidence set.
  const grouped = useMemo(() => {
    const byGroup = {} as Record<Group, Record<string, Artifact[]>>;
    for (const a of items) {
      const g = groupForKind(a.kind);
      ((byGroup[g] ??= {})[a.kind] ??= []).push(a);
    }
    const conf = (a: Artifact) => {
      const fp = ((a.metadata ?? {}) as Record<string, unknown>).false_positive === true;
      return fp ? -1 : (a.confidence ?? 0);
    };
    for (const g of Object.keys(byGroup) as Group[]) {
      for (const k of Object.keys(byGroup[g])) byGroup[g][k].sort((a, b) => conf(b) - conf(a));
    }
    return byGroup;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-4 space-y-1">
        <div>No artifacts recorded yet.</div>
        <div>Submit a seed (email, username, domain, IP, wallet, phone) to start the investigation.</div>
      </div>
    );
  }

  return (
    <div className="px-2 py-3 space-y-5">
      {GROUP_ORDER.filter((g) => grouped[g] && Object.keys(grouped[g]).length).map((g) => {
        const Icon = GROUP_ICON[g];
        const kinds = Object.keys(grouped[g]);
        const all = kinds.flatMap((k) => grouped[g][k]);
        // Per-group severity breakdown for the header summary.
        let high = 0, mid = 0, low = 0, failedC = 0;
        for (const a of all) {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          if (meta.false_positive === true) { failedC++; continue; }
          const c = a.confidence ?? 0;
          if (c >= 70) high++;
          else if (c >= 50) mid++;
          else low++;
        }
        // Order kinds by their strongest member so high-value kinds lead.
        kinds.sort((a, b) => (grouped[g][b][0]?.confidence ?? 0) - (grouped[g][a][0]?.confidence ?? 0));
        return (
          <div key={g}>
            {/* Group header: quiet label · count, with a muted severity breakdown (red when flagged) */}
            <div className="flex items-center gap-2 px-2 pb-1.5">
              <Icon
                className={cn(
                  "h-3 w-3 shrink-0",
                  failedC > 0 ? "text-destructive" : "text-muted-foreground/80",
                )}
              />
              <span
                className="text-[10.5px] font-semibold uppercase tracking-[0.18em]"
                style={{ color: failedC > 0 ? "hsl(var(--danger))" : "hsl(var(--foreground) / 0.62)" }}
              >
                {GROUP_LABEL[g]}
              </span>
              <span className="text-[10.5px] tabular-nums text-muted-foreground/80">· {all.length}</span>
              <span className="ml-auto flex items-center gap-2 text-[9.5px] tabular-nums">
                {high > 0 && <span style={{ color: "hsl(var(--confidence-high))" }}>{high} hi</span>}
                {mid > 0 && <span style={{ color: "hsl(var(--confidence-mid))" }}>{mid} md</span>}
                {low > 0 && <span style={{ color: "hsl(var(--confidence-low))" }}>{low} lo</span>}
                {failedC > 0 && <span style={{ color: "hsl(var(--danger))" }}>{failedC} flag</span>}
              </span>
            </div>

            <div className="space-y-0.5">
              {kinds.map((kind) => {
                const list = grouped[g][kind];
                // A cluster shares one provenance when every row resolves to the
                // same source — then we show it once in the subheader and drop
                // the repeated per-row line.
                const provs = new Set(list.map(provFor).filter(Boolean));
                const uniformProv = provs.size === 1 ? [...provs][0] : null;
                const collapsible = list.length > CLUSTER_COLLAPSE_THRESHOLD;
                const key = `${g}:${kind}`;
                const open = openClusters[key] ?? !collapsible;
                // Confidence range across the cluster, for the collapsed summary.
                const confs = list.map((a) => a.confidence).filter((c): c is number => c != null);
                const lo = confs.length ? Math.min(...confs) : null;
                const hi = confs.length ? Math.max(...confs) : null;
                const rangeColor = (hi ?? 0) >= 70 ? "hsl(var(--confidence-high))"
                  : (hi ?? 0) >= 50 ? "hsl(var(--confidence-mid))" : "hsl(var(--confidence-low))";
                return (
                  <div key={kind}>
                    {/* Kind subheader — clickable when the cluster is collapsible */}
                    <div
                      role={collapsible ? "button" : undefined}
                      tabIndex={collapsible ? 0 : undefined}
                      aria-expanded={collapsible ? open : undefined}
                      onClick={collapsible ? () => setOpenClusters((p) => ({ ...p, [key]: !open })) : undefined}
                      onKeyDown={collapsible ? (e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenClusters((p) => ({ ...p, [key]: !open })); }
                      } : undefined}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-md",
                        collapsible && "cursor-pointer hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      )}
                    >
                      {collapsible ? (
                        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", open && "rotate-90")} />
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <span className="text-[11px] font-medium text-foreground/75">{kindHeading(kind, list.length)}</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground/70">· {list.length}</span>
                      {uniformProv && (
                        <span className="truncate font-mono text-[9.5px] text-muted-foreground/60">{uniformProv}</span>
                      )}
                      {lo != null && hi != null && (
                        <span className="ml-auto text-[10px] font-semibold tabular-nums" style={{ color: rangeColor }}>
                          {lo === hi ? `${hi}%` : `${lo}–${hi}%`}
                        </span>
                      )}
                    </div>

                    {open && (
                      <div className="divide-y divide-border-subtle/35 pl-2">
                        {list.map((a) => (
                          <ArtifactRow
                            key={a.id}
                            a={a}
                            onSelect={onSelect}
                            review={review}
                            hideProv={uniformProv != null}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactRow({
  a, onSelect, review, hideProv,
}: {
  a: Artifact;
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
  hideProv: boolean;
}) {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const fp = meta.false_positive === true;
  const sensitive = meta.possible_minor === true || meta.minor_warning === true;
  const rState = review.get(a.id);
  const dismissed = rState === "dismissed";
  const conf = a.confidence ?? 0;
  const confColor =
    conf >= 70 ? "hsl(var(--confidence-high))" :
    conf >= 50 ? "hsl(var(--confidence-mid))" :
    "hsl(var(--confidence-low))";
  const prov = provFor(a);
  return (
    <HoverCard openDelay={250} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(a)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(a); }
          }}
          data-density-row
          className={cn(
            "group/row flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            fp ? "hover:bg-danger-muted/30" : "hover:bg-white/[0.04]",
            dismissed && "opacity-50",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {rState === "confirmed" && <CheckCircle2 className="h-3 w-3 shrink-0 text-[hsl(var(--confidence-high))]" />}
              {rState === "key" && <Star className="h-3 w-3 shrink-0 text-primary" />}
              {rState === "recheck" && <ShieldQuestion className="h-3 w-3 shrink-0 text-[hsl(var(--confidence-mid))]" />}
              {rState === "dismissed" && <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />}
              {fp && <XCircle className="h-3 w-3 shrink-0 text-destructive" />}
              {sensitive && <ShieldAlert className="h-3 w-3 shrink-0 text-destructive" />}
              <span className={cn("truncate text-[13px] text-foreground/95", fp && "line-through opacity-70")}>
                {a.value}
              </span>
            </span>
            {!hideProv && prov && (
              <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">
                {prov}
              </span>
            )}
          </span>
          <button
            type="button"
            aria-label={`Copy ${a.value}`}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(a.value).then(
                () => toast.success("Copied"),
                () => toast.error("Copy failed"),
              );
            }}
            className="-m-2 shrink-0 rounded p-2 text-muted-foreground/60 opacity-60 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/row:opacity-100"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          {a.confidence != null && (
            <span className="flex shrink-0 items-center gap-1">
              <span className="w-9 text-right text-[12px] font-semibold tabular-nums" style={{ color: confColor }}>{conf}%</span>
              <ConfidenceExplain artifact={a} review={rState} />
            </span>
          )}
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start" className="w-72 overflow-hidden p-0 border-border-subtle">
        <ArtifactPeek artifact={a} confColor={confColor} />
      </HoverCardContent>
    </HoverCard>
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
