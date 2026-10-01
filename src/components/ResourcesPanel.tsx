import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useToolbarSlot } from "@/hooks/useToolbarSlot";
import { CompactFilter, FilterPopover, MenuSelect, type CompactOption } from "@/components/ui/compact-controls";
import { supabase } from "@/integrations/supabase/client";
import {
  Mail, Globe, User as UserIcon, Network, ShieldAlert, Image as ImgIcon, Tag,
  Copy, CheckCircle2, XCircle, Star, ShieldQuestion, EyeOff, ChevronRight, Radar,
  AlertTriangle, RotateCcw, Loader2, Unlink,
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
import { evidenceStatus } from "@/lib/evidence-status";
import { ANALYST_ACTIONABLE_STATES, authorityFor, LEDGER_SORT_RANK } from "@/lib/authority";
import { isQuarantined, clusterDefaultOpen } from "@/lib/quarantine";
import {
  canReleaseLinkage, releasePatch,
  RELEASE_ACTION_LABEL, RELEASE_CONFIRM_BODY, RELEASE_CONFIRM_TITLE,
} from "@/lib/quarantine-release";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
// THE one number this surface renders. Every figure, meter, range, aria-label
// and citation below reads `effective` — never `a.confidence`. See
// src/lib/display-confidence.ts for why five pipelines became one.
import { displayConfidence, effectiveConfidence, effectiveConfidenceOrZero } from "@/lib/display-confidence";
import { bandCluster, isProseValue, provenanceOf as provFor } from "@/lib/evidence-bands";
import { readableSourceLabel } from "@/lib/tool-display";
import { humanizeArtifactMetadata } from "@/lib/artifact-metadata";
import {
  harvestedIdentityPreview,
  isBulkCorpusHarvestArtifact,
  partitionBulkCorpusRows,
  type BulkCorpusDisplayRow,
} from "@/lib/bulk-corpus-display";
import {
  AuthorityChip, AuthorityCaveat, AuthorityLegend, AuthoritySpine, RuleLabel, UnderlyingStrength,
} from "@/components/ui/authority";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_SHORT, startRecheck,
  type ReviewState, type ReviewWriteResult,
} from "@/lib/review";

const GROUP_ICON: Record<Group, React.ComponentType<{ className?: string }>> = {
  identity: Tag,
  contact: Mail,
  social: UserIcon,
  infrastructure: Network,
  breach: ShieldAlert,
  web: Globe,
  crypto: ImgIcon,
  affiliation: Tag,
  records: Tag,
  other: Tag,
};


// Title-case a kind for a subheader, with light pluralization.
function kindHeading(kind: string, n: number): string {
  const base = kind.replace(/_/g, " ");
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  if (n === 1) return label;
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(label)) return label + "es";
  return label + "s";
}

// Same-kind clusters larger than this get a fold control and are counted as a
// "wall" (e.g. 11 subdomains, all hackertarget @70%). They still OPEN by
// default — see `clusterDefaultOpen` for why folding by default was reverted —
// so this is the threshold for offering the fold, never for applying it.
const CLUSTER_COLLAPSE_THRESHOLD = 4;

/**
 * Reserved key inside the per-case fold preferences for the board-wide default.
 *
 * Cluster keys are `${group}:${kind}` and therefore always contain a colon, so a
 * colon-free key cannot collide with one. Storing the fold-all choice in the
 * same boolean map means it persists per case through the existing reader and
 * writer with no schema change and no migration.
 */
const FOLD_ALL_KEY = "*";

/**
 * The analyst's own fold/unfold choices, remembered per case.
 *
 * Stores ONLY which cluster headers are open — booleans keyed by group:kind.
 * No artifact value, selector or reason is written to storage: this is a UI
 * preference, and case evidence does not belong in localStorage.
 * Fails silently and returns {} when storage is unavailable (private mode,
 * quota, disabled) — a preference that cannot be read is not an error worth
 * breaking the Evidence board over.
 */
const CLUSTER_PREFS_KEY = (threadId: string) => `proximity:evidence-clusters:${threadId}`;

