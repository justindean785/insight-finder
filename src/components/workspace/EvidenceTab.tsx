import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ToolbarSlotContext } from "@/hooks/useToolbarSlot";
import { MenuSelect } from "@/components/ui/compact-controls";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { tallyAuthority } from "@/lib/authority";
import { EvidenceBoard } from "@/components/ResourcesPanel";
import { EvidenceMatrixTab } from "@/components/panel/EvidenceMatrixTab";
import { ClustersTab } from "@/components/panel/ClustersTab";
import { TimelineTab } from "@/components/panel/TimelineTab";
import { PivotsTab } from "@/components/panel/PivotsTab";
import { LayoutGrid, Table2, Network, Clock, GitBranch, type LucideIcon } from "lucide-react";

type View = "board" | "table" | "clusters" | "timeline" | "pivots";

const VIEWS: { key: View; label: string; icon: LucideIcon }[] = [
  { key: "board", label: "Board", icon: LayoutGrid },
  { key: "table", label: "Table", icon: Table2 },
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
  viewRequest?: { view: string; n: number; artifactId?: string } | null;
}) {
  const { items, updateLocal, hasMore, cap } = useThreadArtifacts(threadId);
  const review = useReviewStates(threadId);
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
  // "rejected" / "recheck" have no equivalent in the authority ladder — they
  // are purely analyst-decision states — so those stay a direct review tally.
  const tally = useMemo(() => {
    const authority = tallyAuthority(items, review.get);
    let rejected = 0, recheck = 0;
    for (const a of items) {
      const s = review.get(a.id);
      if (s === "wrong" || s === "dismissed") rejected++;
      else if (s === "recheck") recheck++;
    }
    return { verified: authority.verified, rejected, recheck };
  }, [items, review]);

  const parts: ReactNode[] = [`${items.length} artifact${items.length === 1 ? "" : "s"}`];
  if (tally.verified) parts.push(<span className="text-[hsl(var(--confidence-high))]">{tally.verified} verified</span>);
  if (tally.rejected) parts.push(<span className="text-destructive">{tally.rejected} rejected</span>);
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

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* The tab strip already names this section; the heading is kept for
          screen-reader navigation only. */}
      <h2 className="sr-only">Evidence</h2>
      <div className="shrink-0 border-b border-white/[0.07] bg-surface-0 px-3 py-2 sm:px-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2">
          <MenuSelect<View>
            label="View"
            showLabel={false}
            align="start"
            active={view}
            onChange={(k) => setView(k)}
            options={VIEWS.map((v) => ({ key: v.key, label: v.label, icon: v.icon }))}
          />
          <span className="min-w-0 text-data text-muted-foreground">{subtitle}</span>
          <div ref={setSlot} className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2" />
        </div>
      </div>

      <ToolbarSlotContext.Provider value={slot}>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The board reads its own data so it can own the detail drawer; the
            other lenses share the already-loaded artifact set. */}
        {view === "board" && (
          <div className="mx-auto max-w-5xl">
            <EvidenceBoard
              threadId={threadId}
              focusRequest={viewRequest?.artifactId ? { id: viewRequest.artifactId, n: viewRequest.n } : null}
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
