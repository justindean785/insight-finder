/**
 * orchestrator-fallback — Anthropic is the BACKUP orchestrator behind GLM (E2b).
 *
 * ## Operator decision (JD, 2026-10-15)
 *
 * GLM-5.2 (provider slot "deepseek", base URL api.z.ai) stays the PRIMARY. Anthropic
 * (claude-sonnet-5, anthropic-orchestrator.ts) becomes the BACKUP. Before this, the only
 * fallback behind GLM was gemini-direct, whose preflight pivot is switched off because it
 * finished 0 of 16 runs, so there was effectively NO working backup.
 *
 * ## Measured (orchestrator_invocations, 2026-10-11 .. 10-14)
 *
 * GLM: 41 clean runs and 2 runs that died at step 0 with "Failed after 3 attempts. Last
 * error: Insufficient balance or no resource package" (Z.AI out of balance). That is the
 * case this module exists for: the run never started, so moving it costs nothing.
 *
 * ## WHEN Anthropic takes over — and when it never does
 *
 *  1. PREFLIGHT (index.ts, lib/preflight-pivot.ts): Anthropic being armed does NOT make the
 *     preflight run — that decision is exactly the pre-E2b one (shouldRunDeepseekPreflight),
 *     because the probe costs 24.5s+ in ~4% of runs and is redundant with (2). When it runs
 *     anyway (DEEPSEEK_PREFLIGHT_ALWAYS, gemini pivot enabled), an explicit HTTP >= 400 moves
 *     the invocation onto Anthropic. A timeout never does (unchanged policy).
 *  2. FIRST MODEL CALL (this module, `createStartFallbackModel`): the real step-0 request to
 *     GLM fails with a START failure — insufficient balance / quota (402, or the Z.AI balance
 *     message on a 429), auth (401/403), rate limit or 5xx once the SDK's bounded retries are
 *     spent, or a connection failure — AND GLM has not accepted any request in this
 *     invocation AND no tool has been admitted. The same request is then sent to Anthropic
 *     and the invocation stays there (sticky).
 *  3. NEVER mid-run. Once GLM has accepted one request, or a tool has been admitted, an error
 *     ends the run exactly as before. Switching provider after tools ran is the termination
 *     danger zone (CLAUDE.md "Run-termination invariants"); a LATER invocation of the same
 *     thread may start on Anthropic if GLM is still failing, which is fine.
 *
 * Nothing here touches toolChoice, stopWhen, the finalize state machine or the completion
 * contract: the wrapper only decides which provider answers a request the loop already made.
 *
 * Kill switch ANTHROPIC_FALLBACK_DISABLED=true, read at CALL time, restores the pre-E2b
 * chain (gemini-direct -> Lovable gateway) and disarms the start fallback on a running build.
 */

import { wrapLanguageModel } from "npm:ai@6";
import { sanitizeAnthropicPrompt } from "../message-sanitize.ts";

export const ANTHROPIC_FALLBACK_DISABLED_ENV = "ANTHROPIC_FALLBACK_DISABLED";

