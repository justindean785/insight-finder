import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { tallyAuthority } from "@/lib/authority";
import { EvidenceBoard } from "@/components/ResourcesPanel";
import { EvidenceMatrixTab } from "@/components/panel/EvidenceMatrixTab";
import { ClustersTab } from "@/components/panel/ClustersTab";
import { TimelineTab } from "@/components/panel/TimelineTab";
import { PivotsTab } from "@/components/panel/PivotsTab";
import { TabHeader } from "@/components/ui/workspace-primitives";
import { LayoutGrid, Table2, Network, Clock, GitBranch, Database, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
  viewRequest?: { view: string; n: number } | null;
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

  return (
    <div className="h-full flex flex-col min-h-0">
      <TabHeader icon={Database} title="Evidence" subtitle={subtitle}>
        <div className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.035] p-1">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const active = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                title={v.label}
                aria-label={`Show ${v.label.toLowerCase()} evidence view`}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-7 items-center justify-center gap-1.5 rounded-lg transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // The active lens names itself. Five identical icon-only
                  // squares meant the analyst had to hover each one to learn
                  // what it was AND had no way to read which one they were
                  // looking at — the selected background says "this one" but
                  // never says what "this" is. Labelling only the active button
                  // costs ~60px and removes both problems at once.
                  active ? "px-2.5 bg-white text-black" : "w-8",
                  !active && "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
                {active && <span className="text-data font-medium">{v.label}</span>}
              </button>
            );
          })}
        </div>
      </TabHeader>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* The board reads its own data so it can own the detail drawer; the
            other lenses share the already-loaded artifact set. */}
        {view === "board" && (
          <div className="mx-auto max-w-5xl">
            <EvidenceBoard threadId={threadId} />
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
    </div>
  );
}
