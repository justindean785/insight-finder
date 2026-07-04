/**
 * Interprets the osint-agent `?health=1` pre-flight probe response into a
 * scan-blocking decision. Extracted from ChatWindow's send() so the two-check
 * (orchestrator vs. core) precedence and the 503-with-bad-body edge case are
 * unit-testable without mounting the chat component.
 *
 * Bug this fixes: the toast used to read ONLY checks.orchestrator.detail, so a
 * core failure (e.g. a missing SUPABASE_ANON_KEY) fell back to a generic
 * message even though checks.core.detail had the real reason. It also treated
 * a non-JSON body the same for every status, letting a 503-but-unparseable
 * response through — a 503 is a definitive not-ready signal on its own and
 * should block regardless of body shape.
 */
export interface ReadinessCheck {
  ok: boolean;
  detail?: string;
}

export interface ReadinessBody {
  ok?: boolean;
  checks?: {
    orchestrator?: ReadinessCheck;
    core?: ReadinessCheck;
  };
}

export type ReadinessDecision =
  | { block: false }
  | { block: true; message: string };

const GENERIC_NOT_READY = "Scan backend is not ready (required secret missing).";

/**
 * `body` is `null` when the response body failed to parse as JSON.
 * `status` is the probe's HTTP status code (404 is handled by the caller
 * before this is reached — only 503/200/other should arrive here).
 */
export function interpretReadinessProbe(status: number, body: ReadinessBody | null): ReadinessDecision {
  if (body == null) {
    // Unparseable body. A 503 is a definitive not-ready signal on its own —
    // block regardless of body shape. Any other status (e.g. 200 with an
    // unknown/legacy shape) is treated as "deployed but unknown shape" and
    // let through, matching prior behavior.
    return status === 503 ? { block: true, message: GENERIC_NOT_READY } : { block: false };
  }
  if (body.ok !== false) return { block: false };
  const failed = body.checks?.orchestrator?.ok === false
    ? body.checks.orchestrator
    : body.checks?.core?.ok === false
      ? body.checks.core
      : undefined;
  const message = failed?.detail ? `Scan backend is not ready: ${failed.detail}` : GENERIC_NOT_READY;
  return { block: true, message };
}