/** Operator switch, read at CALL TIME. Default OFF: Anthropic is GLM's backup. */
export function anthropicFallbackDisabled(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  try {
    return (env(ANTHROPIC_FALLBACK_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * streamText's default `maxRetries` is 2, so one step makes at most 3 attempts. index.ts does
 * not override it. The retry wrapper re-enters the model's doStream on each attempt, which is
 * how the start fallback counts them.
 */
export const ORCHESTRATOR_SDK_MAX_ATTEMPTS = 3;

export type StartFailureClass =
  | "insufficient_balance"
  | "auth"
  | "rate_limited"
  | "server_error"
  | "connection"
  | "other";

export interface StartFailure {
  cls: StartFailureClass;
  status: number | null;
  /** The provider error's own `isRetryable`, when it states one. */
  retryable: boolean | null;
}

const BALANCE_RE =
  /insufficient balance|no resource package|recharge|insufficient_quota|exceeded your current quota|quota exceeded|credit balance is too low|余额不足|欠费/i;
const CONNECTION_RE =
  /cannot connect|fetch failed|network|econn(refused|reset)|etimedout|enotfound|connection (reset|refused|closed|error)|socket hang up|dns|tls|certificate/i;

/**
 * Classify a provider error thrown by the GLM model's doStream. Reads only the status code,
 * the error name, `isRetryable` and the message; never the response body.
 */
export function classifyStartFailure(error: unknown): StartFailure {
  const e0 = (error ?? {}) as Record<string, unknown>;
  // Be robust to a RetryError (the SDK's wrapper) reaching us: classify its last error.
  const e = (e0.lastError && typeof e0.lastError === "object" ? e0.lastError : e0) as Record<string, unknown>;
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  const msg = typeof e.message === "string" ? e.message : String(error ?? "");
  const name = typeof e.name === "string" ? e.name : "";
  const retryable = typeof e.isRetryable === "boolean" ? e.isRetryable : null;
  // A stop/abort is the analyst or the run, never a provider failure.
  if (name === "AbortError" || /aborted|abort/i.test(name)) return { cls: "other", status, retryable };
  if (status === 402 || BALANCE_RE.test(msg)) return { cls: "insufficient_balance", status, retryable };
  if (status === 401 || status === 403) return { cls: "auth", status, retryable };
  if (status === 429) return { cls: "rate_limited", status, retryable };
  if (status != null && status >= 500) return { cls: "server_error", status, retryable };
  if (status == null && (CONNECTION_RE.test(msg) || name === "TypeError")) {
    return { cls: "connection", status, retryable };
  }
  return { cls: "other", status, retryable };
}

/** The reason recorded on the invocation (model_id label + the orchestrator_fallback log). */
export function startFallbackReason(f: StartFailure): string {
  return `fallback:glm_${f.cls}`;
}

/** The reason recorded when the PREFLIGHT moved the run. */
export function preflightFallbackReason(status: number): string {
  if (status === 402) return "fallback:glm_preflight_insufficient_balance";
  if (status === 401 || status === 403) return "fallback:glm_preflight_auth";
  return `fallback:glm_preflight_http_${status}`;
}

/** The invocation's model_id label: the Anthropic model plus WHY it took the run. */
export function fallbackModelLabel(modelId: string, reason: string): string {
  return `${modelId} (Anthropic ${reason})`;
}

export interface StartFallbackDecisionInput {
  failure: StartFailure;
  /** 1-based attempt number of the request that just failed. */
  attempt: number;
  maxAttempts: number;
  /** Requests GLM has ACCEPTED in this invocation (doStream resolved). */
  primaryAccepted: number;
  /** Tools admitted in this invocation (live + reserved + any tool call recorded). */
  toolsAdmitted: number;
  /** ANTHROPIC_FALLBACK_DISABLED, read at call time. */
  disabled: boolean;
}

export interface StartFallbackDecision {
  fallback: boolean;
  why:
    | "kill_switch"
    | "tool_admitted"
    | "mid_run"
    | "not_a_start_failure"
    | "retry_primary"
    | "switch_now"
    | "not_retryable"
    | "retries_exhausted";
}

/** Pure: may THIS failure move the invocation onto Anthropic? */
export function decideStartFallback(i: StartFallbackDecisionInput): StartFallbackDecision {
  if (i.disabled) return { fallback: false, why: "kill_switch" };
  if (i.toolsAdmitted > 0) return { fallback: false, why: "tool_admitted" };
  if (i.primaryAccepted > 0) return { fallback: false, why: "mid_run" };
  if (i.failure.cls === "other") return { fallback: false, why: "not_a_start_failure" };
  // Waiting does not top up a balance or fix a key: move now and leave the SDK's remaining
  // retries to Anthropic.
  if (i.failure.cls === "insufficient_balance" || i.failure.cls === "auth") return { fallback: true, why: "switch_now" };
  // A transient class the SDK will NOT retry (it said so): this attempt is the last one.
  if (i.failure.retryable === false) return { fallback: true, why: "not_retryable" };
  if (i.attempt >= i.maxAttempts) return { fallback: true, why: "retries_exhausted" };
  return { fallback: false, why: "retry_primary" };
}

export interface StartFallbackState {
  switched: boolean;
  reason: string | null;
  primaryAccepted: number;
  attempts: number;
}

export interface StartFallbackEvent {
  reason: string;
  failure: StartFailure;
  attempt: number;
  why: StartFallbackDecision["why"];
}

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any;
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = any;

/**
 * `wrapLanguageModel` does NOT adapt a v2 model, and `@ai-sdk/openai-compatible@1` (the GLM
 * slot) is a v2 model: streamText adapts it itself when handed it directly, but a wrapped v2
 * model would leak v2 finish/usage shapes into a v3 stream and the loop would never run the
 * step's tools. So the wrapper adapts first, with a byte-for-byte copy of the SDK's own
 * (unexported) `asLanguageModelV3` conversion (ai@6 src/model/as-language-model-v3.ts), so
 * a GLM run through the wrapper meters, finishes and calls tools exactly as before.
 */
export function asLanguageModelV3Compat(model: AnyModel): AnyModel {
  if (!model || model.specificationVersion === "v3") return model;
  const finishReason = (r: unknown) => ({ unified: r === "unknown" ? "other" : r, raw: undefined });
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (u: any) => ({
    inputTokens: { total: u?.inputTokens, noCache: undefined, cacheRead: u?.cachedInputTokens, cacheWrite: undefined },
    outputTokens: { total: u?.outputTokens, text: undefined, reasoning: u?.reasoningTokens },
    raw: u?.totalTokens == null ? undefined : { totalTokens: u.totalTokens },
  });
  return new Proxy(model, {
    get(target, prop) {
      switch (prop) {
        case "specificationVersion":
          return "v3";
        case "doGenerate":
          return async (...args: unknown[]) => {
            const r = await target.doGenerate(...args);
            return { ...r, finishReason: finishReason(r.finishReason), usage: usage(r.usage) };
          };
        case "doStream":
          return async (...args: unknown[]) => {
            const r = await target.doStream(...args);
            return {
              ...r,
              stream: r.stream.pipeThrough(
                new TransformStream({
                  transform(chunk: AnyParams, controller) {
                    if (chunk?.type === "finish") {
                      controller.enqueue({ ...chunk, finishReason: finishReason(chunk.finishReason), usage: usage(chunk.usage) });
                    } else controller.enqueue(chunk);
                  },
                }),
              ),
            };
          };
        default:
          return target[prop];
      }
    },
  });
}

/**
 * Wrap the GLM model so a START failure re-sends the same request to Anthropic.
 *
 * - `fallbackParams` adapts the call options for the fallback (index.ts adds the
 *   `anthropic` providerOptions there, so the GLM request itself is not changed by a byte).
 * - Only `doStream` (the run's steps) can switch. `doGenerate` (the report salvage) follows a
 *   switch that already happened but never starts one.
 * - Sticky: after a switch every request in the invocation goes to Anthropic.
 */
export function createStartFallbackModel(o: {
  primary: AnyModel;
  fallback: AnyModel;
  fallbackParams?: (params: AnyParams) => AnyParams;
  maxAttempts?: number;
  toolsAdmitted: () => number;
  disabled?: () => boolean;
  onSwitch?: (ev: StartFallbackEvent) => void;
}): { model: AnyModel; state: StartFallbackState } {
  const state: StartFallbackState = { switched: false, reason: null, primaryAccepted: 0, attempts: 0 };
  const maxAttempts = o.maxAttempts ?? ORCHESTRATOR_SDK_MAX_ATTEMPTS;
  const adapt = (p: AnyParams) => (o.fallbackParams ? o.fallbackParams(p) : p);
  const fallback = asLanguageModelV3Compat(o.fallback);
  const model = wrapLanguageModel({
    model: asLanguageModelV3Compat(o.primary),
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }: AnyParams) => {
        if (state.switched) return await fallback.doStream(adapt(params));
        state.attempts++;
        try {
          const r = await doStream();
          state.primaryAccepted++;
          return r;
        } catch (error) {
          const failure = classifyStartFailure(error);
          let toolsAdmitted = 0;
          try {
            toolsAdmitted = o.toolsAdmitted();
          } catch {
            toolsAdmitted = Number.POSITIVE_INFINITY; // unknown -> never switch
          }
          const decision = decideStartFallback({
            failure,
            attempt: state.attempts,
            maxAttempts,
            primaryAccepted: state.primaryAccepted,
            toolsAdmitted,
            disabled: o.disabled ? o.disabled() : anthropicFallbackDisabled(),
          });
          if (!decision.fallback) throw error;
          state.switched = true;
          state.reason = startFallbackReason(failure);
          try {
            o.onSwitch?.({ reason: state.reason, failure, attempt: state.attempts, why: decision.why });
          } catch { /* observability must never fail the request */ }
          return await fallback.doStream(adapt(params));
        }
      },
      wrapGenerate: async ({ doGenerate, params }: AnyParams) => {
        if (state.switched) return await fallback.doGenerate(adapt(params));
        return await doGenerate();
      },
    },
  });
  return { model, state };
}

/**
 * The Anthropic orchestrator model with the Anthropic-bound prompt repair applied to every
 * request (message-sanitize.ts → sanitizeAnthropicPrompt). Used for the pinned primary AND
 * the fallback, so history another provider wrote never reaches Anthropic in a shape it
 * rejects. Other providers never pass through here.
 */
export function anthropicBoundModel(model: AnyModel): AnyModel {
  return wrapLanguageModel({
    model: asLanguageModelV3Compat(model),
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }: { params: AnyParams }) => ({
        ...params,
        prompt: sanitizeAnthropicPrompt(params.prompt),
      }),
    },
  });
}

