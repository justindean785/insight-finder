import {
  describeAttention,
  OBSERVATION_RECENT_DAYS,
  type FailureClass,
  type ObservationSummary,
} from "@/lib/tool-observation-classes";

export interface OutcomeLesson {
  id: string;
  tool: string;
  observation: string;
  adaptation: string;
  failureClass: FailureClass | null;
  recentAttempts: number;
  recentFailures: number;
  sourceCases: number;
}

const ADAPTATION: Record<FailureClass, string> = {
  credential_plan:
    "Check plan access, permissions, and provider policy before another call. Corroborate through a source that does not share this credential.",
  transport:
    "Allow one later retry, then corroborate through an independent source instead of repeating the same failing call.",
  rate_limited:
    "Space subsequent calls and use an independent source when the limit persists.",
  input_rejected:
    "Validate the selector and input schema before retrying. Do not repeat a rejected call unchanged.",
  other:
    "Inspect the redacted failure detail and corroborate through an independent source before spending more attempts.",
};

/**
 * Deterministic, data-backed adaptations from observed live calls. Only the
 * existing cross-case attention threshold becomes a lesson; a single bad run
 * does not teach the agent a global rule. Nothing here changes evidence
 * confidence, identity, or analyst review state.
 */
export function deriveOutcomeLessons(summary: ObservationSummary, limit = 6): OutcomeLesson[] {
  return summary.tools
    .filter((tool) => tool.attention)
    .slice(0, Math.max(0, limit))
    .map((tool) => ({
      id: `outcome:${tool.tool}`,
      tool: tool.tool,
      observation: `${describeAttention(tool)} across ${tool.recent.threads} cases`,
      adaptation: tool.dominantClass
        ? ADAPTATION[tool.dominantClass]
        : `Review the failures across the last ${OBSERVATION_RECENT_DAYS} days before another attempt.`,
      failureClass: tool.dominantClass,
      recentAttempts: tool.recent.attempts,
      recentFailures: tool.recent.failed,
      sourceCases: tool.recent.threads,
    }));
}
