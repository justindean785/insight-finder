import { supabase } from "@/integrations/supabase/client";
import type { ReviewState } from "@/lib/review";

/**
 * analyst-feedback.ts — client writer for the immutable analyst-feedback event
 * log (ground-truth capture milestone).
 *
 * This is INSTRUMENTATION ONLY: it appends a durable record of what the analyst
 * did. It never changes confidence, tiers, clusters, or orchestration, and it is
 * strictly best-effort — every failure is swallowed so an event-log hiccup can
 * never break the review UX. The write goes through the SECURITY DEFINER RPC
 * `record_analyst_feedback`, which derives analyst_id from auth.uid() and
 * enforces thread/artifact ownership server-side (the client-supplied identity is
 * never trusted).
 */

/**
 * Version tag stamped on every feedback event so calibration can be recomputed
 * per confidence-model generation (historical reproducibility). BUMP THIS
 * whenever the confidence computation changes materially. `baseline` = the
 * pre-consolidation four-systems model audited 2026-07-17.
 */
export const CONFIDENCE_MODEL_VERSION = "2026-07-17.baseline";

export type AnalystAction =
  | "confirm" | "key" | "recheck" | "dismiss" | "wrong" | "reject"
  | "merge" | "split" | "corrected_entity"
  | "accept_pivot" | "reject_pivot" | "manual_tool_selection";

/** Map a review state to its canonical feedback action. null/new = retraction (not logged). */
export function actionForReviewState(state: ReviewState | null): AnalystAction | null {
  switch (state) {
    case "confirmed": return "confirm";
    case "key": return "key";
    case "recheck": return "recheck";
    case "dismissed": return "dismiss";
    case "wrong": return "wrong";
    default: return null; // "new" / null → the analyst cleared their judgment
  }
}

export interface AnalystFeedbackInput {
  threadId: string;
  artifactId?: string | null;
  action: AnalystAction;
  priorState?: string | null;
  resultingState?: string | null;
  reason?: string | null;
  confidenceBefore?: number | null;
  confidenceAfter?: number | null;
  sourceLineage?: Record<string, unknown>;
}

// Supabase generated types don't yet include this RPC (types.ts lags the
// migration). A thin structural cast keeps typecheck green without `any`.
type FeedbackRpc = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
};

/**
 * Append one analyst-feedback event. Best-effort and non-blocking: resolves to
 * true on success, false on any failure (never throws). Confidence is unchanged.
 */
export async function recordAnalystFeedback(input: AnalystFeedbackInput): Promise<boolean> {
  try {
    const client = supabase as unknown as FeedbackRpc;
    const { error } = await client.rpc("record_analyst_feedback", {
      _thread_id: input.threadId,
      _artifact_id: input.artifactId ?? null,
      _action: input.action,
      _prior_state: input.priorState ?? null,
      _resulting_state: input.resultingState ?? null,
      _reason: input.reason ?? null,
      _confidence_before: input.confidenceBefore ?? null,
      _confidence_after: input.confidenceAfter ?? null,
      _confidence_model_version: CONFIDENCE_MODEL_VERSION,
      _source_lineage: input.sourceLineage ?? {},
    });
    if (error) {
      // Intentionally quiet: instrumentation must never surface as a UX error.
      if (import.meta.env?.DEV) console.debug("[analyst-feedback] rpc error:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    if (import.meta.env?.DEV) console.debug("[analyst-feedback] threw:", e);
    return false;
  }
}