/** `/health` → `checks.orchestrator_fallback`. Pure. Its PRESENCE proves the E2b build is live. */
export function orchestratorFallbackHealth(i: {
  primary: string;
  anthropicKey: boolean;
  modelAcceptsForcedToolChoice: boolean;
  disabled: boolean;
  /** resolveFallbackProvider's answer — the same target routing builds. */
  target: string | null;
}) {
  const glmPrimary = i.primary === "deepseek";
  const armed = i.target === "anthropic";
  let detail: string;
  if (armed) {
    detail = "anthropic is GLM's backup: a start failure on the first request before any tool " +
      "(balance/quota, 401/403, 429/5xx after retries, connection) moves that invocation to Anthropic; the preflight only pivots when it already runs; never mid-run";
  } else if (!glmPrimary) {
    detail = `inactive: primary is ${i.primary}, not the GLM (deepseek) slot`;
  } else if (i.disabled) {
    detail = `DISABLED via ${ANTHROPIC_FALLBACK_DISABLED_ENV} — pre-E2b chain (fallback=${i.target ?? "none"})`;
  } else if (!i.anthropicKey) {
    detail = `inactive: ANTHROPIC_API_KEY not set (fallback=${i.target ?? "none"})`;
  } else if (!i.modelAcceptsForcedToolChoice) {
    detail = `inactive: ANTHROPIC_MODEL_ID rejects forced tool_choice (fallback=${i.target ?? "none"})`;
  } else {
    detail = `inactive (fallback=${i.target ?? "none"})`;
  }
  return {
    // ok:false only when the operator WANTS a backup (GLM primary, key set) and it is not armed.
    ok: armed || !glmPrimary || !i.anthropicKey || i.disabled,
    primary: i.primary,
    fallback: i.target,
    anthropic_role: armed ? "fallback" : i.primary === "anthropic" ? "primary" : "inactive",
    kill_switch: i.disabled,
    detail,
  };
}