function readClusterPrefs(threadId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CLUSTER_PREFS_KEY(threadId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch { return {}; }
}

function writeClusterPrefs(threadId: string, prefs: Record<string, boolean>): void {
  try { localStorage.setItem(CLUSTER_PREFS_KEY(threadId), JSON.stringify(prefs)); } catch { /* preference only */ }
}

export type EvidenceStatusFilter = "analyst" | "all" | "strong" | "review" | "quarantined" | "weak" | "excluded";
export type EvidenceSortMode = "strength" | "confidence" | "newest";

/**
 * Which AUTHORITY states each quick-filter admits.
 *
 * `quarantined` is its own bucket, not folded into "Needs review". Those two
 * mean different things and need different work: a review row needs another
 * source, a quarantined row needs a linkage decision. Merging them is how 104
 * quarantined artifacts sat in production looking like ordinary weak evidence.
 */
export const STATUS_FILTER_GROUPS: Record<EvidenceStatusFilter, Set<string> | null> = {
  /**
   * ANALYST VIEW — the default. Everything an analyst has to act on, and nothing
   * that is only there for audit.
   *
   * Deliberately a UNION of the two existing groups rather than a new taxonomy.
   * The board already resolves the noise correctly and it was only ever the
   * DEFAULT that was wrong:
   *   - `triage_decision` / `cluster_decision` never reach this list at all —
   *     `isMetaArtifact` filters them in useThreadArtifacts.
   *   - `excluded_collision` already resolves to `quarantined`, via
   *     `isClusterIneligible` in authorityFor.
   *   - weak leads already resolve to `weak`.
   * So hiding quarantined + weak + failed is the whole job, and inventing a
   * kind-based filter beside the authority states would be a second, drifting
   * source of truth for the same question.
   *
   * Measured 2026-09-03: an average scan lands 60 artifacts of which 4.8 are
   * unquarantined at confidence >= 65. This is what stops the other ~55 being
   * the first thing an analyst sees.
   */
  analyst: new Set(ANALYST_ACTIONABLE_STATES),
  all: null,
  strong: new Set(["verified", "infrastructure", "probable"]),
  review: new Set(["review", "conflict"]),
  quarantined: new Set(["quarantined"]),
  weak: new Set(["weak"]),
  excluded: new Set(["failed"]),
};

function ArtifactsList({
  items, onSelect, review, statusFilter, onShowAll, sortMode, loading, error, onRetry, threadId,
}: {
  items: Artifact[];
  /** Escape hatch out of a filter that is hiding everything. */
  onShowAll?: () => void;
  /** Scopes the remembered fold/unfold choices to this case. */
  threadId: string;
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
  statusFilter: EvidenceStatusFilter;
  sortMode: EvidenceSortMode;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  // Track which kind-clusters the analyst has manually toggled open/closed.
  // Keyed by `${group}:${kind}`; undefined = use the default (open).
  //
  // PERSISTED PER CASE. This was component state, so every fold and unfold died
  // on unmount and the board reset on every visit — the "every single time" half
  // of the complaint. An analyst's decision about their own case survives the
  // remount now; only their own toggles are stored, never evidence.
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>(
    () => readClusterPrefs(threadId),
  );
  const setClusters = useCallback(
    (next: Record<string, boolean>) => {
      setOpenClusters(next);
      writeClusterPrefs(threadId, next);
    },
    [threadId],
  );

  // Apply the status quick-filter, then bucket Group → kind → artifacts and sort
  // each kind by the chosen mode so the strongest evidence surfaces first.
  // Not memoized on `review` so toggling a review state re-filters immediately.
  const allow = STATUS_FILTER_GROUPS[statusFilter];
  const filtered = allow
    ? items.filter((a) => allow.has(authorityFor(a, review.get(a.id)).state))
    : items;

  const grouped = useMemo(() => {
    const byGroup = {} as Record<Group, Record<string, Artifact[]>>;
    for (const a of filtered) {
      const g = groupForKind(a.kind);
      ((byGroup[g] ??= {})[a.kind] ??= []).push(a);
    }
    const conf = (a: Artifact) => {
      const fp = ((a.metadata ?? {}) as Record<string, unknown>).false_positive === true;
      return fp ? -1 : effectiveConfidenceOrZero(a);
    };
    const cmp = (a: Artifact, b: Artifact) => {
      if (sortMode === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if (sortMode === "strength") {
        const ra = LEDGER_SORT_RANK[authorityFor(a, review.get(a.id)).state];
        const rb = LEDGER_SORT_RANK[authorityFor(b, review.get(b.id)).state];
        if (ra !== rb) return ra - rb;
        return conf(b) - conf(a);
      }
      return conf(b) - conf(a); // "confidence"
    };
    for (const g of Object.keys(byGroup) as Group[]) {
      for (const k of Object.keys(byGroup[g])) byGroup[g][k].sort(cmp);
    }
    return byGroup;
    // `review.revision`: with the "All" filter `filtered === items` (same
    // reference), so a verdict change never re-ran this memo and the strength
    // ordering stayed stale until something else re-rendered the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortMode, statusFilter, review.revision]);

  // A FILTER hiding everything must never look like an empty case.
  //
  // Analyst view is the default, and plenty of real cases legitimately have zero
  // rows in it — measured 2026-09-03, one production scan produced 36 artifacts
  // and 0 unquarantined at confidence >= 65. Rendering the standard "no evidence
  // yet" panel there would be a lie about the data, and a silent one. Say what is
  // hidden and why, and offer one click out.
  if (!loading && !error && items.length > 0 && filtered.length === 0) {
    return (
      <div className="p-3 sm:p-5">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,hsl(var(--surface-2)/0.98),hsl(var(--surface-0)/0.98))] px-6 py-10 text-center shadow-[0_34px_110px_-70px_rgba(0,0,0,0.95)]">
          <div className="text-eyebrow font-mono uppercase tracking-[0.22em] text-muted-foreground/70">
            Nothing in this view
          </div>
          <div className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            {statusFilter === "analyst"
              ? `This case has no findings or review items yet. All ${items.length} artifact${items.length === 1 ? "" : "s"} are leads, quarantined or excluded — collected, but not yet corroborated enough to act on.`
              : `No artifact matches this filter. ${items.length} artifact${items.length === 1 ? "" : "s"} on this case.`}
          </div>
          {onShowAll && (
            <button
              type="button"
              onClick={onShowAll}
              className="mt-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12.5px] font-medium text-foreground/90 transition-colors hover:bg-white/10"
            >
              Show all {items.length}
            </button>
          )}
        </div>
      </div>
    );
  }

  // A failed SELECT (transient DB/network) must be visibly distinct from an
  // empty case, with a retry — otherwise a dropped query reads as "nothing found".
  if (error && items.length === 0) {
    return (
      <div className="p-3 sm:p-5">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-destructive/25 bg-[linear-gradient(180deg,hsl(var(--danger-muted)/0.55),hsl(var(--surface-1)/0.92))] px-6 py-12 text-center shadow-[0_34px_110px_-70px_rgba(0,0,0,0.95)]">
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
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,hsl(var(--surface-2)/0.98),hsl(var(--surface-0)/0.98))] shadow-[0_34px_110px_-70px_rgba(0,0,0,0.95)]">
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

  // How many clusters are big enough to be worth a fold control. The board-wide
  // fold is offered only when there is more than one — a single foldable cluster
  // already has its own header toggle, and a second control for it is clutter.
  let foldableClusters = 0;
  for (const g of Object.keys(grouped) as Group[]) {
    for (const k of Object.keys(grouped[g])) {
      if (grouped[g][k].length > CLUSTER_COLLAPSE_THRESHOLD) foldableClusters++;
    }
  }
  const allFolded = openClusters[FOLD_ALL_KEY] === false;

  return (
    <div className="ledger">
      {/* One column grid for the WHOLE board, declared once, so value / status /
          source / confidence line up down every section. Column alignment is the
          single biggest scanning win on a dense case: without it, reading 100
          artifacts means reading 100 individually-laid-out rows. */}
      {foldableClusters > 1 && (
        <div className="flex items-center justify-end gap-2 px-2.5 pt-1.5">
          <span className="text-micro text-muted-foreground/55 tabular-nums">
            {foldableClusters} large groups
          </span>
          <button
            type="button"
            onClick={() => setClusters(allFolded ? {} : { [FOLD_ALL_KEY]: false })}
            aria-pressed={allFolded}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.035] px-2 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", !allFolded && "rotate-90")} aria-hidden />
            {allFolded ? "Unfold all" : "Fold all"}
          </button>
        </div>
      )}
      <div className="ledger-head" role="presentation">
        <span data-ledger-col="value">Evidence</span>
        <span data-ledger-col="status">Authority</span>
        <span data-ledger-col="source">Source</span>
        <span data-ledger-col="confidence" className="text-right">Conf.</span>
      </div>
      {GROUP_ORDER.filter((g) => grouped[g] && Object.keys(grouped[g]).length).map((g) => {
        const Icon = GROUP_ICON[g];
        const kinds = Object.keys(grouped[g]);
        const all = kinds.flatMap((k) => grouped[g][k]);
        // Per-group breakdown for the section rule. Quarantine gets its own
        // count: it is the one condition an analyst must not discover by
        // scrolling, because a quarantined row that goes unnoticed is precisely
        // how a same-name stranger enters a case.
        let failedC = 0;
        let quarantinedC = 0;
        for (const a of all) {
          const meta = (a.metadata ?? {}) as Record<string, unknown>;
          if (meta.false_positive === true) failedC++;
          if (isQuarantined(meta)) quarantinedC++;
        }
        // Order kinds by their strongest member so high-value kinds lead.
        kinds.sort((a, b) => effectiveConfidenceOrZero(grouped[g][b][0]) - effectiveConfidenceOrZero(grouped[g][a][0]));
        return (
          <section key={g} aria-label={GROUP_LABEL[g]}>
            <RuleLabel
              right={
                <span className="flex items-center gap-2.5">
                  {quarantinedC > 0 && (
                    <span
                      className="inline-flex items-center gap-1 text-micro tabular-nums text-[hsl(var(--authority-quarantine))]"
                      title="Recorded, disclosed, and withheld from identity — linkage to the subject is unproven."
                    >
                      <Unlink className="h-3 w-3" strokeWidth={2} aria-hidden />
                      {quarantinedC} quarantined
                    </span>
                  )}
                  {failedC > 0 && (
                    <span className="text-micro tabular-nums text-destructive">{failedC} flagged</span>
                  )}
                  <span className="text-micro tabular-nums text-muted-foreground/70">{all.length}</span>
                </span>
              }
            >
              <span className="inline-flex items-center gap-2">
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden />
                {GROUP_LABEL[g]}
              </span>
            </RuleLabel>

            {kinds.map((kind) => {
              const list = grouped[g][kind];
              // A cluster shares one provenance when every row resolves to the
              // same source — then we show it once in the subheader and drop
              // the repeated per-row line.
              const provs = new Set(list.map(provFor).filter(Boolean));
              const uniformProv = provs.size === 1 ? [...provs][0] : null;
              // A crowded cluster drawn from several harvests reads as one
              // undifferentiated wall; banding names the harvests instead. Not
              // attempted when the cluster is already single-provenance —
              // `uniformProv` handles that case better, with no extra row.
              const bands = uniformProv ? null : bandCluster(list);
              const collapsible = list.length > CLUSTER_COLLAPSE_THRESHOLD;
              const key = `${g}:${kind}`;
              const kindQuarantined = list.filter((a) => isQuarantined(a.metadata)).length;
              // Precedence: this cluster's own toggle, then the analyst's
              // board-wide fold, then the policy default (always open).
              const open = openClusters[key]
                ?? openClusters[FOLD_ALL_KEY]
                ?? clusterDefaultOpen(collapsible, kindQuarantined);
              // Confidence range across the cluster, for the collapsed summary.
              const confs = list.map((a) => effectiveConfidence(a)).filter((c): c is number => c != null);
              const lo = confs.length ? Math.min(...confs) : null;
              const hi = confs.length ? Math.max(...confs) : null;
              // Ordinal INK, not hue — see the confColor note on the row.
              const rangeColor = "hsl(var(--muted-foreground) / 0.85)";
              return (
                <div key={kind}>
                  {/* Kind subheader — clickable when the cluster is collapsible */}
                  <div
                    role={collapsible ? "button" : undefined}
                    tabIndex={collapsible ? 0 : undefined}
                    aria-expanded={collapsible ? open : undefined}
                    onClick={collapsible ? () => setClusters({ ...openClusters, [key]: !open }) : undefined}
                    onKeyDown={collapsible ? (e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setClusters({ ...openClusters, [key]: !open }); }
                    } : undefined}
                    className={cn(
                      "flex items-center gap-1.5 border-b border-border-subtle/60 px-2.5 py-1",
                      collapsible && "cursor-pointer hover:bg-white/[0.028] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    {collapsible ? (
                      <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", open && "rotate-90")} />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-data font-medium text-foreground/75">{kindHeading(kind, list.length)}</span>
                    <span className="text-data tabular-nums text-muted-foreground/70">· {list.length}</span>
                    {kindQuarantined > 0 && !open && (
                      <span className="inline-flex items-center gap-1 text-micro text-[hsl(var(--authority-quarantine))]">
                        <Unlink className="h-3 w-3" strokeWidth={2} aria-hidden />
                        {kindQuarantined} quarantined
                      </span>
                    )}
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

                  {open && bands && bands.map((band) => {
                    const bandQuarantined = band.rows.filter((a) => isQuarantined(a.metadata)).length;
                    return (
                      <div key={band.prov || "\u2014"}>
                        {/* Band header. Deliberately NOT interactive: bands are
                            structure, not a second place to hide rows. It states
                            what this run of rows came from, how many there are,
                            and their spread — the three questions the repeated
                            per-row source label was answering one row at a time. */}
                        <div className="flex items-center gap-1.5 bg-white/[0.012] px-2.5 py-0.5 pl-7">
                          <span className="h-px w-2 shrink-0 bg-white/15" aria-hidden />
                          <span
                            className="truncate font-mono text-micro text-muted-foreground/75"
                            title={band.prov || undefined}
                          >
                            {band.prov ? readableSourceLabel(band.prov) : "source not recorded"}
                          </span>
                          <span className="shrink-0 text-micro tabular-nums text-muted-foreground/55">
                            · {band.rows.length}
                          </span>
                          {bandQuarantined > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-micro text-[hsl(var(--authority-quarantine))]">
                              <Unlink className="h-3 w-3" strokeWidth={2} aria-hidden />
                              {bandQuarantined}
                            </span>
                          )}
                          {band.lo != null && band.hi != null && band.rows.length > 1 && (
                            <span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground/55">
                              {band.lo === band.hi ? `${band.hi}%` : `${band.lo}\u2013${band.hi}%`}
                            </span>
                          )}
                        </div>
                        {renderDisplayRows(partitionBulkCorpusRows(band.rows), onSelect, review, true)}
                      </div>
                    );
                  })}

                  {open && !bands && renderDisplayRows(partitionBulkCorpusRows(list), onSelect, review, uniformProv != null)}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function renderDisplayRows(
  rows: BulkCorpusDisplayRow[],
  onSelect: (a: Artifact) => void,
  review: ReturnType<typeof useReviewStates>,
  hideProv: boolean,
) {
  return rows.map((row) => {
    if (row.type === "single") {
      return (
        <ArtifactRow
          key={row.artifact.id}
          a={row.artifact}
          onSelect={onSelect}
          review={review}
          hideProv={hideProv}
        />
      );
    }
    return (
      <BulkCorpusGroupRow
        key={row.key}
        group={row}
        onSelect={onSelect}
        review={review}
        hideProv={hideProv}
      />
    );
  });
}

function BulkCorpusGroupRow({
  group, onSelect, review, hideProv,
}: {
  group: Extract<BulkCorpusDisplayRow, { type: "bulk_group" }>;
  onSelect: (a: Artifact) => void;
  review: ReturnType<typeof useReviewStates>;
  hideProv: boolean;
}) {
  const lead = group.artifacts[0];
  const authority = authorityFor(lead, review.get(lead.id));
  const preview = group.artifacts.slice(0, 4).map((a) => a.value).join(" · ");
  const more = group.artifacts.length - 4;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(lead)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(lead); }
      }}
      data-density-row
      className="group/row ledger-row cursor-pointer text-left"
      aria-label={`${group.artifacts.length} ${group.label}. ${group.reason}`}
    >
      <AuthoritySpine state={authority.state} />
      <span className="min-w-0" data-ledger-col="value">
        <span className="flex items-start gap-1.5">
          <span className="text-[12.5px] leading-[1.45] text-foreground/90">
            <span className="font-medium">{group.artifacts.length} {group.label}</span>
            {preview && (
              <span className="mt-0.5 block truncate font-mono text-data text-muted-foreground/80">
                {preview}{more > 0 ? ` · +${more} more` : ""}
              </span>
            )}
          </span>
        </span>
        <AuthorityCaveat view={authority} className="mt-0.5 line-clamp-2" />
      </span>
      <span className="min-w-0" data-ledger-col="status">
        <AuthorityChip view={authority} />
        <span className="mt-0.5 truncate text-eyebrow text-muted-foreground/70">{authority.basis}</span>
      </span>
      <span className="min-w-0 truncate font-mono text-eyebrow text-muted-foreground/60" data-ledger-col="source" title={group.source ?? undefined}>
        {!hideProv && group.source ? readableSourceLabel(group.source) : ""}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-0.5" data-ledger-col="confidence">
        <span className="conf-figure text-[hsl(var(--authority-quarantine))]">—</span>
      </span>
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
  const shown = displayConfidence(a);
  const conf = shown.effective ?? 0;
  // A confidence is a MAGNITUDE, and magnitude is carried by the length of the
  // hairline below the numeral — never by the numeral's colour. This used to be
  // a three-step by-value ramp (>=70 green, >=50 amber, else red), which is why
  // the Conf. column read as a column of verdicts: a single-source 38 rendered
  // in alarm red beside a corroborated 88 in confirmation green, when neither
  // colour was saying anything the AUTHORITY chip two columns left had not
  // already said properly. Ink is now constant; only quarantine dims it,
  // because an unlinked row's number genuinely is not about this subject.
  const confColor = isQuarantined(a.metadata)
    ? "hsl(var(--authority-quarantine))"
    : "hsl(var(--foreground) / 0.92)";
  const prov = provFor(a);
  const prose = isProseValue(a.value) || isBulkCorpusHarvestArtifact(a);
  const bulkPreview = isBulkCorpusHarvestArtifact(a) ? harvestedIdentityPreview(a, 4) : [];
  const authority = authorityFor(a, rState);
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
          // The row's accessible name carries BOTH axes plus the caveat, so a
          // screen-reader user gets the quarantine disclosure from the row
          // itself rather than having to open the detail drawer for it.
          aria-label={[
            `${a.kind} ${a.value}`,
            authority.label,
            authority.caveat ?? "",
            shown.effective != null ? `${conf}% confidence` : "",
          ].filter(Boolean).join(". ")}
          data-density-row
          className={cn(
            "group/row ledger-row cursor-pointer text-left",
            dismissed && "opacity-50",
          )}
        >
          <AuthoritySpine state={authority.state} />

          {/* Value +, when there is one, the recorded reason it is not stronger. */}
          <span className="min-w-0" data-ledger-col="value">
            <span className={cn("flex gap-1.5", prose ? "items-start" : "items-center")}>
              {rState === "confirmed" && <CheckCircle2 className="h-3 w-3 shrink-0 text-[hsl(var(--confidence-high))]" aria-hidden />}
              {rState === "key" && <Star className="h-3 w-3 shrink-0 text-primary" aria-hidden />}
              {rState === "recheck" && <ShieldQuestion className="h-3 w-3 shrink-0 text-[hsl(var(--confidence-mid))]" aria-hidden />}
              {rState === "dismissed" && <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
              {fp && <XCircle className="h-3 w-3 shrink-0 text-destructive" aria-hidden />}
              {sensitive && <ShieldAlert className="h-3 w-3 shrink-0 text-destructive" aria-hidden />}
              {/* A selector gets the mono, one-line, truncated treatment this
                  column was built for. A SENTENCE does not: the extractor writes
                  whole findings into `value` ("CONTRADICTION: … Carlos Morales
                  appears in ZERO of 31 records"), and truncating the most
                  important row in a case to forty monospace characters is how
                  it went unread. Prose wraps to two lines in the reading face. */}
              <span
                className={cn(
                  prose
                    ? "text-[12.5px] leading-[1.45] text-foreground/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
                    : "mono-value truncate text-data text-foreground/95",
                  fp && "line-through opacity-70",
                )}
                title={a.value}
              >
                {a.value}
              </span>
              {bulkPreview.length > 0 && (
                <span className="mt-0.5 block truncate font-mono text-data text-muted-foreground/80">
                  {bulkPreview.join(" · ")}
                </span>
              )}
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
                // Always rendered, dimmed until hover/focus rather than
                // `opacity-0`: a copy control an analyst has to discover by
                // hovering is a control most analysts never find, and copying a
                // selector is the single most frequent action on this board.
                className="-my-1 shrink-0 rounded p-1 text-muted-foreground/45 transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/row:text-muted-foreground"
              >
                <Copy className="h-3 w-3" aria-hidden />
              </button>
            </span>
            <AuthorityCaveat view={authority} className="mt-0.5" />
          </span>

          {/* Authority — chip, then BOTH axes on one sub-line: how strong the
              observation is, and what it rests on. Keeping the strength here
              rather than beside the value stops it competing with the recorded
              reason for attention in the value column. */}
          <span className="min-w-0" data-ledger-col="status">
            <AuthorityChip view={authority} />
            <span
              className="mt-0.5 flex items-center gap-1 truncate text-eyebrow text-muted-foreground/70"
              title={authority.state === "quarantined" ? `${authority.underlyingLabel} · ${authority.basis}` : authority.basis}
            >
              <UnderlyingStrength view={authority} />
              {authority.state === "quarantined" && <span aria-hidden>·</span>}
              <span className="truncate">{authority.basis}</span>
            </span>
          </span>

          <span className="min-w-0 truncate font-mono text-eyebrow text-muted-foreground/60" data-ledger-col="source" title={prov || undefined}>
            {!hideProv && prov ? readableSourceLabel(prov) : ""}
          </span>

          <span className="flex shrink-0 items-center justify-end gap-0.5" data-ledger-col="confidence">
            {shown.effective != null && (
              <>
                <span className="flex flex-col items-end gap-1">
                  <span className="conf-figure" style={{ color: confColor }}>{conf}</span>
                  {/* The magnitude. A 2px rule whose LENGTH is the score — the
                      one honest way to show a number at a glance. */}
                  <span className="conf-rule" aria-hidden>
                    <i style={{ width: `${Math.max(3, Math.min(100, conf))}%` }} data-authority={authority.state} />
                  </span>
                </span>
                <ConfidenceExplain
                  artifact={a}
                  review={rState}
                  className="text-muted-foreground/45 transition-colors group-hover/row:text-muted-foreground data-[state=open]:text-foreground"
                />
              </>
            )}
          </span>
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
  reviewSet: (id: string, s: ReviewState | null, ctx?: { value?: string; kind?: string; confidence?: number; source?: string }) => Promise<ReviewWriteResult>;
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
  reviewSet: (id: string, s: ReviewState | null, ctx?: { value?: string; kind?: string; confidence?: number; source?: string }) => Promise<ReviewWriteResult>;
  threadId: string;
}) {
  const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
  // Stored, cap, effective and every applicable ceiling — the drawer is the one
  // surface that shows more than the effective number, because "why is it 60 and
  // not 88" is exactly the question this panel exists to answer.
  const shownArtifact = displayConfidence(artifact);
  const metaRows = humanizeArtifactMetadata(meta);
  const falsePositive = meta.false_positive === true;
  const rState = reviewGet(artifact.id);
  // Ground-truth context passed to every review action so feedback events carry
  // confidence_before/source (else they're dropped from the by-band calibration).
  // `confidence` here becomes `analyst_feedback_events.confidence_before` — the
  // model's PREDICTION AT THE MOMENT OF THE DECISION. That is by definition the
  // number the analyst was looking at, so it is the effective value, not the raw
  // column. Logging raw would make every calibration band measure a figure the
  // product never showed.
  const rctx = { value: artifact.value, kind: artifact.kind, confidence: shownArtifact.effective ?? undefined, source: artifact.source };
  const src = extractSourceInfo(artifact);
  const drawerAuthority = authorityFor(artifact, rState);
  const review = useReviewStates(threadId);
  const [noteDraft, setNoteDraft] = useState(review.getNote(artifact.id));
  // `onChanged` fed the metadata false-positive toggle #534 removed (the review
  // verdict is the one False contract). It is wired again for exactly one caller:
  // the linkage release below — the drawer's only remaining metadata write, and
  // one confined to two keys by `releasePatch`.

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(label),
      () => toast.error("Copy failed"),
    );
  };

  // THE DRAWER'S ONLY METADATA WRITE, and deliberately not a general one.
  //
  // #534 deleted this component's `updateMeta` on a principle worth keeping: it
  // took an arbitrary patch, and its one caller wrote `metadata.false_positive` —
  // a SECOND "is this false?" signal that the agent's review reads never saw. The
  // one visible truth verdict is still the review control below, and nothing here
  // reopens a general path to metadata.
  //
  // This is a different axis, not a second opinion on the same one.
  // `linkage_confirmed` answers "whose is this?"; the review verdict answers "is
  // this real?". `intel.ts` is explicit that release must be "explicit and
  // durable, not a one-click verdict (the review control is known to invert on
  // quarantined rows, so it must not be able to overrule an evidence ceiling on a
  // mis-click)" — which is precisely why it cannot BE a review state.
  //
  // What bounds it: the patch is not this component's to choose. `releasePatch`
  // is a pure function that returns either exactly
  // `{ linkage_confirmed, linkage_confirmed_at }` or `null`, and it returns null
  // for anything that is not an ACTIVE quarantine — never flagged, already
  // released, or malformed metadata. So this call site cannot smuggle a scoring
  // change, and cannot stamp an arbitrary row. Provenance is preserved, not
  // rewritten: `subject_unlinked`, its recorded reason and the recorded
  // confidence cap all survive, because the patch is spread over `meta` rather
  // than replacing it. All of that is pinned by quarantine-linkage-release.test.ts.
  const [releasing, setReleasing] = useState(false);
  const releaseLinkage = async () => {
    if (releasing) return;
    const patch = releasePatch(meta);
    if (!patch) return toast.error("Not under linkage quarantine — nothing to release");
    setReleasing(true);
    try {
      const { data, error } = await supabase
        .from("artifacts")
        .update({ metadata: { ...meta, ...patch } as never })
        .eq("id", artifact.id)
        .select("id,kind,value,confidence,source,created_at,metadata")
        .maybeSingle();
      if (error || !data) return toast.error(error?.message ?? "Release failed");
      onChanged(data as Artifact);
      toast.success("Linkage confirmed — quarantine released");
    } finally {
      setReleasing(false);
    }
  };

  const citation = `\`${artifact.value}\` (${artifact.kind}${artifact.source ? `, via ${artifact.source}` : ""}${shownArtifact.effective != null ? `, ${shownArtifact.effective}%` : ""})`;

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
            {shownArtifact.effective != null && (
              <span className="rounded-md border border-[hsl(var(--confidence-mid)/0.35)] bg-[hsl(var(--confidence-mid)/0.1)] px-2 py-1 font-mono text-eyebrow uppercase tracking-[0.14em] text-[hsl(var(--confidence-mid))]">
                {shownArtifact.effective}% confidence
              </span>
            )}
            <span className={"rounded-md border px-2 py-1 font-mono text-eyebrow uppercase tracking-[0.14em] " + REVIEW_CLASS[rState]}>
              {REVIEW_SHORT[rState]}
            </span>
          </div>
        </SheetHeader>

        <div className="space-y-4 px-5 py-4 text-sm">
          {/* Authority banner — FIRST, above the source stack. An analyst opening
              a quarantined row must meet the linkage question before they read
              the evidence, not after. Previously `subject_unlinked_reason`
              reached this sheet only as an unlabelled key/value row at the very
              bottom of "Details". */}
          {(drawerAuthority.state === "quarantined" || drawerAuthority.caveat) && (
            <div className="panel-inset p-3">
              <div className="cordon mb-2.5 -mx-3 -mt-3 rounded-t-[7px]" aria-hidden />
              <div className="flex flex-wrap items-center gap-2">
                <AuthorityChip view={drawerAuthority} size="md" />
                <UnderlyingStrength view={drawerAuthority} />
              </div>
              <AuthorityCaveat view={drawerAuthority} className="mt-2" />
              {drawerAuthority.state === "quarantined" && (
                <p className="mt-2 text-micro leading-snug text-muted-foreground">
                  Recorded and kept. It does not enter identity clusters, graph
                  identity edges, confidence, or the report until the linkage is
                  confirmed.
                </p>
              )}
              {/* The WRITER for `linkage_confirmed`. Every boundary in the product
                  reads that flag and nothing could set it, so a row auto-quarantined
                  in error was stranded permanently once #518 made quarantine
                  dispatch-blocking. Deliberately NOT one of the review controls
                  below: those answer "is this value real?", this answers "is it this
                  subject's?" — see quarantine-release.ts. Gated on the same
                  `isQuarantined` every other boundary uses, via canReleaseLinkage. */}
              {canReleaseLinkage(meta) && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={releasing}
                      className="mt-3 h-7 w-full font-mono text-eyebrow uppercase tracking-[0.14em]"
                    >
                      {RELEASE_ACTION_LABEL}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{RELEASE_CONFIRM_TITLE}</AlertDialogTitle>
                      <AlertDialogDescription className="whitespace-pre-line text-left">
                        {RELEASE_CONFIRM_BODY}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void releaseLinkage()}>
                        {RELEASE_ACTION_LABEL}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}

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
                      {shownArtifact.effective != null ? `${shownArtifact.effective}%` : "—"}
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
              <ReviewBtn current={rState} target="confirmed" onClick={() => reviewSet(artifact.id, "confirmed", rctx)}>
                <CheckCircle2 className="w-3 h-3" /> Confirm
              </ReviewBtn>
              <ReviewBtn
                current={rState}
                target="recheck"
                onClick={() => {
                  // Persist FIRST; the chat run launches only after the verdict
                  // has committed. A failed write toasts and launches nothing,
                  // and the drawer stays open so the analyst can retry.
                  void startRecheck({
                    set: reviewSet,
                    threadId,
                    artifact: { id: artifact.id, value: artifact.value, kind: artifact.kind },
                    ctx: rctx,
                  }).then((r) => {
                    if (!r.ok) return;
                    toast.success("Rechecking in chat…");
                    onClose();
                  });
                }}
              >
                <ShieldQuestion className="w-3 h-3" /> Recheck
              </ReviewBtn>
              <ReviewBtn current={rState} target="dismissed" onClick={() => reviewSet(artifact.id, "dismissed", rctx)}>
                <XCircle className="w-3 h-3" /> Dismiss
              </ReviewBtn>
              <ReviewBtn current={rState} target="key" onClick={() => reviewSet(artifact.id, "key", rctx)}>
                <Star className="w-3 h-3" /> Key
              </ReviewBtn>
              <Button size="sm" variant="ghost" className="col-span-2 h-7 px-2 gap-1 text-data" onClick={() => reviewSet(artifact.id, null, rctx)}>
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
                  // The write result is real: a failed note has already toasted
                  // and rolled back, so only a committed one reads "saved".
                  void review.setNote(artifact.id, noteDraft, rctx).then((r) => {
                    if (r.ok) toast.success("Note saved");
                  });
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

          {/* The separate "Mark false positive" metadata toggle is gone. It wrote
              `metadata.false_positive` — a second, unrelated "false" signal that
              the agent's review reads never saw. The ONE visible False action is
              the review verdict above (`dismissed`), which reaches every consumer:
              pivots, dispatch, clustering, synthesis, the report and the agent's
              next run. Legacy rows that carry the flag still read as rejected
              (see analyst-decisions.ts isRejectedArtifact) and show the chip. */}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(artifact.value, "Value copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy value</Button>
            <Button size="sm" variant="outline" onClick={() => copy(citation, "Citation copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy citation</Button>
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
  const shown = displayConfidence(a);
  const conf = shown.effective ?? 0;
  const group = GROUP_LABEL[groupForKind(a.kind)];
  return (
    <div className="bg-popover text-popover-foreground">
      <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-eyebrow uppercase tracking-[0.12em] text-muted-foreground">{group}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-eyebrow font-mono uppercase text-muted-foreground">{a.kind}</span>
        </div>
        {shown.effective != null && (
          <span className="text-data font-mono tabular-nums" style={{ color: confColor }}>{conf}%</span>
        )}
      </div>
      <div className="px-3 py-2 space-y-2">
        <div className="font-mono text-data text-foreground break-all">{a.value}</div>
        {shown.effective != null && (
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
export function EvidenceBoard({
  threadId,
  focusRequest,
}: {
  threadId: string;
  /** Open one row, whatever filter the board was left on. `n` is a nonce. */
  focusRequest?: { id: string; n: number } | null;
}) {
  const { items, updateLocal, loading, error, retry } = useThreadArtifacts(threadId);
  const review = useReviewStates(threadId);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [statusFilter, setStatusFilter] = useState<EvidenceStatusFilter>("analyst");

  // A handoff from the case sheet names a row that the default Analyst view
  // may HIDE (it excludes quarantined rows). Widen to All so the row is in the
  // list, and open its drawer. Applied once per nonce, and only once the row
  // has actually loaded — the board can mount before its artifacts arrive.
  const [focusedNonce, setFocusedNonce] = useState<number | null>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.n === focusedNonce) return;
    const target = items.find((a) => a.id === focusRequest.id);
    if (!target) return;
    setStatusFilter("all");
    setSelected(target);
    setFocusedNonce(focusRequest.n);
  }, [focusRequest, focusedNonce, items]);
  const [sortMode, setSortMode] = useState<EvidenceSortMode>("strength");

  // Live counts per quick-filter so the analyst sees how much sits in each bucket.
  const counts = useMemo(() => {
    const c = { analyst: 0, all: items.length, strong: 0, review: 0, quarantined: 0, weak: 0, excluded: 0 };
    for (const a of items) {
      const s = authorityFor(a, review.get(a.id)).state;
      if (STATUS_FILTER_GROUPS.analyst!.has(s)) c.analyst++;
      if (STATUS_FILTER_GROUPS.strong!.has(s)) c.strong++;
      else if (STATUS_FILTER_GROUPS.review!.has(s)) c.review++;
      else if (STATUS_FILTER_GROUPS.quarantined!.has(s)) c.quarantined++;
      else if (STATUS_FILTER_GROUPS.weak!.has(s)) c.weak++;
      else if (STATUS_FILTER_GROUPS.excluded!.has(s)) c.excluded++;
    }
    return c;
    // `review.revision` bumps on every verdict change (including rollbacks), so
    // the counts move the instant an analyst decides — memoising on `items`
    // alone left the chips stale until an unrelated artifact arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, review.revision]);

  const slot = useToolbarSlot();

  const filterOptions: CompactOption<EvidenceStatusFilter>[] = [
    { key: "analyst", label: "Analyst view", count: counts.analyst, hint: "Everything that needs a decision — leads and exclusions hidden" },
    { key: "all", label: "All", count: counts.all },
    { key: "strong", label: "Findings", count: counts.strong, tone: "ok" },
    { key: "review", label: "Needs review", count: counts.review, tone: "warn" },
    // Only offered when there is something in it — an always-present
    // "Quarantined 0" trains analysts to stop reading the number.
    ...(counts.quarantined > 0
      ? [{ key: "quarantined" as const, label: "Quarantined", count: counts.quarantined }]
      : []),
    { key: "weak", label: "Leads", count: counts.weak },
    { key: "excluded", label: "Excluded", count: counts.excluded, tone: "danger" },
  ];
  const sortOptions: CompactOption<EvidenceSortMode>[] = [
    { key: "strength", label: "Strength" },
    { key: "confidence", label: "Confidence" },
    { key: "newest", label: "Newest" },
  ];

  // One toolbar row: the common filters inline, the rest behind More, sort as a
  // labelled menu, the legend beside it. Below `sm` it all folds into a single
  // Filters button that states the active choices.
  const controls = items.length > 0 ? (
    <>
      <div className="hidden min-w-0 flex-wrap items-center justify-end gap-2 sm:flex">
        <CompactFilter<EvidenceStatusFilter>
          label="Filter evidence"
          options={filterOptions}
          primary={["analyst", "all", "review"]}
          active={statusFilter}
          onChange={setStatusFilter}
        />
        <MenuSelect<EvidenceSortMode> label="Sort" options={sortOptions} active={sortMode} onChange={setSortMode} />
        <AuthorityLegend />
      </div>
      <div className="flex items-center gap-2 sm:hidden">
        <FilterPopover
          sections={[
            {
              label: "Show",
              options: filterOptions,
              active: statusFilter,
              // Resolve the key back through the option list, so only a real
              // filter key can ever reach the state setter.
              onChange: (k) => { const hit = filterOptions.find((o) => o.key === k); if (hit) setStatusFilter(hit.key); },
            },
            {
              label: "Sort by",
              options: sortOptions,
              active: sortMode,
              onChange: (k) => { const hit = sortOptions.find((o) => o.key === k); if (hit) setSortMode(hit.key); },
            },
          ]}
        />
        <AuthorityLegend />
      </div>
    </>
  ) : null;

  return (
    <>
      {controls && (slot
        ? createPortal(controls, slot)
        : <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border-subtle px-2 py-2">{controls}</div>)}
      <ArtifactsList
        items={items}
        threadId={threadId}
        onSelect={setSelected}
        review={review}
        statusFilter={statusFilter}
        onShowAll={() => setStatusFilter("all")}
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
