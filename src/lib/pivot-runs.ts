import { useEffect, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { normalizeTarget } from "@/lib/next-step-cards";

/**
 * Pivots this tab has started, so a card can say "Running" and then "Completed"
 * instead of offering "Run now" on a pivot the agent is already working.
 *
 * WHY. A pivot had two states, new | searched, and "searched" only arrives once a
 * tool_usage_log row names the exact target — late, or never when the agent's
 * tool inputs spell the target differently. Production 2026-10-26: the case read
 * Analyzing on kcreech@drvhome.com while its card still said "No tool has run
 * against it yet" and offered Run now.
 *
 * Written at the two places a pivot actually starts (the run-pivot bus, after its
 * dispatch guard and submit lock, and Auto-run's pick), so a refused pivot is
 * never recorded. Per tab (sessionStorage): it is this analyst's recent action,
 * not case state, and nothing else reads it as evidence.
 */
export type PivotRun = {
  /** `type:normalizedValue` — the identity the dispatch guard uses. */
  key: string;
  target: string;
  targetType: string;
  action: string;
  sentAt: string;
  origin: "manual" | "auto";
};

export type PivotRunView = {
  run: PivotRun;
  phase: "running" | "done";
  /** Rows created after this pivot was sent and before the next one was, newest
   *  first. "Since it was sent", not "found by it": the agent can wander. */
  newRows: Artifact[];
};

const MAX_RUNS = 20;
const CHANGED = "swarmbot:pivot-runs-changed";
const storageKey = (threadId: string) => `swarmbot:pivot-runs:${threadId}`;

export function pivotRunKey(type: string | null | undefined, value: string): string {
  return `${(type ?? "").toLowerCase()}:${normalizeTarget(value)}`;
}

export function readPivotRuns(threadId: string): PivotRun[] {
  try {
    const raw = sessionStorage.getItem(storageKey(threadId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PivotRun[]).filter((r) => r && typeof r.key === "string" && typeof r.sentAt === "string") : [];
  } catch {
    return [];
  }
}

export function recordPivotRun(threadId: string, run: PivotRun): void {
  const next = [...readPivotRuns(threadId).filter((r) => r.key !== run.key), run].slice(-MAX_RUNS);
  try {
    sessionStorage.setItem(storageKey(threadId), JSON.stringify(next));
  } catch {
    // Storage blocked: the dispatch already happened; only the card's state is lost.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { threadId } }));
}

export function usePivotRuns(threadId: string): PivotRun[] {
  const [runs, setRuns] = useState<PivotRun[]>(() => readPivotRuns(threadId));
  useEffect(() => {
    setRuns(readPivotRuns(threadId));
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string }>).detail;
      if (!d || d.threadId === threadId) setRuns(readPivotRuns(threadId));
    };
    window.addEventListener(CHANGED, onChanged as EventListener);
    return () => window.removeEventListener(CHANGED, onChanged as EventListener);
  }, [threadId]);
  return runs;
}

/**
 * Only the most recently sent pivot can be running, and only while the case is.
 * Each pivot's window runs from its own send to the next pivot's send.
 */
export function derivePivotRunViews(
  runs: readonly PivotRun[],
  { caseRunning, artifacts }: { caseRunning: boolean; artifacts: readonly Artifact[] },
): PivotRunView[] {
  const ordered = [...runs].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const views = ordered.map((run, i): PivotRunView => {
    const from = Date.parse(run.sentAt);
    const until = i + 1 < ordered.length ? Date.parse(ordered[i + 1].sentAt) : Infinity;
    const newRows = artifacts
      .filter((a) => {
        const t = Date.parse(a.created_at);
        return t >= from && t < until;
      })
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { run, phase: caseRunning && i === ordered.length - 1 ? "running" : "done", newRows };
  });
  return views.reverse();
}
