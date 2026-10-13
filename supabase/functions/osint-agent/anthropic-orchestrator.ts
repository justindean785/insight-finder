// anthropic-orchestrator.ts — pure helpers for running the lead orchestrator on the
// Anthropic (Claude) API. No Deno, env or network imports, so every rule here is unit
// testable from both Deno and vitest. The provider itself (createAnthropic) is built in
// env.ts; index.ts wires these helpers into the existing streamText loop.
//
// Why this exists as its own module: Claude spends FINITE PREPAID CREDITS (the operator
// holds a promotional balance), unlike the flat-rate providers the loop was tuned on.
// So this file owns the things that protect that balance — prompt-cache placement, a hard
// per-run budget that force-finalizes, terminal handling of credit exhaustion — and it
// touches NO evidence-integrity logic (confidence caps, authority, quarantine).

import { anthropicCostMicroUsd, anthropicRatesFor, type AnthropicUsageTokens } from "./costs.ts";

// ---- Model selection -----------------------------------------------------------------

/**
 * Default model: `claude-sonnet-5` ($2 in / $10 out per MTok), NOT the newer
 * `claude-sonnet-5-5`, on purpose. This loop forces a tool call in two places that are
 * termination invariants (`toolChoice: "required"` in the opening phase and in the
 * finalize persistence/memory phases — see CLAUDE.md "Run-termination invariants").
 * Anthropic rejects forced `tool_choice` (`any` / `tool`) with a 400 on Sonnet 5.5,
 * Opus 5.5, Fable 5.1 and Mythos 5.1, so on those models the run would die at its first
 * step. Sonnet 5 accepts it and is priced identically to 5.5. Verified against
 * platform.claude.com model docs on 2026-10-13; override with ANTHROPIC_MODEL_ID.
 */
export const ANTHROPIC_DEFAULT_MODEL_ID = "claude-sonnet-5";

/** Strip a trailing `-YYYYMMDD` snapshot suffix and lowercase, for table lookups. */
export function normalizeAnthropicModelId(id: string): string {
  return id.trim().toLowerCase().replace(/-\d{8}$/, "");
}

export function resolveAnthropicModelId(raw: string | undefined | null): { id: string; source: "env" | "default" } {
  const v = (raw ?? "").trim();
  return v ? { id: v, source: "env" } : { id: ANTHROPIC_DEFAULT_MODEL_ID, source: "default" };
}

/** Models that 400 on forced tool_choice (`any` / `tool`). Prefix match so dated ids still hit. */
const FORCED_TOOL_CHOICE_REJECTED = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"];

export function anthropicModelRejectsForcedToolChoice(modelId: string): boolean {
  const n = normalizeAnthropicModelId(modelId);
  return FORCED_TOOL_CHOICE_REJECTED.some((m) => n === m || n.startsWith(`${m}-`));
}

// ---- Provider options ----------------------------------------------------------------

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function parseAnthropicEffort(raw: string | undefined | null): AnthropicEffort | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max" ? v : null;
}

/**
 * `providerOptions.anthropic` for the orchestrator.
 *  - Serial tool calls: the loop's long-standing invariant (ORCHESTRATOR_PARALLEL_TOOL_CALLS
 *    = false; parallel calls truncated mid-stream orphaned results -> MissingToolResults).
 *  - Thinking OFF by default, like the DeepSeek canary: thinking tokens bill as output, and
 *    the SDK would otherwise round-trip reasoning blocks across every step. The operator can
 *    opt in with ANTHROPIC_THINKING=adaptive. (Sonnet 5 accepts `disabled`; the models that
 *    reject it also reject forced tool choice and are refused earlier.)
 *  - `effort` only when the operator set ANTHROPIC_EFFORT.
 * Caching is NOT set here: it rides on the system block (see `splitCachedSystem`).
 */
