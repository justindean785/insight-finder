import { useEffect, useMemo, useState } from "react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { useReviewStates } from "@/lib/review";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { computePivots } from "@/lib/pivot-engine";
import { cardDedupeKey } from "@/lib/next-step-cards";
import { buildEntityGraph } from "@/lib/entity-graph";
import { summarizeConnections } from "@/lib/connection-summary";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";
import { pivotEligibility, pivotSuggestionInput, validatePivotSuggestion, type RunnablePivot } from "@/lib/pivot-schema";
import { hasPivotRunner } from "@/lib/pivot-runner";
import type { ReviewAdjustment } from "@/lib/intel";
import { WORKBENCH_RUNNABLE_LIMIT } from "@/lib/next-step-queue";
import { derivePivotRunViews, pivotRunKey, usePivotRuns } from "@/lib/pivot-runs";

const RUNNABLE_LIMIT = WORKBENCH_RUNNABLE_LIMIT;
const REPAIR_LIMIT = 3;

/**
 * The Workbench's Next tab: the SAME compact list the Investigate transcript ends with (best pivot, the ones after
 * it, unrunnable suggestions behind one disclosure), built from the same engine, validation and eligibility, but
 * always in reach beside whatever tab you are reading. Every Run still opens its Preview first, and nothing is queued.
 * Unlike the transcript's rail it is not gated on the latest message being report-shaped, so it works from the case's
 * own recorded selectors too; it never offers the generic "ask the agent" prompts, which are a chat concern.
 */
export function WorkbenchNext({ threadId }: { threadId: string }) {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  const queriedTargets = useThreadQueriedTargets(threadId);
  const pivotRuns = usePivotRuns(threadId);
  const artifacts = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const caseRunning = snapshot?.run?.state === "running";
  const runViews = useMemo(
    () => derivePivotRunViews(pivotRuns, { caseRunning, artifacts, queriedTargets }),
    [pivotRuns, caseRunning, artifacts, queriedTargets],
  );
  // A pivot this tab started leaves the queue while it runs or once a tool call
  // was recorded against it (shown above the queue as Running / Completed), so
  // the next one becomes the best pivot. An ended run with no such call returns
  // to the queue: whether it ran is unknown.
  const sentKeys = useMemo(
    () => new Set(runViews.filter((v) => v.phase !== "ended").map((v) => v.run.key)),
    [runViews],
  );
  const seed = snapshot?.seed ?? { value: null, type: null };
  const [reportPivots, setReportPivots] = useState<RecommendedPivot[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const onReport = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; pivots: RecommendedPivot[] }>).detail;
      if (d?.threadId === threadId && Array.isArray(d.pivots)) setReportPivots(d.pivots);
    };
    window.addEventListener("swarmbot:report-pivots", onReport as EventListener);
    window.dispatchEvent(new CustomEvent("swarmbot:request-report-pivots", { detail: { threadId } }));
    return () => window.removeEventListener("swarmbot:report-pivots", onReport as EventListener);
  }, [threadId]);

  useEffect(() => {
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
  }, [threadId]);

  const artifactsById = useMemo(() => new Map(artifacts.map((a) => [a.id, a] as const)), [artifacts]);

  const items = useMemo<NextStepItem[]>(() => {
    const reviewOf = (id: string) => review.map[id] ?? "new";
    const ranked = computePivots({ artifacts, seedValue: seed.value, reportPivots, skipSet: skip, queriedSet: queriedTargets, reviews: review.map });
    const out: NextStepItem[] = [];
    const repair: NextStepItem[] = [];
    const seen = new Set<string>();
    let runnable = 0;
    for (const p of ranked.filter((c) => c.status === "new" && !sentKeys.has(pivotRunKey(c.type, c.value)))) {
      if (runnable >= RUNNABLE_LIMIT) break;
      const key = cardDedupeKey({ title: p.actionLabel, target: p.value });
      if (seen.has(key)) continue;
      seen.add(key);
      const validation = validatePivotSuggestion(pivotSuggestionInput(p));
      if (validation.status !== "valid") {
        if (repair.length < REPAIR_LIMIT) repair.push({ kind: "pivot", key, validation, eligibility: null });
        continue;
      }
      runnable++;
      out.push({ kind: "pivot", key, validation, eligibility: pivotEligibility(validation.pivot, { artifactsById, review: reviewOf }) });
    }
    return [...out, ...repair];
  }, [artifacts, seed.value, reportPivots, skip, queriedTargets, review.map, artifactsById, sentKeys]);

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
    return <p className="px-5 py-4 text-[13px] text-muted-foreground">No pivot is waiting. New ones appear as the investigation records selectors or the agent recommends them.</p>;
  }

  const run = (p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt, action: p.action },
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
        busy={caseRunning}
        runs={runViews}
        onViewChanges={(artifactId) => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "artifacts", artifactId } }))}
        openKey={open}
        onOpenChange={setOpen}
        connections={connections}
        artifactsById={artifactsById}
        onOpenGraph={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { tab: "graph" } }))}
      />
    </div>
  );
}
