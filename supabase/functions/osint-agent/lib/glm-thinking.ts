/**
 * Thinking-mode resolution for the lead ("deepseek") orchestrator slot.
 *
 * WHY THIS EXISTS. The slot is vendor-agnostic (DEEPSEEK_BASE_URL) and is currently
 * served by Z.AI GLM. Z.AI's thinking-mode contract is NOT uniform across model ids:
 *
 *   - GLM-5.2 / 5.1 / 5 / 4.7 — thinking is ON by default and MAY be disabled with
 *     `thinking: { type: "disabled" }`. That is what this orchestrator has always sent.
 *   - GLM-5.3 / 5.3-Flash / 5.3-FlashX — thinking is FORCED. Z.AI's own migration
 *     notice (docs.z.ai/guides/llm/glm-5.3) is explicit: "If your application currently
 *     uses thinking.type: 'disabled', please change it to 'enabled' and set
 *     reasoning_effort to 'low' before updating the model ID to glm-5.3. Otherwise,
 *     the request WILL FAIL."
 *
 * So pointing DEEPSEEK_ORCHESTRATOR_MODEL_ID at any 5.3 model WITHOUT this resolver
 * 400s every orchestrator call and every /health canary. The model id alone is a
 * secret-only change; making the slot accept a 5.3 model is a code change, and this
 * is it.
 *
 * WHAT WE DELIBERATELY DO NOT SEND: `clear_thinking`. On the STANDARD API endpoint
 * (api.z.ai/api/paas/v4 — ours) Preserved Thinking is OFF by default, so the server
 * clears prior reasoning and the client never has to echo `reasoning_content` back.
 * That matters: index.ts disabled thinking in the first place because round-tripping
 * `reasoning_content` through @ai-sdk/openai-compatible's multi-round STREAMED tool
 * calls is unproven here. Leaving `clear_thinking` at its default keeps that risk off
 * the table. Z.AI's published "recommended settings" for 5.3-Flash
 * (`reasoning_effort: max`, `clear_thinking: false`) are tuned for long-horizon coding
 * agents and are the WRONG settings for a 90s-wall-clock OSINT orchestrator — do not
 * copy them.
 *
 * Pure: no env reads, no I/O, so the whole matrix is unit-testable.
 */

export type ThinkingType = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

/** Provider-specific request fields for the deepseek slot. Forwarded verbatim by
 * @ai-sdk/openai-compatible getArgs, which spreads providerOptions[providerName] into
 * the body and consumes only `user` / `reasoningEffort` / `textVerbosity`. We use
 * SNAKE_case `reasoning_effort` on purpose so it passes through untouched — the same
 * verified lever `parallel_tool_calls` already rides on. */
export interface DeepseekThinkingOptions {
  thinking: { type: ThinkingType };
  reasoning_effort?: ReasoningEffort;
}

export interface ThinkingResolution {
  options: DeepseekThinkingOptions;
  /** True when the MODEL ID forces thinking on (the 5.3 family). */
  forcedByModel: boolean;
  /** Where the decision came from — surfaced on /health as the proof key. */
  source: "override" | "model-forced" | "default";
}

/**
 * Model ids whose thinking mode CANNOT be disabled. Anchored and guarded against a
 * longer numeric tail so a hypothetical `glm-5.31` does not silently inherit the rule.
 * A model not matched here keeps today's behaviour (thinking disabled); if a FUTURE
 * Z.AI model also forces thinking, DEEPSEEK_THINKING_MODE=enabled switches it without
 * a deploy — that is the point of the override.
 */
const FORCED_THINKING_MODEL_RE = /^glm-5\.3(?![0-9])/i;

export function modelForcesThinking(modelId: string | null | undefined): boolean {
  return FORCED_THINKING_MODEL_RE.test((modelId ?? "").trim());
}

const EFFORTS: readonly ReasoningEffort[] = ["low", "high", "max"];

/** Parse DEEPSEEK_REASONING_EFFORT. Unrecognised/blank -> "low", the value Z.AI's own
 * migration notice prescribes and the only one that respects a 90s finalize budget. */
export function parseReasoningEffort(raw: string | null | undefined): ReasoningEffort {
  const v = (raw ?? "").trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : "low";
}

/**
 * Resolve the thinking options for one deepseek-slot request.
 *
 * `modeOverride` is the kill switch (DEEPSEEK_THINKING_MODE), and it cuts BOTH ways:
 *   "disabled" forces today's pre-5.3 shape back on a running build (recovery if a
 *   5.3 switch misbehaves and the operator wants 5.2 semantics immediately), and
 *   "enabled" opts a model this file does not recognise into forced-thinking mode.
 * Anything else (unset, blank, "auto") means: decide from the model id.
 */