export function anthropicProviderOptions(opts: { thinking: "disabled" | "adaptive"; effort: AnthropicEffort | null }) {
  return {
    anthropic: {
      disableParallelToolUse: true,
      thinking: { type: opts.thinking },
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
  };
}

export function parseAnthropicThinking(raw: string | undefined | null): "disabled" | "adaptive" {
  return (raw ?? "").trim().toLowerCase() === "adaptive" ? "adaptive" : "disabled";
}

// ---- Prompt caching ------------------------------------------------------------------

export interface CachedSystemBlock {
  role: "system";
  content: string;
  providerOptions?: { anthropic: { cacheControl: { type: "ephemeral" } } };
}

/**
 * Split the per-step system string into [stable base, volatile directive] and put the
 * cache breakpoint on the base.
 *
 * Anthropic renders `tools` -> `system` -> `messages`, so one breakpoint at the end of the
 * stable system block caches the tool definitions AND the base prompt together (the ~100k
 * chars of tool schemas + static prompt re-sent every step). The per-step directive
 * (intermediate / persistence-nudge / finalize phase) is appended AFTER the breakpoint so
 * it can change every step without invalidating the cache. The growing message history is
 * deliberately NOT cached: prepareStep re-summarizes older tool results as they age out of
 * the recent window, so a message-level breakpoint would pay the 1.25x write premium on a
 * prefix that never reads back.
 *
 * If `full` does not start with `base` (should not happen) it is sent uncached rather than
 * mis-split.
 */
export function splitCachedSystem(full: string, base: string): CachedSystemBlock[] {
  if (!base || !full.startsWith(base)) return [{ role: "system", content: full }];
  const blocks: CachedSystemBlock[] = [{
    role: "system",
    content: base,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  }];
  const tail = full.slice(base.length);
  if (tail) blocks.push({ role: "system", content: tail });
  return blocks;
}

// ---- Usage + cost --------------------------------------------------------------------

export interface StepUsage extends AnthropicUsageTokens {
  /** Every input token the step was billed for: uncached + cache reads + cache writes. */
  totalInput: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Normalise AI SDK v6 `usage` (+ Anthropic `providerMetadata`) into the four billable
 * buckets. In the SDK `inputTokens` is the TOTAL (uncached + read + write), so the uncached
 * remainder is `noCacheTokens` — NOT `inputTokens`. Billing `inputTokens` at the input rate
 * on top of cache reads would double-charge the cached span. Falls back to the raw
 * Anthropic usage block and the deprecated `cachedInputTokens` when the details are absent.
 */
export function extractAnthropicUsage(usage: unknown, providerMetadata?: unknown): StepUsage {
  const u = (usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  const raw = ((providerMetadata as { anthropic?: { usage?: Record<string, unknown>; cacheCreationInputTokens?: unknown } } | undefined)
    ?.anthropic) ?? {};
  const rawUsage = raw.usage ?? {};
  const d = u.inputTokenDetails ?? {};

  const cacheRead = num(d.cacheReadTokens) || num(u.cachedInputTokens) || num(rawUsage.cache_read_input_tokens);
  const cacheWrite = num(d.cacheWriteTokens) || num(rawUsage.cache_creation_input_tokens) || num(raw.cacheCreationInputTokens);
  const total = num(u.inputTokens);
  const noCacheExplicit = d.noCacheTokens;
  const input = typeof noCacheExplicit === "number" && noCacheExplicit >= 0
    ? noCacheExplicit
    : Math.max(0, total - cacheRead - cacheWrite);
  const output = num(u.outputTokens);
  return { input, output, cacheRead, cacheWrite, totalInput: input + cacheRead + cacheWrite };
}

/** Billable micro-USD for one step (see costs.ts for the rate table). */
export function stepCostMicroUsd(modelId: string, usage: StepUsage): number {
  return anthropicCostMicroUsd(modelId, usage);
}

// ---- Hard per-run budget -------------------------------------------------------------

/**
 * Per-invocation ceilings. History trimming (TOTAL_PROMPT_CHAR_BUDGET) already bounds a
 * single turn, but a run is up to MAX_ORCHESTRATOR_STEPS turns, so the TOTAL input is what
 * actually spends credits. When either ceiling is crossed the loop is forced into the
 * existing finalize state machine at the next step boundary — it still writes its report,
 * it just stops investigating.
 *
 * Counts every input token the API billed for including cache reads, which is deliberately
 * conservative (a cache read costs 10% / 5% of an uncached token) so the guard bounds the
 * WORK done, not just the price.
 */
export const ANTHROPIC_DEFAULT_RUN_INPUT_TOKEN_BUDGET = 1_500_000;
/** $2.00 per invocation — ~50 full runs from a $100 balance even at the ceiling. */
export const ANTHROPIC_DEFAULT_RUN_COST_CEILING_MICRO_USD = 2_000_000;

export function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface RunBudgetLimits {
  maxInputTokens: number;
  maxCostMicroUsd: number;
}

export interface RunBudgetTotals {
  inputTokens: number;
  costMicroUsd: number;
}

export function runBudgetExhausted(
  totals: RunBudgetTotals,
  limits: RunBudgetLimits,
): { exhausted: boolean; reason: "input_tokens" | "cost" | null } {
  if (totals.inputTokens >= limits.maxInputTokens) return { exhausted: true, reason: "input_tokens" };
  if (totals.costMicroUsd >= limits.maxCostMicroUsd) return { exhausted: true, reason: "cost" };
  return { exhausted: false, reason: null };
}

/**
 * The report-salvage backstop is a separate model request made after the loop. It is allowed a
 * BOUNDED overrun of the ceilings (it exists to guarantee the analyst gets a report): the run's
 * spend PLUS the request's own worst case must stay under 1.5x either ceiling, otherwise it is
 * skipped and the run ends visibly Interrupted.
 *
 * Admission RESERVES the request's worst case rather than comparing only what is already spent
 * (Codex P2 on #748): a run just under the line would otherwise start a request that finishes
 * well over it, and with small operator-set limits one salvage could exceed the ceiling many
 * times over. The reserve is the prompt priced as uncached input, plus the request's full output
 * cap priced as output.
 *
 * The input side is a deliberate UPPER BOUND, not an average (Codex P2 on #748): one token per
 * UTF-16 code unit. Real tokenizers run ~3-4 characters per token even on URLs, hashes and
 * non-Latin text, so this over-reserves several-fold; at default limits that costs ~$0.10 of
 * headroom, which is the right side to err on for a finite credit balance.
 */
export const ANTHROPIC_SALVAGE_HEADROOM = 1.5;

export interface SalvageReserve {
  /** Upper-bound input tokens of the salvage prompt (system + prompt): 1 token per UTF-16 code unit. */
  inputTokens: number;
  /** Worst-case micro-USD of the request: estimated input at the uncached rate + max output tokens. */
  costMicroUsd: number;
}

/** Reserve for a salvage request: input bounded at 1 token per UTF-16 code unit, output at its full cap. */
export function salvageReserve(modelId: string, promptChars: number, maxOutputTokens: number): SalvageReserve {
  const inputTokens = Math.ceil(Math.max(0, promptChars));
  return {
    inputTokens,
    costMicroUsd: anthropicCostMicroUsd(modelId, { input: inputTokens, output: maxOutputTokens, cacheRead: 0, cacheWrite: 0 }),
  };
}

export function salvageWithinBudget(totals: RunBudgetTotals, limits: RunBudgetLimits, reserve: SalvageReserve): boolean {
  return totals.inputTokens + reserve.inputTokens <= limits.maxInputTokens * ANTHROPIC_SALVAGE_HEADROOM &&
    totals.costMicroUsd + reserve.costMicroUsd <= limits.maxCostMicroUsd * ANTHROPIC_SALVAGE_HEADROOM;
}

// ---- Error classification ------------------------------------------------------------

export type AnthropicFailureKind =
  | "credit_exhausted"
  | "auth_failed"
  | "permission_denied"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "context_overflow"
  | "invalid_request"
  | "unknown";

export interface AnthropicFailure {
  kind: AnthropicFailureKind;
  /** True only for transient classes the SDK's bounded retry can legitimately resolve. */
  retryable: boolean;
  /** True when no amount of waiting fixes it: a person must act (top up, rotate key, fix config). */
  operatorActionRequired: boolean;
  /** Fixed, analyst-visible text. Never echoes the provider body (it can echo the request). */
  message: string;
}

const SAVED = "Your partial results were saved.";

/**
 * Map an Anthropic failure to the project's structured failure classes. Reads only the
 * HTTP status and the SDK-composed message (Anthropic's `error.message`, which carries the
 * human reason such as "Your credit balance is too low…"); returns FIXED text so nothing
 * from a response body reaches an analyst-visible or persisted string.
 *
 * Credit exhaustion is checked BEFORE the generic 400 branch: Anthropic reports it as
 * `400 invalid_request_error`, which the SDK treats as non-retryable. It must surface as a
 * terminal, clearly-labelled failure — never retried and never failed over to another
 * provider (the caller has no fallback path for it).
 */
export function classifyAnthropicError(error: unknown): AnthropicFailure {
  const e = (error ?? {}) as { statusCode?: unknown; message?: unknown; name?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  const msg = (typeof e.message === "string" ? e.message : String(error ?? "")).toLowerCase();

  if (status === 402 || /credit balance is too low|insufficient (credit|fund)|purchase credits|plans\s*&\s*billing|billing/.test(msg)) {
    return {
      kind: "credit_exhausted", retryable: false, operatorActionRequired: true,
      message: `The Anthropic API credit balance is exhausted. The run was stopped and was not retried or moved to another provider. ${SAVED} Add credits at platform.claude.com (Billing), or unset ORCHESTRATOR_PROVIDER to return to the default orchestrator.`,
    };
  }
  if (status === 401 || /invalid x-api-key|authentication_error|invalid api key/.test(msg)) {
    return {
      kind: "auth_failed", retryable: false, operatorActionRequired: true,
      message: `Anthropic rejected the API key (401). ${SAVED} An operator needs to check ANTHROPIC_API_KEY.`,
    };
  }
  if (status === 403 || /permission_error|not allowed|forbidden/.test(msg)) {
    return {
      kind: "permission_denied", retryable: false, operatorActionRequired: true,
      message: `Anthropic denied access to this model or workspace (403). ${SAVED} An operator needs to check the key's workspace and the ANTHROPIC_MODEL_ID.`,
    };
  }
  if (status === 429 || /rate_limit_error|rate.?limit/.test(msg)) {
    return {
      kind: "rate_limited", retryable: true, operatorActionRequired: false,
      message: `Anthropic is rate-limiting this key (429); bounded retries were exhausted. ${SAVED} Please retry in a minute.`,
    };
  }
  if (status === 529 || /overloaded/.test(msg)) {
    return {
      kind: "overloaded", retryable: true, operatorActionRequired: false,
      message: `Anthropic is overloaded (529); bounded retries were exhausted. ${SAVED} Please retry shortly.`,
    };
  }
  if (status != null && status >= 500) {
    return {
      kind: "server_error", retryable: true, operatorActionRequired: false,
      message: `Anthropic had a server error (HTTP ${status}). ${SAVED} Please retry shortly.`,
    };
  }
  if (status === 413 || /prompt is too long|exceeds? the (maximum|context)|too many tokens|context (window|length)/.test(msg)) {
    return {
      kind: "context_overflow", retryable: false, operatorActionRequired: false,
      message: `This investigation exceeded the model's context limit. ${SAVED} Try a narrower follow-up.`,
    };
  }
  if (status === 400 || /invalid_request_error/.test(msg)) {
    return {
      kind: "invalid_request", retryable: false, operatorActionRequired: true,
      message: `Anthropic rejected the request as invalid (HTTP 400). ${SAVED} This is a configuration or integration fault, not a transient error — check ANTHROPIC_MODEL_ID and the edge logs.`,
    };
  }
  return {
    kind: "unknown", retryable: false, operatorActionRequired: false,
    message: `The Anthropic orchestrator failed unexpectedly. ${SAVED}`,
  };
}

// ---- /health -------------------------------------------------------------------------

export interface AnthropicHealthInput {
  keyPresent: boolean;
  /** Normalised ORCHESTRATOR_PROVIDER pin ("" when unset). */
  pin: string;
  /** What selectOrchestratorProvider actually chose. */
  selectedProvider: string;
  modelId: string;
  modelSource: "env" | "default";
  thinking: "disabled" | "adaptive";
  effort: AnthropicEffort | null;
  limits: RunBudgetLimits;
}

/**
 * `checks.orchestrator_anthropic`. Reports configured / pinned / selected / model id and the
 * cost-control posture. The key is NEVER an input to anything but a boolean, so it cannot
 * appear in the output; a regression test asserts the serialized check contains no
 * secret-shaped string. No network probe: a probe would spend credits on every /health.
 */
export function anthropicOrchestratorHealth(i: AnthropicHealthInput) {
  const pinnedAnthropic = i.pin === "anthropic" || i.pin === "claude";
  const selected = i.selectedProvider === "anthropic";
  const forcedToolOk = !anthropicModelRejectsForcedToolChoice(i.modelId);
  const pricingKnown = anthropicRatesFor(i.modelId).known;
  const problems: string[] = [];
  if (pinnedAnthropic && !i.keyPresent) problems.push("pinned_but_key_missing (selector falls back to the default orchestrator)");
  if (i.keyPresent && !forcedToolOk) problems.push("model_rejects_forced_tool_choice (runs would 400 at step 1)");
  if (i.keyPresent && !pricingKnown) problems.push("model_not_in_rate_table (metered at the highest known rate)");
  const configured = i.keyPresent;
  return {
    ok: problems.length === 0,
    configured,
    pinned: pinnedAnthropic,
    selected,
    model_id: i.modelId,
    model_source: i.modelSource,
    forced_tool_choice_supported: forcedToolOk,
    pricing_known: pricingKnown,
    thinking: i.thinking,
    effort: i.effort ?? "model-default",
    prompt_caching: "system+tools prefix (5m ephemeral)",
    run_input_token_budget: i.limits.maxInputTokens,
    run_cost_ceiling_micro_usd: i.limits.maxCostMicroUsd,
    detail: problems.length
      ? problems.join("; ")
      : !configured
      ? "inactive: ANTHROPIC_API_KEY not set (default orchestrator unchanged)"
      : selected
      ? "active: orchestrator is Anthropic"
      : "configured but not selected (set ORCHESTRATOR_PROVIDER=anthropic to use it)",
  };
}
