import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ToolbarSlotContext } from "@/hooks/useToolbarSlot";
import { MenuSelect } from "@/components/ui/compact-controls";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { summarizeReviewCounts } from "@/lib/authority";
import { EvidenceBoard } from "@/components/ResourcesPanel";
import { EvidenceMatrixTab } from "@/components/panel/EvidenceMatrixTab";
import { ClustersTab } from "@/components/panel/ClustersTab";
import { TimelineTab } from "@/components/panel/TimelineTab";
import { PivotsTab } from "@/components/panel/PivotsTab";
import { LayoutGrid, Table2, Network, Clock, GitBranch, RefreshCw, ArrowRight, type LucideIcon } from "lucide-react";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { humanizeStage } from "@/lib/tool-display";
import { timeAgo } from "@/lib/time";
import type { EvidenceSortMode } from "@/lib/evidence-sort";

type View = "board" | "table" | "clusters" | "timeline" | "pivots";

// Labels are what the lens ACTUALLY renders, not legacy terminology:
//  - `board` → "Ledger" (compact rows, aligned columns, grouped repeats). It
//    is already the compact ledger (see commit f5602512 — "Board already IS the
//    compact ledger"). Keeping the key `board` preserves routes, deep links,
//    and the e2e specs under `e2e/evidence-ledger.spec.ts`.
//  - `table` → "Cards" (EvidenceMatrixTab renders rich evidence cards, not a
//    traditional table).
// Clusters / Timeline / Pivots keep their names — they already name what they
// render.
const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "board", label: "Ledger", icon: LayoutGrid },
  { key: "table", label: "Cards", icon: Table2 },
  { key: "clusters", label: "Clusters", icon: Network },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "pivots", label: "Pivots", icon: GitBranch },
];

/**
 * Evidence workspace — the case evidence board. Findings grouped by category
 * (identity, contact, social, infrastructure, breach…) with confidence, source
 * and verification status, plus alternate lenses: a flat sortable table, entity
 * clusters, and a chronological timeline. Fills the full main workspace width.
 */
function isView(v: string): v is View {
  return v === "board" || v === "table" || v === "clusters" || v === "timeline" || v === "pivots";
}

