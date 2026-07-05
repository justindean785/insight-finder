// minimax-preflight.ts — pure helpers for MiniMax health-probe → fallback gating.
// No Deno/network imports so vitest + deno test can both run these.

export type MinimaxPreflightProbe = { ok: boolean; status: number };

/**
 * Whether a failed MiniMax preflight probe should force the Lovable/Gemini fallback.
 *
 * A probe timeout is encoded as `{ ok: false, status: 0 }`. Timeouts are ambiguous
 * (slow cold start vs. truly down) and were causing every cold Supabase isolate to
 * skip MiniMax and bill the Lovable gateway instead — burning credits until 403
 * Forbidden. Only explicit HTTP failures (non-zero status) should pivot.
 */
export function shouldFallbackAfterMinimaxPreflight(probe: MinimaxPreflightProbe): boolean {
  if (probe.ok) return false;
  if (probe.status === 0) return false;
  return true;
}

export function minimaxPreflightFailureLabel(probe: MinimaxPreflightProbe): string {
  if (probe.ok) return "ok";
  return probe.status === 0 ? "timeout" : String(probe.status);
}