export function resolveDeepseekThinking(input: {
  modelId: string | null | undefined;
  modeOverride?: string | null;
  effort?: string | null;
}): ThinkingResolution {
  const forcedByModel = modelForcesThinking(input.modelId);
  const override = (input.modeOverride ?? "").trim().toLowerCase();

  let type: ThinkingType;
  let source: ThinkingResolution["source"];
  if (override === "enabled" || override === "disabled") {
    type = override;
    source = "override";
  } else if (forcedByModel) {
    type = "enabled";
    source = "model-forced";
  } else {
    type = "disabled";
    source = "default";
  }

  // reasoning_effort is only meaningful when the model is actually reasoning. Sending
  // it alongside type:"disabled" is at best ignored and at worst a 400 on a vendor
  // that validates the pair, so it is omitted entirely in that branch.
  return type === "enabled"
    ? { options: { thinking: { type }, reasoning_effort: parseReasoningEffort(input.effort) }, forcedByModel, source }
    : { options: { thinking: { type } }, forcedByModel, source };
}

/**
 * SDK-shaped provider options for `providerOptions.deepseek`.
 *
 * ⚠️ WHY THIS EXISTS AND WHY IT IS NOT THE WIRE SHAPE. `DeepseekThinkingOptions` above
 * is the WIRE body, correct for the raw `fetch` probes. It is WRONG for the AI SDK.
 * @ai-sdk/openai-compatible@1 builds its request body as (dist/index.mjs ~:369-377):
 *
 *     ...Object.fromEntries(Object.entries(providerOptions[name]).filter(
 *       ([key]) => !Object.keys(openaiCompatibleProviderOptions.shape).includes(key))),
 *     reasoning_effort: compatibleOptions.reasoningEffort,
 *
 * The spread carries an unrecognised snake_case `reasoning_effort` through — and then
 * the very next line OVERWRITES it with `compatibleOptions.reasoningEffort`, which is
 * parsed from the CAMELCASE `reasoningEffort` key. Pass snake_case and the value is
 * replaced by `undefined` and dropped by JSON.stringify: the request silently goes out
 * at the vendor's DEFAULT effort (`max` on GLM-5.3) — the opposite of the wall-clock
 * safeguard — while the raw-fetch /health canary still reports `low`, so the instrument
 * lies about the thing it exists to prove.
 *
 * `thinking` has no such collision (it is not in the SDK's schema shape), so it rides
 * the spread unchanged in both shapes. Only the effort key has to be translated.
 *
 * Caught by Codex on #938. The `parallel_tool_calls` precedent in index.ts is sound —
 * it is genuinely unrecognised — but it does NOT generalise to a key the SDK derives.
 */
export interface DeepseekThinkingSdkOptions {
  thinking: { type: ThinkingType };
  reasoningEffort?: ReasoningEffort;
}

export function toSdkProviderOptions(o: DeepseekThinkingOptions): DeepseekThinkingSdkOptions {
  return o.reasoning_effort
    ? { thinking: o.thinking, reasoningEffort: o.reasoning_effort }
    : { thinking: o.thinking };
}

/**
 * Output-token ceiling for a /health or preflight PROBE.
 *
 * The probes send `max_tokens: 4` — enough for a one-token "ping" reply when the model
 * is not reasoning. With thinking forced on (GLM-5.3) the reasoning tokens are produced
 * BEFORE any answer, so a 4-token ceiling can truncate the response before a single
 * content token exists, or be rejected outright. A probe that fails for its own
 * token budget would read as "the orchestrator is down". Raised only when thinking is
 * on, so the cheap non-thinking ping is unchanged.
 */
export const PROBE_MAX_TOKENS_THINKING = 64;
export const PROBE_MAX_TOKENS_PLAIN = 4;

export function probeMaxTokens(o: DeepseekThinkingOptions): number {
  return o.thinking.type === "enabled" ? PROBE_MAX_TOKENS_THINKING : PROBE_MAX_TOKENS_PLAIN;
}

/**
 * One-line description for /health and logs. Never includes a key or a secret.
 *
 * `vendorHost` is included because the slot is named "deepseek" for historical reasons
 * (it predates the move to Z.AI) while actually being served by api.z.ai. Until this,
 * /health said only `selected_provider: "deepseek"` and NOTHING anywhere named the real
 * vendor — the only proof was an `orchestrator_invocations.model_id` row written AFTER a
 * run. For the instrument a deploy is verified with, that is a gap: "which vendor is this
 * build actually talking to" should be answerable from /health alone.
 */
export function describeThinking(r: ThinkingResolution, modelId: string, vendorHost?: string): string {
  const effort = r.options.reasoning_effort ? `, reasoning_effort=${r.options.reasoning_effort}` : "";
  const where = vendorHost ? ` @ ${vendorHost}` : "";
  return `${modelId}${where}: thinking=${r.options.thinking.type}${effort} (${r.source})`;
}