export function EvidenceTab({
  threadId,
  viewRequest,
}: {
  threadId: string;
  // A command-palette jump target may request a specific lens; `n` is a nonce so
  // re-requesting the same lens still re-applies it.
  viewRequest?: { view: string; n: number; artifactId?: string; authorityState?: string } | null;
}) {
  const { items, updateLocal, hasMore, cap } = useThreadArtifacts(threadId);
  const review = useReviewStates(threadId);
  // Case desk R4: the run-update banner and the "N findings across M source
  // records" line read the case snapshot and the R2 assessment. Both are
  // optional, so a standalone render (tests, the read-only case view) still works.
  const snapshot = useOptionalCaseSnapshot()?.snapshot ?? null;
  const assessment = useAgentAssessment(threadId);
  const [sortRequest, setSortRequest] = useState<{ mode: EvidenceSortMode; n: number } | null>(null);
  const [view, setView] = useState<View>(
    viewRequest && isView(viewRequest.view) ? viewRequest.view : "board",
  );

  // Honor a requested lens from the command palette (also fires on first mount,
  // since EvidenceTab lazy-loads after the jump event has already been handled).
  useEffect(() => {
    if (viewRequest && isView(viewRequest.view)) setView(viewRequest.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest?.n]);

  // Analyst review state, summarised for the header context line.
  //
  // "verified" MUST come from the shared `tallyAuthority` selector
  // (src/lib/authority.ts), the same one WorkspaceHeader and OverviewTab use —
  // not a local re-derivation. `authorityFor` gates verification through
  // `isClusterIneligible`, so a quarantined or possible_collision row can never
  // read "verified" here, and it also counts corroboration-derived CONFIRMED
  // rows that an analyst never explicitly reviewed. A hand-rolled tally that
  // only counts explicit `confirmed`/`key` reviews (the previous code here)
  // undercounts against Overview/the header on identical data — measured: 1
  // vs 2 on the same 55-artifact case, because a corroborated-but-unreviewed
  // row is real evidence Overview already counts.
  //
  // "excluded" is the authority ladder's `failed` state, the same figure as the
  // board's Excluded chip; "recheck" is an analyst verdict with no ladder state.
  const tally = useMemo(() => summarizeReviewCounts(items, review.get), [items, review]);

  const parts: ReactNode[] = [
    <span
      key="total"
      title="Deduped case artifacts across every run. The header's 'evidence logged' counts chain-of-custody entries and can be higher."
    >
      {items.length} artifact{items.length === 1 ? "" : "s"}
    </span>,
  ];
  if (tally.verified) parts.push(<span className="text-[hsl(var(--confidence-high))]">{tally.verified} verified</span>);
  if (tally.excluded) parts.push(<span className="text-danger">{tally.excluded} excluded</span>);
  if (tally.recheck) parts.push(<span className="text-[hsl(var(--confidence-mid))]">{tally.recheck} to recheck</span>);

  const subtitle = (
    <span className="inline-flex flex-wrap items-center">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>}
          {p}
        </span>
      ))}
      {hasMore && (
        <span
          className="ml-2 inline-flex items-center rounded border border-warning/30 bg-warning/10 px-1 py-px text-micro uppercase tracking-wider text-warning"
          title={`Initial load capped at ${cap.toLocaleString()} rows. New realtime inserts still apply, but older artifacts beyond the cap are not yet loaded.`}
        >
          ⚠ sampled (latest {cap.toLocaleString()})
        </span>
      )}
    </span>
  );

  // The toolbar slot the active lens renders its own controls into, so the tab
  // has ONE toolbar row instead of a heading row plus a filter row plus a sort
  // row (131px before the first finding at a 600px panel).
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  // The run-update banner (prototype): what the latest run left behind, in
  // figures the page can stand behind. "New since the previous assessment"
  // appears only once a baseline exists (useAgentAssessment); before that the
  // banner names the run and the last tool stage, never a change it cannot measure.
  const run = snapshot?.hydrated ? snapshot.run : null;
  const tools = snapshot?.hydrated ? snapshot.tools : null;
  const newSince = assessment.hasBaseline ? Object.values(assessment.deltas).filter((d) => d.from === null).length : null;
  const nowConflict = assessment.hasBaseline ? Object.values(assessment.deltas).filter((d) => d.to === "conflict" && d.from !== null && d.from !== "conflict").length : null;
  const ledgerCount = snapshot?.hydrated ? snapshot.evidence.ledger : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Section heading (prototype): the name, then "N findings across M source records". */}
      <div className="shrink-0 border-b border-white/[0.07] bg-surface-0 px-3 py-2 sm:px-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h2 className="font-display text-[21px] font-medium leading-tight tracking-[-0.03em]">Evidence</h2>
            <p className="mt-0.5 text-data text-muted-foreground">
              {snapshot?.hydrated && ledgerCount !== null ? (
                <span title="Findings are deduplicated artifact rows; source records are chain-of-custody entries across every run.">
                  {items.length} finding{items.length === 1 ? "" : "s"} across {ledgerCount} source record{ledgerCount === 1 ? "" : "s"}
                  <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>
                </span>
              ) : null}
              {subtitle}
            </p>
          </div>
          <MenuSelect<View>
            label="View"
            showLabel={false}
            align="start"
            active={view}
            onChange={(k) => setView(k)}
            options={VIEWS.map((v) => ({ key: v.key, label: v.label, icon: v.icon }))}
          />
          <div ref={setSlot} className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:min-w-[25rem] sm:flex-nowrap" />
        </div>
      </div>
      {view === "board" && run && tools && (
        <div className="shrink-0 px-3 pt-3 sm:px-4" data-run-update>
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 rounded-[7px] border border-[hsl(var(--brand)/0.25)] bg-[linear-gradient(110deg,hsl(var(--brand)/0.08),hsl(var(--surface-1)))] px-3.5 py-2.5 text-[12px]">
            <RefreshCw className={`h-4 w-4 shrink-0 text-[hsl(var(--brand))] ${run.state === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
            <div className="min-w-0 flex-1 text-muted-foreground">
              <b className="font-medium text-foreground">{run.state === "running" ? "Run in progress" : "Latest run"}</b>
              <span className="px-1.5 text-faint-foreground" aria-hidden>/</span>
              {tools.available ? `${tools.total} tool call${tools.total === 1 ? "" : "s"}` : "tool calls unread"}
              {tools.lastStage && <><span className="px-1.5 text-faint-foreground" aria-hidden>·</span>last stage {humanizeStage(tools.lastStage)}</>}
              {tools.lastAt && <><span className="px-1.5 text-faint-foreground" aria-hidden>·</span>{timeAgo(tools.lastAt)}</>}
              {newSince !== null && <><span className="px-1.5 text-faint-foreground" aria-hidden>·</span>{newSince} new record{newSince === 1 ? "" : "s"} since the previous assessment</>}
              {nowConflict !== null && nowConflict > 0 && <><span className="px-1.5 text-faint-foreground" aria-hidden>·</span>{nowConflict} now in conflict</>}
            </div>
            <button
              type="button"
              onClick={() => setSortRequest({ mode: "newest", n: Date.now() })}
              className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[hsl(var(--brand))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View changes <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      <ToolbarSlotContext.Provider value={slot}>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The board reads its own data so it can own the detail drawer; the
            other lenses share the already-loaded artifact set. */}
        {view === "board" && (
          <div className="mx-auto max-w-5xl">
            <EvidenceBoard
              threadId={threadId}
              focusRequest={viewRequest?.artifactId ? { id: viewRequest.artifactId, n: viewRequest.n } : null}
              filterRequest={viewRequest?.authorityState ? { state: viewRequest.authorityState, n: viewRequest.n } : null}
              sortRequest={sortRequest}
            />
          </div>
        )}
        {view === "table" && (
          <div className="mx-auto max-w-6xl">
            <EvidenceMatrixTab artifacts={items} onLocalUpdate={updateLocal} threadId={threadId} />
          </div>
        )}
        {view === "clusters" && (
          <div className="mx-auto max-w-5xl">
            <ClustersTab threadId={threadId} artifacts={items} />
          </div>
        )}
        {view === "timeline" && (
          <div className="mx-auto max-w-4xl">
            <TimelineTab threadId={threadId} artifacts={items} />
          </div>
        )}
        {view === "pivots" && (
          <div className="mx-auto max-w-5xl">
            <PivotsTab threadId={threadId} artifacts={items} />
          </div>
        )}
      </div>
      </ToolbarSlotContext.Provider>
    </div>
  );
}
