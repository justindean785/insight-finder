import { useEffect, useMemo, useState } from "react";
import { useWorkbenchPivots } from "@/hooks/useWorkbenchPivots";
import { NextSteps } from "@/components/pivots/NextSteps";
import { buildEntityGraph } from "@/lib/entity-graph";
import { summarizeConnections } from "@/lib/connection-summary";
import { hidePivots, restorePivots } from "@/lib/pivot-skip";
import type { RunnablePivot } from "@/lib/pivot-schema";
import { hasPivotRunner } from "@/lib/pivot-runner";
import type { ReviewAdjustment } from "@/lib/intel";

/**
 * The Workbench's Next tab: the SAME compact list the Investigate transcript ends with (best pivot, the ones after
 * it, unrunnable suggestions behind one disclosure), built from the same engine, validation and eligibility, but
 * always in reach beside whatever tab you are reading. Every Run still opens its Preview first, and nothing is queued.
 * Unlike the transcript's rail it is not gated on the latest message being report-shaped, so it works from the case's
 * own recorded selectors too; it never offers the generic "ask the agent" prompts, which are a chat concern.
 */
type PivotQueue = ReturnType<typeof useWorkbenchPivots>;

export function WorkbenchNext({ threadId, openRequest = null, pivots }: {
  threadId: string;
  /** Open this pivot's preview: a request from another surface. `n` makes a repeat request distinct. */
  openRequest?: { key: string; n: number } | null;
  /** The queue, computed ONCE by the Workbench (it also feeds the tab badge). Standalone renders compute their own. */
  pivots?: PivotQueue;
}) {
  // Hooks cannot be conditional, so the owned-queue case is its own component:
  // a Workbench-provided queue must not be computed a second time here.
  if (pivots) return <WorkbenchNextView threadId={threadId} openRequest={openRequest} pivots={pivots} />;
  return <WorkbenchNextOwned threadId={threadId} openRequest={openRequest} />;
}

function WorkbenchNextOwned({ threadId, openRequest }: { threadId: string; openRequest: { key: string; n: number } | null }) {
  const pivots = useWorkbenchPivots(threadId);
  return <WorkbenchNextView threadId={threadId} openRequest={openRequest} pivots={pivots} />;
}

function WorkbenchNextView({ threadId, openRequest, pivots }: {
  threadId: string;
  openRequest: { key: string; n: number } | null;
  pivots: PivotQueue;
}) {
  const { snapshot, review, artifacts, artifactsById, caseRunning, runViews, seed, skip, items } = pivots;
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (openRequest) setOpen(openRequest.key);
  }, [openRequest]);

  // The last hide, for a one-step undo. Cleared on the next hide or restore.
  const [lastHide, setLastHide] = useState<{ targets: string[]; label: string } | null>(null);
  const hide = (targets: string[], label: string) => {
    hidePivots(threadId, targets);
    setLastHide({ targets, label });
  };

  const reviews = useMemo(() => {
    const m: Record<string, ReviewAdjustment> = {};
    for (const a of artifacts) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts, review]);
  const connections = useMemo(
    () => summarizeConnections(buildEntityGraph(artifacts, seed.value, seed.type, reviews), artifacts),
    [artifacts, seed.value, seed.type, reviews],
  );

  if (!snapshot?.hydrated || review.availability === "unknown") {
    return <div className="space-y-3 p-5" aria-busy="true"><div className="h-20 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" aria-hidden /></div>;
  }
  if (review.availability === "unavailable") {
    return (
      <p role="status" className="px-5 py-4 text-[13px] leading-snug text-muted-foreground">
        Your review decisions couldn't be loaded, so pivots are withheld — they could otherwise offer a selector you already rejected.
      </p>
    );
  }
  if (items.length === 0 && runViews.length === 0) {
    return (
      <div className="px-5 py-4 text-[13px] text-muted-foreground">
        <p>No pivot is waiting. New ones appear as the investigation records selectors or the agent recommends them.</p>
        {skip.size > 0 && (
          <p role="status" className="mt-2 text-[12.5px] text-faint-foreground">
            {skip.size} hidden on this device.{" "}
            <button type="button" onClick={() => { restorePivots(threadId); setLastHide(null); }} className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Show all
            </button>
          </p>
        )}
      </div>
    );
  }

  const run = (p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt, action: p.action },
    }));
  };

  return (
    <div data-workbench-next className="p-3">
      <div className="px-2 pb-2 pt-1">
        <div className="text-[11px] uppercase tracking-[0.09em] text-subtle-foreground">Recommended next</div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Ranked by expected case value, not record volume. Every run opens its preview first.</p>
      </div>
      {!hasPivotRunner(threadId) && (
        <p className="border-b border-border-subtle px-5 py-2 text-[12.5px] text-muted-foreground">
          Pivots run from the Investigate tab. Open this case in the workspace to run them.
        </p>
      )}
      <NextSteps
        items={items}
        onRunPivot={run}
        onRunAction={() => {}}
        busy={caseRunning}
        runs={runViews}
        onViewChanges={(artifactId) => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId } }))}
        openKey={open}
        onOpenChange={setOpen}
        connections={connections}
        artifactsById={artifactsById}
        onOpenGraph={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "graph" } }))}
        onHide={hide}
        hiddenCount={skip.size}
        onShowHidden={() => { restorePivots(threadId); setLastHide(null); }}
        lastHidden={lastHide ? { label: lastHide.label, count: lastHide.targets.length } : null}
        onUndoHide={() => { if (lastHide) restorePivots(threadId, lastHide.targets); setLastHide(null); }}
      />
    </div>
  );
}
