import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { CasePivotQueueContext, type CasePivotQueue } from "@/hooks/useCasePivotQueue";
import { useThreadQueriedTargetState } from "@/hooks/useThreadQueriedTargets";
import { useReviewStates } from "@/lib/review";
import { buildWorkbenchQueue } from "@/lib/next-step-queue";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";

/** One mounted owner survives tab/viewport changes; all consumers read one projection. */
export function CasePivotQueueProvider({ threadId, children }: { threadId: string; children: ReactNode }) {
  const { snapshot, refresh: refreshCase } = useCaseSnapshot();
  const queried = useThreadQueriedTargetState(threadId);
  const review = useReviewStates(threadId);
  const [recommendations, setRecommendations] = useState<RecommendedPivot[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  useEffect(() => {
    const onReport = (event: Event) => {
      const d = (event as CustomEvent<{ threadId: string; pivots: RecommendedPivot[] }>).detail;
      if (d?.threadId === threadId && Array.isArray(d.pivots)) setRecommendations(d.pivots);
    };
    const loadSkip = () => {
      try { setSkip(new Set(JSON.parse(localStorage.getItem(pivotSkipStorageKey(threadId)) || "[]"))); }
      catch { setSkip(new Set()); }
    };
    const onSkip = (event: Event) => {
      const d = (event as CustomEvent<{ threadId?: string }>).detail;
      if (!d?.threadId || d.threadId === threadId) loadSkip();
    };
    loadSkip();
    window.addEventListener("swarmbot:report-pivots", onReport);
    window.addEventListener("swarmbot:pivot-skip-changed", onSkip);
    window.dispatchEvent(new CustomEvent("swarmbot:request-report-pivots", { detail: { threadId } }));
    return () => {
      window.removeEventListener("swarmbot:report-pivots", onReport);
      window.removeEventListener("swarmbot:pivot-skip-changed", onSkip);
    };
  }, [threadId]);
  // Snapshot versions advance after completion/reconciliation, including manual refresh.
  const refreshTargets = queried.refresh;
  useEffect(() => { void refreshTargets(); }, [snapshot?.version, refreshTargets]);
  // Retry every prerequisite, including review decisions, not just tool history.
  const refresh = useCallback(async () => {
    await Promise.all([refreshCase(), refreshTargets()]);
  }, [refreshCase, refreshTargets]);
  const unavailable = queried.status === "error" || review.availability === "unavailable" || snapshot?.syncError;
  const loading = !snapshot?.hydrated || snapshot.syncing || queried.status === "loading" || review.availability === "unknown";
  const status: CasePivotQueue["status"] = unavailable ? "error" : loading ? "loading" : "ready";
  const value = useMemo<CasePivotQueue>(() => {
    const items = status === "ready" ? buildWorkbenchQueue({
      artifacts: snapshot?.items ?? [],
      seedValue: snapshot?.seed.value ?? null,
      reportPivots: recommendations,
      skipSet: skip,
      queriedSet: queried.targets,
      reviews: review.map,
    }) : [];
    const count = items.filter(i => i.kind === "pivot" && i.validation.status === "valid" && i.eligibility?.runnable).length;
    return { status, items, count, refresh };
  }, [status, snapshot?.items, snapshot?.seed.value, recommendations, skip, queried.targets, review.map, refresh]);
  return <CasePivotQueueContext.Provider value={value}>{children}</CasePivotQueueContext.Provider>;
}
