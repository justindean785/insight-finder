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
 * Analyzing on person@example.test while its card still said "No tool has run
 * against it yet" and offered Run now.
 *
 * Written only once the send is accepted (`pivotSendHooks`): a refused pivot is
 * never recorded, and one whose send then fails is withdrawn, so it goes back to
 * the queue instead of leaving a Running card behind. Per tab (sessionStorage): it
 * is this analyst's recent action, not case state, and nothing else reads it as
 * evidence. A second tab or device does not see it.
 *
 * CLAIMS. "Completed" needs a recorded tool call against the target; an ended run
 * without one reads "Run ended", because the run may have been stopped, errored or
 * spent on other leads. The new-row count is a window, never "found by it", and it
 * is measured on server timestamps only (see `anchorCreatedAt`).
 */
export type PivotRun = {
  /** `type:normalizedValue` — the identity the dispatch guard uses. */
  key: string;
  target: string;
  targetType: string;
  action: string;
  /** Browser clock. Orders this tab's own sends and labels the card; never
   *  compared with a server timestamp. */
  sentAt: string;
  /** Newest `created_at` among the case's rows when the send was accepted (server
   *  clock), or null when the case had none. A row is new to this pivot when it
   *  is strictly newer than this, so browser clock skew cannot move the window. */
  anchorCreatedAt: string | null;
  origin: "manual" | "auto";
};

export type PivotRunView = {
  run: PivotRun;
  /** done = the run ended AND a tool call was recorded against the target;
   *  ended = the run ended with none (stopped, errored or spent elsewhere): unknown. */
  phase: "running" | "done" | "ended";
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
    return Array.isArray(parsed)
      ? (parsed as PivotRun[])
        .filter((r) => r && typeof r.key === "string" && typeof r.sentAt === "string")
        .map((r) => ({ ...r, anchorCreatedAt: typeof r.anchorCreatedAt === "string" ? r.anchorCreatedAt : null }))
      : [];
  } catch {
    return [];
  }
}

function writePivotRuns(threadId: string, runs: PivotRun[]): void {
  try {
    sessionStorage.setItem(storageKey(threadId), JSON.stringify(runs.slice(-MAX_RUNS)));
  } catch {
    // Storage blocked: the dispatch already happened; only the card's state is lost.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { threadId } }));
}

export function recordPivotRun(threadId: string, run: PivotRun): void {
  writePivotRuns(threadId, [...readPivotRuns(threadId).filter((r) => r.key !== run.key), run]);
}

/** Remove exactly this run (same key and send), e.g. when its send failed. */
export function withdrawPivotRun(threadId: string, run: Pick<PivotRun, "key" | "sentAt">): void {
  const runs = readPivotRuns(threadId);
  const next = runs.filter((r) => !(r.key === run.key && r.sentAt === run.sentAt));
  if (next.length !== runs.length) writePivotRuns(threadId, next);
}

/** Newest server `created_at` among the rows, or null. The window anchor. */
export function newestCreatedAt(artifacts: readonly Pick<Artifact, "created_at">[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const a of artifacts) {
    const t = Date.parse(a.created_at);
    if (Number.isFinite(t) && t > bestT) { bestT = t; best = a.created_at; }
  }
  return best;
}

/**
 * The hooks a send calls: `onAccepted` once the send is underway (records the
 * run, anchored to the rows the case has at that moment), `onFailed` if it then
 * fails (withdraws that same run). A send refused before acceptance calls
 * neither, so nothing is recorded.
 */
export function pivotSendHooks(
  threadId: string,
  pivot: { target: string; targetType: string | null | undefined; action: string; origin: PivotRun["origin"] },
  currentArtifacts: () => readonly Pick<Artifact, "created_at">[],
): { onAccepted: () => void; onFailed: () => void } {
  let recorded: PivotRun | null = null;
  return {
    onAccepted: () => {
      recorded = {
        key: pivotRunKey(pivot.targetType, pivot.target),
        target: pivot.target,
        targetType: pivot.targetType ?? "",
        action: pivot.action,
        sentAt: new Date().toISOString(),
        anchorCreatedAt: newestCreatedAt(currentArtifacts()),
        origin: pivot.origin,
      };
      recordPivotRun(threadId, recorded);
    },
    onFailed: () => {
      if (recorded) withdrawPivotRun(threadId, recorded);
      recorded = null;
    },
  };
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
 * Each pivot's window runs from its own anchor (exclusive) to the next pivot's
 * anchor (inclusive): both are server `created_at` values, so the browser clock
 * never enters the comparison. An ended run is "done" only when `queriedTargets`
 * (normalized targets from tool_usage_log, the set the pivot engine reads) holds
 * its target; otherwise "ended", which the card shows as unknown.
 */
export function derivePivotRunViews(
  runs: readonly PivotRun[],
  { caseRunning, artifacts, queriedTargets }: {
    caseRunning: boolean;
    artifacts: readonly Artifact[];
    queriedTargets: ReadonlySet<string>;
  },
): PivotRunView[] {
  const ordered = [...runs].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const anchorT = (r: PivotRun) => (r.anchorCreatedAt ? Date.parse(r.anchorCreatedAt) : -Infinity);
  const views = ordered.map((run, i): PivotRunView => {
    const from = anchorT(run);
    const until = i + 1 < ordered.length ? anchorT(ordered[i + 1]) : Infinity;
    const newRows = artifacts
      .filter((a) => {
        const t = Date.parse(a.created_at);
        return t > from && t <= until;
      })
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const phase = caseRunning && i === ordered.length - 1
      ? "running"
      : queriedTargets.has(normalizeTarget(run.target)) ? "done" : "ended";
    return { run, phase, newRows };
  });
  return views.reverse();
}
