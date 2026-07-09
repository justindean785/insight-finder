import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Mail, Globe, User as UserIcon, Network, ShieldAlert, Image as ImgIcon, Tag,
  Copy, CheckCircle2, XCircle, Star, ShieldQuestion, EyeOff, ChevronRight, Radar,
  AlertTriangle, RotateCcw, Loader2,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
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
import { evidenceStatus, EVIDENCE_STATUS_RANK } from "@/lib/evidence-status";
import { readableSourceLabel } from "@/lib/tool-display";
import { humanizeArtifactMetadata } from "@/lib/artifact-metadata";
import { EvidenceStatusBadge, FilterChips, StatusLegend } from "@/components/ui/workspace-primitives";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_SHORT, launchRecheckInChat,
  type ReviewState,
} from "@/lib/review";

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

export type EvidenceStatusFilter = "all" | "strong" | "review" | "weak" | "excluded";
export type EvidenceSortMode = "strength" | "confidence" | "newest";

// Which display statuses each quick-filter admits.
const STATUS_FILTER_GROUPS: Record<EvidenceStatusFilter, Set<string> | null> = {
  all: null,
  strong: new Set(["verified", "verified_infrastructure", "probable"]),
  review: new Set(["needs_corroboration", "manual_review", "contradicted"]),
  weak: new Set(["lead", "shared_infrastructure"]),
  excluded: new Set(["rejected"]),
};

