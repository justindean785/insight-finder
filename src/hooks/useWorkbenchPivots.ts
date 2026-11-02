import { useEffect, useMemo, useState } from "react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { queriedTargetSet, useThreadQueriedCalls } from "@/hooks/useThreadQueriedTargets";
import { useThreadPivotAttempts } from "@/hooks/useThreadPivotAttempts";
import { useReviewStates } from "@/lib/review";
import type { NextStepItem } from "@/components/pivots/NextSteps";
import { computePivots } from "@/lib/pivot-engine";
import { cardDedupeKey } from "@/lib/next-step-cards";
import type { RecommendedPivot } from "@/lib/recommended-pivots";
import { readPivotSkip, PIVOT_SKIP_EVENT } from "@/lib/pivot-skip";
import { pivotEligibility, pivotSuggestionInput, validatePivotSuggestion } from "@/lib/pivot-schema";
import { WORKBENCH_RUNNABLE_LIMIT } from "@/lib/next-step-queue";
import { derivePivotRunViews, pivotRunKey, usePivotRuns } from "@/lib/pivot-runs";

const REPAIR_LIMIT = 3;

/**
 * The Workbench's ranked pivot queue: one engine, one validation, one eligibility
 * check, shared by the Next tab and the Live board so the two can never disagree.
 * (Moved out of `WorkbenchNext` unchanged, plus the ended-run ordering below.)
 */
export function useWorkbenchPivots(threadId: string) {
  const { snapshot } = useCaseSnapshot();
  const review = useReviewStates(threadId);
  const queriedCalls = useThreadQueriedCalls(threadId);
  const queriedTargets = useMemo(() => queriedTargetSet(queriedCalls), [queriedCalls]);
  const attempts = useThreadPivotAttempts(threadId);
  const pivotRuns = usePivotRuns(threadId);
  const artifacts = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const caseRunning = snapshot?.run?.state === "running";
  const runViews = useMemo(
    () => derivePivotRunViews(pivotRuns, { caseRunning, artifacts, queriedCalls }),
    [pivotRuns, caseRunning, artifacts, queriedCalls],
  );
  // A pivot this tab started leaves the queue while it runs or once a tool call
  // was recorded against it (shown above the queue as Running / Completed), so
  // the next one becomes the best pivot. An ended run with no such call returns
  // to the queue (whether it ran is unknown), but behind every fresh pivot, so
  // it cannot come straight back as the best one (JD, 2026-11-02).
  const sentKeys = useMemo(
    () => new Set(runViews.filter((v) => v.phase !== "ended").map((v) => v.run.key)),
    [runViews],
  );
  const endedKeys = useMemo(
    () => new Set(runViews.filter((v) => v.phase === "ended").map((v) => v.run.key)),
    [runViews],
  );
  const seed = useMemo(() => snapshot?.seed ?? { value: null, type: null, caseTitle: null }, [snapshot?.seed]);
  const [reportPivots, setReportPivots] = useState<RecommendedPivot[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());

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
    const load = () => setSkip(readPivotSkip(threadId));
    load();
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string }>).detail;
      if (!d || d.threadId === threadId) load();
    };
    window.addEventListener(PIVOT_SKIP_EVENT, onChanged as EventListener);
    return () => window.removeEventListener(PIVOT_SKIP_EVENT, onChanged as EventListener);
  }, [threadId]);

  const artifactsById = useMemo(() => new Map(artifacts.map((a) => [a.id, a] as const)), [artifacts]);

  const items = useMemo<NextStepItem[]>(() => {
    const reviewOf = (id: string) => review.map[id] ?? "new";
    const ranked = computePivots({ artifacts, seedValue: seed.value, reportPivots, skipSet: skip, queriedSet: queriedTargets, reviews: review.map, attempts });
    const out: NextStepItem[] = [];
    const repair: NextStepItem[] = [];
    const seen = new Set<string>();
    let runnable = 0;
    const open = ranked.filter((c) => c.status === "new" && !sentKeys.has(pivotRunKey(c.type, c.value)));
    const wasSent = (c: (typeof open)[number]) => endedKeys.has(pivotRunKey(c.type, c.value));
    for (const p of [...open.filter((c) => !wasSent(c)), ...open.filter(wasSent)]) {
      if (runnable >= WORKBENCH_RUNNABLE_LIMIT) break;
      const key = cardDedupeKey({ title: p.actionLabel, target: p.value });
      if (seen.has(key)) continue;
      seen.add(key);
      const validation = validatePivotSuggestion(pivotSuggestionInput(p));
      if (validation.status !== "valid") {
        if (repair.length < REPAIR_LIMIT) repair.push({ kind: "pivot", key, validation, eligibility: null });
        continue;
      }
      runnable++;
      out.push({
        kind: "pivot",
        key,
        validation,
        eligibility: pivotEligibility(validation.pivot, { artifactsById, review: reviewOf }),
        rationale: p.rationale,
      });
    }
    return [...out, ...repair];
  }, [artifacts, seed.value, reportPivots, skip, queriedTargets, review.map, artifactsById, attempts, sentKeys, endedKeys]);

  return { snapshot, review, artifacts, artifactsById, caseRunning, runViews, seed, skip, items };
}
