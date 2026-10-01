/**
 * preflight-pivot — whether a failed orchestrator PREFLIGHT may move the whole run
 * onto the fallback provider.
 *
 * ## The failure this closes (measured 2026-09-24 against orchestrator_invocations)
 *
 * When the DeepSeek-slot preflight (`index.ts`, the "ping" to Z.AI glm-5.2) answers
 * with an explicit HTTP >= 400, the run pivots to `gemini-direct`
 * (gemini-2.5-flash on Gemini's OpenAI-compatible endpoint). That fallback had
 * finished **0 of 16** runs since telemetry began: 15 died on "Bad Request" and 1
 * on "Too Many Requests", every one at step 0, across four days and prompt sizes
 * from 45k to 289k chars. That was 7 of 65 invocations (10.8%) in the week
 * measured. The same key succeeds on `gemini_deep_dork` and `gemini_vision`, so the
 * key is not the fault. The likely cause is the tool-bearing request shape, which the
 * preflight's tool-less "ping" can never exercise. It is not reproduced here.
 *
 * So the pivot turned a preflight error (often a transient 429/5xx the real call's
 * own retries could survive) into a guaranteed dead run. Until the Gemini request
 * is fixed and proven, a failed preflight KEEPS the primary instead.
 *
 * ## Scope, deliberately narrow
 *
 * - Only the PREFLIGHT pivot to `gemini-direct` is gated. The overflow pivot
 *   (`deepseekWouldOverflow`, >3M chars; unreachable under the 220k ceiling) and
 *   the operator-pinned / opted-in Lovable gateway paths are unchanged.
 * - Re-enable with `GEMINI_PREFLIGHT_PIVOT_ENABLED=true`, read at CALL TIME, once a
 *   tool-bearing Gemini request is shown to succeed.
 *
 * Zero imports on purpose: pure, and testable without the request graph.
 */

export const GEMINI_PREFLIGHT_PIVOT_ENV = "GEMINI_PREFLIGHT_PIVOT_ENABLED";

/** Operator switch, read at CALL TIME. Default OFF: the pivot target has never completed a run. */
export function geminiPreflightPivotEnabled(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env(GEMINI_PREFLIGHT_PIVOT_ENV) ?? "").trim().toLowerCase() === "true";
}

/**
 * Should a preflight result move the run onto `target`?
 *
 * Same ambiguity policy as before for the probe itself: only an explicit HTTP
 * failure (status >= 400) ever pivots; a timeout (status 0) never does. What is new
 * is that `gemini-direct` must also be explicitly enabled.
 */
export function shouldPivotOnPreflight(
  probe: { ok: boolean; status: number },
  target: { provider: string } | null,
  geminiPivotEnabled: boolean,
): boolean {
  if (probe.ok || probe.status < 400 || !target) return false;
  if (target.provider === "gemini-direct" && !geminiPivotEnabled) return false;
  return true;
}

/** `/health` detail for `checks.preflight_pivot`. Its PRESENCE proves this build is live. */
export function preflightPivotHealthDetail(enabled: boolean): string {
  return enabled
    ? `preflight failure → gemini-direct pivot ENABLED via ${GEMINI_PREFLIGHT_PIVOT_ENV}`
    : "preflight failure keeps the primary (gemini-direct pivot disabled)";
}