function ArtifactsList({
  items, onSelect, review, statusFilter, sortMode, loading, error, onRetry,
}: {
  items: Artifact[];
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
  statusFilter: EvidenceStatusFilter;
  sortMode: EvidenceSortMode;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  // Track which kind-clusters the user has manually toggled open/closed.
  // Keyed by `${group}:${kind}`; undefined = use the default (collapsed when big).
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>({});

  // Apply the status quick-filter, then bucket Group → kind → artifacts and sort
  // each kind by the chosen mode so the strongest evidence surfaces first.
  // Not memoized on `review` so toggling a review state re-filters immediately.
  const allow = STATUS_FILTER_GROUPS[statusFilter];
  const filtered = allow
    ? items.filter((a) => allow.has(evidenceStatus(a, review.get(a.id)).status))
    : items;

  const grouped = useMemo(() => {
    const byGroup = {} as Record<Group, Record<string, Artifact[]>>;
    for (const a of filtered) {
      const g = groupForKind(a.kind);
      ((byGroup[g] ??= {})[a.kind] ??= []).push(a);
    }
    const conf = (a: Artifact) => {
      const fp = ((a.metadata ?? {}) as Record<string, unknown>).false_positive === true;
      return fp ? -1 : (a.confidence ?? 0);
    };
    const cmp = (a: Artifact, b: Artifact) => {
      if (sortMode === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if (sortMode === "strength") {
        const ra = EVIDENCE_STATUS_RANK[evidenceStatus(a, review.get(a.id)).status];
        const rb = EVIDENCE_STATUS_RANK[evidenceStatus(b, review.get(b.id)).status];
        if (ra !== rb) return ra - rb;
        return conf(b) - conf(a);
      }
      return conf(b) - conf(a); // "confidence"
    };
    for (const g of Object.keys(byGroup) as Group[]) {
      for (const k of Object.keys(byGroup[g])) byGroup[g][k].sort(cmp);
    }
    return byGroup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortMode, statusFilter]);

  // A failed SELECT (transient DB/network) must be visibly distinct from an
  // empty case, with a retry — otherwise a dropped query reads as "nothing found".
  if (error && items.length === 0) {
    return (
      <div className="p-3 sm:p-5">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-destructive/25 bg-[linear-gradient(180deg,rgba(70,20,20,0.22),rgba(12,8,8,0.9))] px-6 py-12 text-center shadow-[0_34px_110px_-70px_rgba(0,0,0,0.95)]">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-destructive/35 bg-destructive/10 text-destructive">
            <AlertTriangle className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </div>
          <div>
            <div className="font-display text-lg font-semibold tracking-tight text-foreground">Couldn't load evidence</div>
            <div className="mt-1 text-sm text-muted-foreground">
              The artifact query failed — this may be a transient network or database issue.
            </div>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // Still fetching the first page — a quiet skeleton, not the empty state.
  if (loading && items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--intel-blue))]" />
        Loading evidence…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-3 sm:p-5">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(17,19,23,0.98),rgba(5,6,8,0.98))] shadow-[0_34px_110px_-70px_rgba(0,0,0,0.95)]">
          <div className="border-b border-white/8 px-4 sm:px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              {/* radar node — "sensor acquiring contact" */}
              <div className="relative grid h-11 w-11 shrink-0 place-items-center">
                <span
                  aria-hidden
                  className="radar-ring absolute h-11 w-11 rounded-full border border-[hsl(var(--intel-blue)/0.5)]"
                  style={{ animation: "radar-ping 3.4s ease-out infinite" }}
                />
                <span
                  aria-hidden
                  className="radar-ring absolute h-11 w-11 rounded-full border border-[hsl(var(--intel-blue)/0.5)]"
                  style={{ animation: "radar-ping 3.4s ease-out infinite", animationDelay: "1.7s" }}
                />
                <div className="relative grid h-11 w-11 place-items-center rounded-xl border border-[hsl(var(--intel-blue)/0.35)] bg-[linear-gradient(180deg,hsl(var(--surface-3)),hsl(var(--surface-1)))] text-[hsl(var(--intel-blue))] shadow-[0_0_26px_-10px_hsl(var(--intel-blue)/0.7)]">
                  <Radar className="h-[18px] w-[18px]" strokeWidth={1.6} />
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-eyebrow font-mono uppercase tracking-[0.22em] text-[hsl(var(--intel-blue))]">
                  Evidence board
                </div>
                <div className="mt-1 font-display text-lg sm:text-xl font-semibold tracking-tight text-foreground">
                  Awaiting first artifact
                </div>
              </div>
            </div>
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[hsl(var(--intel-blue)/0.25)] bg-[hsl(var(--intel-blue)/0.06)] px-3 py-1.5 text-data font-mono text-[hsl(var(--intel-blue))]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--intel-blue))]" />
              Scanning · 0 captured
            </div>
          </div>

          <div className="grid gap-px bg-white/8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Identity", icon: Tag, lines: ["profiles", "aliases", "names"] },
              { label: "Contact", icon: Mail, lines: ["emails", "phones", "accounts"] },
              { label: "Infrastructure", icon: Network, lines: ["domains", "IPs", "services"] },
              { label: "Risk", icon: ShieldAlert, lines: ["breaches", "exposure", "review"] },
            ].map(({ label, icon: Icon, lines }) => (
              <div key={label} className="min-h-[164px] bg-background/95 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035]">
                    <Icon className="h-4 w-4 text-foreground/72" strokeWidth={1.75} />
                  </div>
                  <span className="text-data font-mono text-muted-foreground">empty</span>
                </div>
                <div className="mt-5 text-sm font-medium text-foreground">{label}</div>
                <div className="mt-4 space-y-2">
                  {lines.map((line, index) => (
                    <div key={line} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-white/18" />
                      <span
                        className={cn(
                          "h-2 rounded-full bg-white/[0.07]",
                          index === 0 ? "w-24" : index === 1 ? "w-16" : "w-20",
                        )}
                        aria-label={line}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="px-4 sm:px-5 py-4 border-t border-white/8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm">
            <span className="text-muted-foreground">
              Submit a seed from Chat to populate confidence, source, and review state.
            </span>
            <span className="font-mono text-data text-foreground/70">T1-T6 confidence ready</span>
          </div>
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-6 text-center space-y-1">
        <div className="text-foreground/80 font-medium">No evidence matches this filter.</div>
        <div>Switch back to “All” to see every recorded artifact.</div>
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
        let failedC = 0;
        for (const a of all) {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          if (meta.false_positive === true) failedC++;
        }
        // Order kinds by their strongest member so high-value kinds lead.
        kinds.sort((a, b) => (grouped[g][b][0]?.confidence ?? 0) - (grouped[g][a][0]?.confidence ?? 0));
        return (
          <div
            key={g}
            className="rounded-2xl border border-white/8 bg-[linear-gradient(165deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_48%,rgba(255,255,255,0.008))] p-2.5 shadow-[0_22px_80px_-52px_rgba(0,0,0,0.96)] backdrop-blur-xl"
          >
            {/* Group header: quiet label · count; only a flag count when something is flagged */}
            <div className="flex items-center gap-2 px-2 pb-1.5">
              <Icon
                className={cn(
                  "h-3 w-3 shrink-0",
                  failedC > 0 ? "text-destructive" : "text-muted-foreground/80",
                )}
              />
              <span
                className="text-eyebrow font-semibold uppercase tracking-[0.18em]"
                style={{ color: failedC > 0 ? "hsl(var(--danger))" : "hsl(var(--foreground) / 0.62)" }}
              >
                {GROUP_LABEL[g]}
              </span>
              <span className="text-data tabular-nums text-muted-foreground/80">· {all.length}</span>
              {failedC > 0 && (
                <span className="ml-auto text-micro tabular-nums" style={{ color: "hsl(var(--danger))" }}>
                  {failedC} flagged
                </span>
              )}
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
                  <div key={kind} className="rounded-xl border border-white/6 bg-white/[0.015]">
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
                      <span className="text-data font-medium text-foreground/75">{kindHeading(kind, list.length)}</span>
                      <span className="text-data tabular-nums text-muted-foreground/70">· {list.length}</span>
                      {uniformProv && (
                        <span className="truncate font-mono text-micro text-muted-foreground/60" title={uniformProv}>{readableSourceLabel(uniformProv)}</span>
                      )}
                      {/* Singletons show their score on the row itself; only
                          show a subheader figure for multi-row clusters. */}
                      {lo != null && hi != null && list.length > 1 && (
                        <span className="ml-auto text-data font-semibold tabular-nums" style={{ color: rangeColor }}>
                          {lo === hi ? `${hi}%` : `${lo}–${hi}%`}
                        </span>
                      )}
                    </div>

                    {open && (
                      <div className="divide-y divide-border-subtle/35 pl-2 py-1">
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
  const status = evidenceStatus(a, rState);
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
            "group/row flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            fp ? "hover:bg-danger-muted/30" : "hover:bg-white/[0.04]",
            !fp && "hover:border-white/10 hover:shadow-[0_10px_30px_-24px_rgba(0,0,0,0.95)]",
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
              <span className={cn("truncate text-meta text-foreground/95", fp && "line-through opacity-70")} title={a.value}>
                {a.value}
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 flex-wrap">
              <EvidenceStatusBadge
                status={status.status}
                label={status.label}
                tone={status.tone}
                hint={status.hint}
              />
              <span className="truncate text-data text-muted-foreground/75" title={status.basis}>
                {status.basis}
              </span>
              {!hideProv && prov && (
                <span className="truncate font-mono text-data text-muted-foreground/55" title={prov}>
                  · {readableSourceLabel(prov)}
                </span>
              )}
            </span>
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
            className="-m-2 shrink-0 rounded p-2 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/row:opacity-100"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          {a.confidence != null && (
            <span className="flex shrink-0 items-center gap-1">
              <span className="w-9 text-right text-data font-semibold tabular-nums" style={{ color: confColor }}>{conf}%</span>
              <ConfidenceExplain
                artifact={a}
                review={rState}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
              />
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
  const metaRows = humanizeArtifactMetadata(meta);
  const falsePositive = meta.false_positive === true;
  const rState = reviewGet(artifact.id);
  const src = extractSourceInfo(artifact);
  const review = useReviewStates(threadId);
  const [noteDraft, setNoteDraft] = useState(review.getNote(artifact.id));
  const [saving, setSaving] = useState(false);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(label),
      () => toast.error("Copy failed"),
    );
  };

  const updateMeta = async (patch: Record<string, unknown>) => {
    if (saving) return;
    setSaving(true);
    try {
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
    } finally {
      setSaving(false);
    }
  };

  const citation = `\`${artifact.value}\` (${artifact.kind}${artifact.source ? `, via ${artifact.source}` : ""}${artifact.confidence != null ? `, ${artifact.confidence}%` : ""})`;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-[min(92vw,460px)] overflow-y-auto border-l border-white/[0.08] bg-[hsl(var(--surface-0))] p-0 sm:max-w-[460px]"
      >
        <SheetHeader className="border-b border-white/[0.08] px-5 py-5 text-left">
          <SheetDescription className="font-mono text-eyebrow uppercase tracking-[0.18em] text-muted-foreground">
            Evidence detail
          </SheetDescription>
          <SheetTitle className="font-mono text-xl leading-tight break-words [overflow-wrap:anywhere]">
            {artifact.value}
          </SheetTitle>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-eyebrow uppercase tracking-[0.14em] text-muted-foreground">
              {artifact.kind}
            </span>
            {artifact.confidence != null && (
              <span className="rounded-md border border-[hsl(var(--confidence-mid)/0.35)] bg-[hsl(var(--confidence-mid)/0.1)] px-2 py-1 font-mono text-eyebrow uppercase tracking-[0.14em] text-[hsl(var(--confidence-mid))]">
                {artifact.confidence}% confidence
              </span>
            )}
            <span className={"rounded-md border px-2 py-1 font-mono text-eyebrow uppercase tracking-[0.14em] " + REVIEW_CLASS[rState]}>
              {REVIEW_SHORT[rState]}
            </span>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-5 py-4 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
              <div className="text-eyebrow uppercase tracking-wider text-muted-foreground">Primary source</div>
              <div className="mt-1 min-w-0 font-mono text-sm break-all">{src.primary}</div>
            </div>
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
              <div className="text-eyebrow uppercase tracking-wider text-muted-foreground">First seen</div>
              <div className="mt-1 font-mono text-sm">{new Date(artifact.created_at).toLocaleString()}</div>
            </div>
          </div>

          <Field label="Source stack">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono">{src.primary}</span>
                <span className={"px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider " + CACHE_LAYER_CLASS[src.cacheLayer]}>
                  {CACHE_LAYER_LABEL[src.cacheLayer]}
                </span>
                {src.all.length > 1 && (
                  <span className="text-data text-muted-foreground">+{src.all.length - 1} more</span>
                )}
              </div>
              {src.parent && (
                <div className="text-data text-muted-foreground">
                  Parent: <span className="font-mono text-foreground">{src.parent}</span>
                </div>
              )}
            </div>
          </Field>
          <Field label="Corroboration">
            {!src.hasMetadata ? (
              <div className="text-muted-foreground text-xs">source metadata unavailable</div>
            ) : src.all.length === 0 ? (
              <div className="text-muted-foreground text-xs">No source recorded.</div>
            ) : (
              <ul className="space-y-1 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2 text-xs">
                {src.all.map((s) => (
                  <li key={s} className="flex items-center justify-between font-mono">
                    <span className="truncate">{s}</span>
                    <span className="text-data text-muted-foreground shrink-0">
                      {artifact.confidence != null ? `${artifact.confidence}%` : "—"}
                    </span>
                  </li>
                ))}
                {src.rawValue && src.rawValue !== artifact.value && (
                  <li className="text-data text-muted-foreground">
                    raw: <span className="font-mono text-foreground break-all">{src.rawValue}</span>
                  </li>
                )}
              </ul>
            )}
          </Field>
          <Field label="Review">
            <div className="mb-2 flex items-center gap-2 flex-wrap text-xs">
              <span className={"px-2 py-0.5 rounded-full border font-mono text-eyebrow uppercase tracking-wider " + REVIEW_CLASS[rState]}>
                {REVIEW_SHORT[rState]}
              </span>
              {falsePositive && <span className="px-2 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/40 text-eyebrow uppercase">false positive</span>}
            </div>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2">
              <ReviewBtn current={rState} target="confirmed" onClick={() => reviewSet(artifact.id, "confirmed")}>
                <CheckCircle2 className="w-3 h-3" /> Confirm
              </ReviewBtn>
              <ReviewBtn
                current={rState}
                target="recheck"
                onClick={() => {
                  reviewSet(artifact.id, "recheck");
                  launchRecheckInChat(threadId, { value: artifact.value, kind: artifact.kind });
                  toast.success("Rechecking in chat…");
                  onClose();
                }}
              >
                <ShieldQuestion className="w-3 h-3" /> Recheck
              </ReviewBtn>
              <ReviewBtn current={rState} target="dismissed" onClick={() => reviewSet(artifact.id, "dismissed")}>
                <XCircle className="w-3 h-3" /> False
              </ReviewBtn>
              <ReviewBtn current={rState} target="key" onClick={() => reviewSet(artifact.id, "key")}>
                <Star className="w-3 h-3" /> Key
              </ReviewBtn>
              <Button size="sm" variant="ghost" className="col-span-2 h-7 px-2 gap-1 text-data" onClick={() => reviewSet(artifact.id, null)}>
                Reset
              </Button>
            </div>
          </Field>
          <Field label="Note">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              aria-label="Note — justification or context for this artifact"
              placeholder="Why is this key? Add justification, link, or context…"
              rows={3}
              className="w-full text-xs font-mono bg-secondary/40 border border-border rounded p-2 outline-none focus:border-primary/60 resize-y"
            />
            <div className="flex justify-end mt-1">
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-data"
                onClick={() => {
                  review.setNote(artifact.id, noteDraft);
                  toast.success("Note saved");
                }}
              >
                Save note
              </Button>
            </div>
          </Field>
          <Field label="Details">
            {metaRows.length === 0 ? (
              <div className="text-muted-foreground text-xs">No additional details recorded.</div>
            ) : (
              <dl className="space-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2.5 text-xs">
                {metaRows.map((row) => (
                  <div key={row.key} className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-eyebrow uppercase tracking-wider text-muted-foreground">{row.label}</dt>
                    <dd className="min-w-0 break-all text-right font-mono text-foreground [overflow-wrap:anywhere]">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {import.meta.env.DEV && (
              <details className="mt-2">
                <summary className="cursor-pointer text-eyebrow uppercase tracking-wider text-muted-foreground/70">Raw metadata (dev only)</summary>
                <pre className="code-panel mt-1 max-h-64 overflow-x-auto p-3 text-data font-mono">{JSON.stringify(meta, null, 2)}</pre>
              </details>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(artifact.value, "Value copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy value</Button>
            <Button size="sm" variant="outline" onClick={() => copy(citation, "Citation copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy citation</Button>
            <Button size="sm" variant={falsePositive ? "destructive" : "secondary"} disabled={saving} onClick={() => updateMeta({ false_positive: !falsePositive })} className="col-span-2 gap-1.5">
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
      className="h-6 px-2 gap-1 text-data"
    >
      {children}
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-eyebrow uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
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
          <span className="text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">{group}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-eyebrow font-mono uppercase text-muted-foreground">{a.kind}</span>
        </div>
        {a.confidence != null && (
          <span className="text-data font-mono tabular-nums" style={{ color: confColor }}>{conf}%</span>
        )}
      </div>
      <div className="px-3 py-2 space-y-2">
        <div className="font-mono text-data text-foreground break-all">{a.value}</div>
        {a.confidence != null && (
          <div className="confidence-track">
            <span
              className="confidence-fill"
              style={{ width: `${Math.min(100, Math.max(4, conf))}%` }}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-data text-muted-foreground">
          {src?.all && src.all.length > 0 && (
            <div className="col-span-2">
              <div className="uppercase tracking-[0.1em] text-micro text-muted-foreground/70 mb-1">Sources</div>
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
      <div className="px-3 py-1.5 border-t border-border-subtle text-data text-muted-foreground flex items-center justify-between">
        <span>Click row to open detail</span>
        <kbd className="px-1 py-0.5 rounded border border-border-subtle bg-surface-2 font-mono">↵</kbd>
      </div>
    </div>
  );
}

function PeekField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-[0.1em] text-micro text-muted-foreground/70">{label}</div>
      <div className="text-foreground truncate" title={typeof children === "string" ? children : undefined}>{children}</div>
    </div>
  );
}

/**
 * EvidenceBoard — the grouped artifact list + detail drawer, self-contained
 * (pass a threadId). This is the core surface of the Evidence workspace tab;
 * it reuses the same ArtifactsList/ArtifactDrawer the rail used to render.
 */
export function EvidenceBoard({ threadId }: { threadId: string }) {
  const { items, updateLocal, loading, error, retry } = useThreadArtifacts(threadId);
  const review = useReviewStates(threadId);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [statusFilter, setStatusFilter] = useState<EvidenceStatusFilter>("all");
  const [sortMode, setSortMode] = useState<EvidenceSortMode>("strength");

  // Live counts per quick-filter so the analyst sees how much sits in each bucket.
  const counts = useMemo(() => {
    const c = { all: items.length, strong: 0, review: 0, weak: 0, excluded: 0 };
    for (const a of items) {
      const s = evidenceStatus(a, review.get(a.id)).status;
      if (STATUS_FILTER_GROUPS.strong!.has(s)) c.strong++;
      else if (STATUS_FILTER_GROUPS.review!.has(s)) c.review++;
      else if (STATUS_FILTER_GROUPS.weak!.has(s)) c.weak++;
      else if (STATUS_FILTER_GROUPS.excluded!.has(s)) c.excluded++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (
    <>
      {items.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2.5 border-b border-border-subtle bg-[linear-gradient(180deg,rgba(13,15,19,0.94),rgba(13,15,19,0.86))] backdrop-blur-xl">
          <FilterChips<EvidenceStatusFilter>
            ariaLabel="Filter evidence by strength"
            active={statusFilter}
            onChange={setStatusFilter}
            options={[
              { key: "all", label: "All", count: counts.all },
              { key: "strong", label: "Findings", count: counts.strong, tone: "ok" },
              { key: "review", label: "Needs review", count: counts.review, tone: "warn" },
              { key: "weak", label: "Leads", count: counts.weak },
              { key: "excluded", label: "Excluded", count: counts.excluded, tone: "danger" },
            ]}
          />
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-eyebrow uppercase tracking-[0.14em] text-muted-foreground/70">Sort</span>
            <FilterChips<EvidenceSortMode>
              ariaLabel="Sort evidence"
              active={sortMode}
              onChange={setSortMode}
              options={[
                { key: "strength", label: "Strength" },
                { key: "confidence", label: "Confidence" },
                { key: "newest", label: "Newest" },
              ]}
            />
            <StatusLegend />
          </div>
        </div>
      )}
      <ArtifactsList
        items={items}
        onSelect={setSelected}
        review={review}
        statusFilter={statusFilter}
        sortMode={sortMode}
        loading={loading}
        error={error}
        onRetry={retry}
      />
      <ArtifactDrawer
        artifact={selected}
        onClose={() => setSelected(null)}
        onChanged={(a) => { updateLocal(a); setSelected(a); }}
        reviewGet={review.get}
        reviewSet={review.set}
        threadId={threadId}
      />
    </>
  );
}
