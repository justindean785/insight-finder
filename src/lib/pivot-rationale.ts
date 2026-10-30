import type { PivotType } from "@/lib/intel";
import type { AttemptSummary } from "@/lib/pivot-attempts";

/**
 * Why a pivot ranks where it does, in plain words. PURE and READ-ONLY: it
 * explains the order `computePivots` already produced and never changes it, and
 * it never touches finding confidence, authority or linkage.
 *
 * Terms used here are deliberately not probabilities. There is no calibrated
 * yield or cost model yet, so the rationale states what was observed (prior
 * attempts, the gap a lead might close) and reports cost as unknown.
 */
export type PivotGap = "new_records" | "corroboration" | "contradiction" | "repeated";

export type PivotRationale = {
  /** The investigative question this pivot would answer. */
  question: string;
  /** Which gap running it could close. */
  gap: PivotGap;
  /** Prior attempts against the selector, in plain sentences. */
  previous: string;
  /** Repeated: two or more live ok runs, all with the same tool. A repeat, not a new angle. */
  repeated: boolean;
  /** Short sentences naming what moved the rank, highest-impact first. */
  factors: string[];
  /** Cost and latency are unknown until a per-tool estimate is measured. */
  cost: "unknown";
};

const QUESTION: Partial<Record<PivotType, string>> = {
  email: "Does this address belong to the subject?",
  username: "Does this handle belong to the subject?",
  phone: "Does this number belong to the subject?",
  wallet: "Does this wallet connect to the subject?",
  name: "Is this name the subject, or a namesake?",
  domain: "What does this domain connect the subject to?",
  url: "What does this page connect the subject to?",
  ip: "Who operates this address?",
};

/** The question a pivot answers, by selector type. */
export function investigativeQuestion(type: PivotType): string {
  return QUESTION[type] ?? "What does this lead add to the case?";
}

/**
 * Repeated: two or more live runs that succeeded, all with the same single tool.
 * Cached replays and failures do not count. A repeat of one tool is not a new
 * angle, but a success is what makes it a repeat rather than a retry.
 *
 * Yield-based exhaustion ("ran it twice and nothing came of it") is NOT computed
 * here: the tool log does not record what a call returned, and no artifact is
 * linked to the run that produced it. That needs lineage, which is a later stage.
 */
export function isRepeated(att: AttemptSummary | undefined): boolean {
  return !!att && att.okCount >= 2 && att.tools.length === 1;
}

function previousSentence(att: AttemptSummary | undefined): string {
  if (!att) return "None recorded.";
  if (att.liveCount === 0) {
    return att.cachedCount > 0 ? "Only cached replays; no live run." : "None recorded.";
  }
  const runs = `${att.liveCount} live ${att.liveCount === 1 ? "run" : "runs"}`;
  const outcome = `${att.okCount} ok, ${att.failedCount} failed`;
  const tools = att.tools.length > 0 ? ` (${att.tools.join(", ")})` : "";
  return `${runs}, ${outcome}${tools}.`;
}

export function buildRationale(input: {
  type: PivotType;
  gap: PivotGap;
  attempts: AttemptSummary | undefined;
  factors: string[];
}): PivotRationale {
  return {
    question: investigativeQuestion(input.type),
    gap: input.gap,
    previous: previousSentence(input.attempts),
    repeated: isRepeated(input.attempts),
    factors: input.factors.slice(0, 4),
    cost: "unknown",
  };
}
