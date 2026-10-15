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

/**
 * ## Skipping a preflight whose answer cannot matter (measured 2026-09-30)
 *
 * The preflight is a serial chat/completions round trip on the path to the first
 * streamed byte: two attempts of up to 12s each plus a 250ms back-off. Its only job
 * is to decide a pivot. With the pivot target `gemini-direct` and the switch above
 * OFF, no outcome can pivot, so the probe's whole output is a log line. In that
 * window, 9 of 230 production runs (4%) waited 24.5s or more between the user
 * message insert and the run start (orchestrator_invocations, 2026-09-11 → 09-30),
 * consistent with both attempts timing out.
 *
 * So the probe now runs only when its result could move the run. The decision is
 * DERIVED from `shouldPivotOnPreflight` with a canonical explicit failure, so the
 * two can never disagree about which targets are pivotable.
 *
 * Kill switch `DEEPSEEK_PREFLIGHT_ALWAYS=true`, read at CALL TIME, restores the
 * probe on every request.
 */
export const DEEPSEEK_PREFLIGHT_ALWAYS_ENV = "DEEPSEEK_PREFLIGHT_ALWAYS";

/** Operator switch, read at CALL TIME. Default OFF: skip a preflight that cannot pivot. */
export function deepseekPreflightAlways(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env(DEEPSEEK_PREFLIGHT_ALWAYS_ENV) ?? "").trim().toLowerCase() === "true";
}

/** Could ANY preflight outcome move the run onto `target`? */
export function preflightCanPivot(
  target: { provider: string } | null,
  geminiPivotEnabled: boolean,
): boolean {
  return shouldPivotOnPreflight({ ok: false, status: 503 }, target, geminiPivotEnabled);
}

/** Run the preflight only when its result could change routing, unless the operator forces it. */
export function shouldRunPreflight(
  target: { provider: string } | null,
  geminiPivotEnabled: boolean,
  always: boolean,
): boolean {
  if (!target) return false;
  return always || preflightCanPivot(target, geminiPivotEnabled);
}

export type FallbackProvider = "lovable-gateway" | "gemini-direct" | "anthropic";

/**
 * Which provider takes a fallback turn. This IS the precedence `index.ts` builds
 * `fallbackTarget` from, so `/health` reports the target routing actually resolves
 * rather than re-deriving it from the switches alone (Codex P2 on #657): a pinned
 * Lovable gateway first, then Anthropic when it is GLM's backup (E2b), then direct
 * Gemini, then the Lovable gateway only when the operator opted in with
 * ALLOW_LOVABLE_FALLBACK.
 *
 * `anthropicFallback` is `anthropicFallbackEligible(...)` (orchestrator_select.ts): true
 * only when the primary is the GLM/deepseek slot, the key is configured, the model accepts
 * forced tool_choice and ANTHROPIC_FALLBACK_DISABLED is off. Omitted/false = the pre-E2b
 * chain, unchanged. `shouldPivotOnPreflight` gates only `gemini-direct`, so with an
 * Anthropic target an explicit preflight failure (HTTP >= 400) pivots and the preflight
 * runs again; a timeout (status 0) still never pivots.
 */
export function resolveFallbackProvider(c: {
  orchestratorProvider: string;
  hasLovableGateway: boolean;
  hasGeminiDirect: boolean;
  allowLovableFallback: boolean;
  anthropicFallback?: boolean;
}): FallbackProvider | null {
  if (c.orchestratorProvider === "lovable" && c.hasLovableGateway) return "lovable-gateway";
  if (c.anthropicFallback) return "anthropic";
  if (c.hasGeminiDirect) return "gemini-direct";
  if (c.hasLovableGateway && c.allowLovableFallback) return "lovable-gateway";
  return null;
}

/**
 * `/health` detail for `checks.preflight_policy`. Its PRESENCE proves this build is
 * live. Derived from `shouldRunPreflight` with the same inputs request routing uses,
 * so it can never claim a probe runs when routing skips it, or the reverse.
 */
export function preflightPolicyHealthDetail(
  target: { provider: string } | null,
  always: boolean,
  geminiPivotEnabled: boolean,
): string {
  if (!target) return "preflight skipped: no fallback configured, nothing to pivot to";
  const fb = `fallback=${target.provider}`;
  if (!shouldRunPreflight(target, geminiPivotEnabled, always)) {
    return `preflight skipped: no outcome can pivot (${fb}, gemini-direct pivot disabled)`;
  }
  if (!preflightCanPivot(target, geminiPivotEnabled)) {
    return `preflight runs on every request (${DEEPSEEK_PREFLIGHT_ALWAYS_ENV}=true), but cannot pivot (${fb}, gemini-direct pivot disabled)`;
  }
  return always
    ? `preflight runs on every request (${DEEPSEEK_PREFLIGHT_ALWAYS_ENV}=true); a failure can pivot (${fb})`
    : `preflight runs: a failure can pivot (${fb})`;
}

/** `/health` detail for `checks.preflight_pivot`. Its PRESENCE proves this build is live. */
export function preflightPivotHealthDetail(enabled: boolean): string {
  return enabled
    ? `preflight failure → gemini-direct pivot ENABLED via ${GEMINI_PREFLIGHT_PIVOT_ENV}`
    : "preflight failure keeps the primary (gemini-direct pivot disabled)";
}
