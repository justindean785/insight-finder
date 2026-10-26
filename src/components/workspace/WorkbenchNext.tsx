import { useCasePivotQueue } from "@/hooks/useCasePivotQueue";
import { useEffect, useMemo, useState } from "react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { useReviewStates } from "@/lib/review";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { buildEntityGraph } from "@/lib/entity-graph";
import { summarizeConnections } from "@/lib/connection-summary";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";
import type { RunnablePivot } from "@/lib/pivot-schema";
import { hasPivotRunner } from "@/lib/pivot-runner";
import type { ReviewAdjustment } from "@/lib/intel";
import { buildWorkbenchQueue } from "@/lib/next-step-queue";

/**
 * The Workbench's Next tab: the SAME compact list the Investigate transcript ends with (best pivot, the ones after
 * it, unrunnable suggestions behind one disclosure), built from the same engine, validation and eligibility, but
 * always in reach beside whatever tab you are reading. Every Run still opens its Preview first, and nothing is queued.
 * Unlike the transcript's rail it is not gated on the latest message being report-shaped, so it works from the case's
 * own recorded selectors too; it never offers the generic "ask the agent" prompts, which are a chat concern.
 */
export function WorkbenchNext({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const queue = useCasePivotQueue();
  const usesSharedQueue = queue !== null;
  const review = useReviewStates(threadId);
  const queriedTargets = useThreadQueriedTargets(threadId, !queue);
  const artifacts = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const seed = snapshot?.seed ?? { value: null, type: null };
  const [reportPivots, setReportPivots] = useState<RecommendedPivot[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (usesSharedQueue) return;
    const onReport = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; pivots: RecommendedPivot[] }>).detail;
      if (d?.threadId === threadId && Array.isArray(d.pivots)) setReportPivots(d.pivots);
    };
    window.addEventListener("swarmbot:report-pivots", onReport as EventListener);
    window.dispatchEvent(new CustomEvent("swarmbot:request-report-pivots", { detail: { threadId } }));
    return () => window.removeEventListener("swarmbot:report-pivots", onReport as EventListener);
  }, [threadId, usesSharedQueue]);

  useEffect(() => {
    if (usesSharedQueue) return;
    const load = () => {
      try {
        const raw = localStorage.getItem(pivotSkipStorageKey(threadId));
        setSkip(new Set(raw ? (JSON.parse(raw) as string[]) : []));
      } catch { setSkip(new Set()); }
    };
    load();
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string }>).detail;
      if (!d || d.threadId === threadId) load();
    };
    window.addEventListener("swarmbot:pivot-skip-changed", onChanged as EventListener);
    return () => window.removeEventListener("swarmbot:pivot-skip-changed", onChanged as EventListener);
  }, [threadId, usesSharedQueue]);

  const artifactsById = useMemo(() => new Map(artifacts.map((a) => [a.id, a] as const)), [artifacts]);

  const items = useMemo<NextStepItem[]>(() => {
    if (queue) return queue.items;
    return buildWorkbenchQueue({ artifacts, seedValue: seed.value, reportPivots, skipSet: skip, queriedSet: queriedTargets, reviews: review.map });
  }, [queue, artifacts, seed.value, reportPivots, skip, queriedTargets, review.map]);

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

  if (queue?.status === "error") return <div role="status" className="p-5 text-sm">Next pivots could not be refreshed. Case data, review decisions or tool history are unavailable. <button type="button" onClick={() => void queue.refresh()}>Retry</button></div>;
  if (queue?.status === "loading") return <p role="status" className="p-5 text-sm" aria-busy="true">Refreshing next pivots…</p>;
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
  if (items.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-muted-foreground">No pivot is waiting. New ones appear as the investigation records selectors or the agent recommends them.</p>;
  }

  const run = (p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt },
    }));
  };

  return (
    <div data-workbench-next className="p-3">
      {!hasPivotRunner(threadId) && (
        <p className="border-b border-border-subtle px-5 py-2 text-[12.5px] text-muted-foreground">
          Pivots run from the Investigate tab. Open this case in the workspace to run them.
        </p>
      )}
      <NextSteps
        items={items}
        onRunPivot={run}
        onRunAction={() => {}}
        openKey={open}
        onOpenChange={setOpen}
        connections={connections}
        artifactsById={artifactsById}
        onOpenGraph={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "graph" } }))}
      />
    </div>
  );
}
