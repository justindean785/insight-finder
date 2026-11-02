import { useEffect, useMemo, useRef, useState } from "react";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useReviewStates } from "@/lib/review";
import type { ReviewAdjustment } from "@/lib/intel";
import {
  assessArtifacts, diffAssessments,
  type AgentAssessment, type AssessmentDelta, type AssessmentReport,
} from "@/lib/agent-assessment";

/**
 * The case's agent assessment (R2 engine) plus the "since the previous
 * assessment" baseline the Finding panel's delta line needs.
 *
 * The baseline is the assessment as it stood when the latest run STARTED, kept
 * per thread in localStorage. So "+12 linkage since the previous assessment"
 * means: this run moved the figure by 12. Before any run has been observed on
 * this device there is no baseline, and every delta is null — the panel then
 * says why confidence "is limited", never a fabricated change.
 *
 * Reviews are passed to the engine for the cluster call only (see
 * agent-assessment.ts); the analyst's own verdict is read by the surface, not
 * folded into these numbers.
 */
export interface AgentAssessmentApi {
  report: AssessmentReport | null;
  deltas: Record<string, AssessmentDelta>;
  /** True once a baseline exists for this thread on this device. */
  hasBaseline: boolean;
  get: (artifactId: string) => AgentAssessment | null;
  delta: (artifactId: string) => AssessmentDelta | null;
}

const KEY = (threadId: string) => `swarmbot:assessment-baseline:${threadId}`;

type StoredBaseline = { v: 1; at: string; byId: Record<string, Pick<AgentAssessment, "subjectLinkage" | "findingSupport" | "group">> };

function readBaseline(threadId: string): StoredBaseline | null {
  try {
    const raw = localStorage.getItem(KEY(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredBaseline;
    return parsed && parsed.v === 1 && parsed.byId && typeof parsed.byId === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeBaseline(threadId: string, byId: Record<string, AgentAssessment>): StoredBaseline | null {
  const slim: StoredBaseline["byId"] = {};
  for (const [id, a] of Object.entries(byId)) slim[id] = { subjectLinkage: a.subjectLinkage, findingSupport: a.findingSupport, group: a.group };
  const stored: StoredBaseline = { v: 1, at: new Date().toISOString(), byId: slim };
  try {
    localStorage.setItem(KEY(threadId), JSON.stringify(stored));
  } catch {
    // Storage can be full or blocked; the delta line is then simply absent.
  }
  return stored;
}

export function useAgentAssessment(threadId: string): AgentAssessmentApi {
  // Optional: surfaces that also render standalone (tests, the read-only case
  // view) have no provider and then simply get no assessment.
  const snapshot = useOptionalCaseSnapshot()?.snapshot ?? null;
  const review = useReviewStates(threadId);
  const items = useMemo(() => snapshot?.items ?? [], [snapshot?.items]);
  const seedValue = snapshot?.seed.value ?? null;
  const running = snapshot?.hydrated === true && snapshot.run.state === "running";

  const reviews = useMemo(() => {
    const m: Record<string, ReviewAdjustment> = {};
    for (const a of items) {
      const r = review.map[a.id];
      if (r && r !== "new") m[a.id] = r;
    }
    return m;
  }, [items, review.map]);

  const report = useMemo(
    () => (snapshot?.hydrated ? assessArtifacts(items, seedValue, reviews) : null),
    [snapshot?.hydrated, items, seedValue, reviews],
  );

  const [baseline, setBaseline] = useState<StoredBaseline | null>(() => readBaseline(threadId));
  useEffect(() => { setBaseline(readBaseline(threadId)); }, [threadId]);

  // A run starting is the moment to remember "before": the next completed
  // reading is then compared against it. Only on the transition, never on every
  // render while running, so the baseline is not overwritten mid-run.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current && report) {
      setBaseline(writeBaseline(threadId, report.byId));
    }
    wasRunning.current = running;
  }, [running, report, threadId]);

  const deltas = useMemo(() => {
    if (!report) return {};
    if (!baseline) return diffAssessments(null, report.byId);
    const prev: Record<string, AgentAssessment> = {};
    for (const [id, b] of Object.entries(baseline.byId)) prev[id] = { ...report.byId[id], ...b } as AgentAssessment;
    return diffAssessments(prev, report.byId);
  }, [report, baseline]);

  return {
    report,
    deltas,
    hasBaseline: baseline !== null,
    get: (id) => report?.byId[id] ?? null,
    delta: (id) => deltas[id] ?? null,
  };
}
