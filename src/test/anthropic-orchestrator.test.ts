import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_DEFAULT_MODEL_ID,
  anthropicModelRejectsForcedToolChoice,
  anthropicOrchestratorHealth,
  anthropicProviderOptions,
  classifyAnthropicError,
  extractAnthropicUsage,
  parsePositiveInt,
  resolveAnthropicModelId,
  runBudgetExhausted,
  splitCachedSystem,
} from "../../supabase/functions/osint-agent/anthropic-orchestrator.ts";

describe("model selection", () => {
  it("defaults to a Sonnet-class model that accepts forced tool choice", () => {
    expect(resolveAnthropicModelId(undefined)).toEqual({ id: ANTHROPIC_DEFAULT_MODEL_ID, source: "default" });
    expect(resolveAnthropicModelId("  ")).toEqual({ id: ANTHROPIC_DEFAULT_MODEL_ID, source: "default" });
    expect(anthropicModelRejectsForcedToolChoice(ANTHROPIC_DEFAULT_MODEL_ID)).toBe(false);
  });

  it("honours ANTHROPIC_MODEL_ID", () => {
    expect(resolveAnthropicModelId("claude-opus-5")).toEqual({ id: "claude-opus-5", source: "env" });
  });

  it("flags the models that 400 on forced tool_choice (finalize phases need it)", () => {
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-sonnet-5-5-20261001"]) {
      expect(anthropicModelRejectsForcedToolChoice(id), id).toBe(true);
    }
    for (const id of ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6"]) {
      expect(anthropicModelRejectsForcedToolChoice(id), id).toBe(false);
    }
  });
});

describe("provider options", () => {
  it("serial tool calls + thinking off by default, effort only when set", () => {
    expect(anthropicProviderOptions({ thinking: "disabled", effort: null }))
      .toEqual({ anthropic: { disableParallelToolUse: true, thinking: { type: "disabled" } } });
    expect(anthropicProviderOptions({ thinking: "adaptive", effort: "medium" }).anthropic)
      .toEqual({ disableParallelToolUse: true, thinking: { type: "adaptive" }, effort: "medium" });
  });
});

describe("prompt caching placement", () => {
  it("puts the breakpoint on the stable base and the per-step directive after it, uncached", () => {
    const blocks = splitCachedSystem("BASE+DIRECTIVE", "BASE");
    expect(blocks).toEqual([
      { role: "system", content: "BASE", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "system", content: "+DIRECTIVE" },
    ]);
  });

  it("emits a single cached block when there is no directive", () => {
    expect(splitCachedSystem("BASE", "BASE")).toHaveLength(1);
  });

  it("never mis-splits: an unrelated string is sent uncached", () => {
    expect(splitCachedSystem("OTHER", "BASE")).toEqual([{ role: "system", content: "OTHER" }]);
  });
});

describe("extractAnthropicUsage", () => {
  it("uses noCacheTokens as the uncached input (inputTokens is the TOTAL)", () => {
    expect(extractAnthropicUsage({
      inputTokens: 2110, outputTokens: 5,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 2000, cacheWriteTokens: 100 },
    })).toEqual({ input: 10, output: 5, cacheRead: 2000, cacheWrite: 100, totalInput: 2110 });
  });

  it("derives the uncached remainder when details are absent, from the raw Anthropic usage", () => {
    const u = extractAnthropicUsage(
      { inputTokens: 2110, outputTokens: 5 },
      { anthropic: { usage: { cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } } },
    );
    expect(u).toMatchObject({ input: 10, cacheRead: 2000, cacheWrite: 100, totalInput: 2110 });
  });

  it("is all-zero (never NaN) for a missing/garbage usage object", () => {
    for (const bad of [undefined, null, {}, { inputTokens: "x" }]) {
      expect(extractAnthropicUsage(bad)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0 });
    }
  });
});

describe("hard per-run budget", () => {
  const limits = { maxInputTokens: 1_000, maxCostMicroUsd: 500 };
  it("is open below both ceilings", () => {
    expect(runBudgetExhausted({ inputTokens: 999, costMicroUsd: 499 }, limits)).toEqual({ exhausted: false, reason: null });
  });
  it("trips on input tokens", () => {
    expect(runBudgetExhausted({ inputTokens: 1_000, costMicroUsd: 0 }, limits)).toEqual({ exhausted: true, reason: "input_tokens" });
  });
  it("trips on cost", () => {
    expect(runBudgetExhausted({ inputTokens: 1, costMicroUsd: 500 }, limits)).toEqual({ exhausted: true, reason: "cost" });
  });
  it("parsePositiveInt falls back on junk", () => {
    expect(parsePositiveInt("250000", 1)).toBe(250000);
    for (const bad of [undefined, "", "abc", "-5", "0"]) expect(parsePositiveInt(bad, 7)).toBe(7);
  });
});

describe("classifyAnthropicError", () => {
  const mk = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

  it("credit exhaustion is terminal, non-retryable and needs an operator — even though Anthropic sends it as HTTP 400", () => {
    const f = classifyAnthropicError(mk(400, "Your credit balance is too low to access the Anthropic API."));
    expect(f).toMatchObject({ kind: "credit_exhausted", retryable: false, operatorActionRequired: true });
    expect(f.message).toMatch(/not retried or moved to another provider/);
  });

  it("maps auth / permission / rate-limit / overloaded / 5xx", () => {
    expect(classifyAnthropicError(mk(401, "invalid x-api-key")).kind).toBe("auth_failed");
    expect(classifyAnthropicError(mk(403, "forbidden")).kind).toBe("permission_denied");
    expect(classifyAnthropicError(mk(429, "rate_limit_error"))).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(classifyAnthropicError(mk(529, "Overloaded"))).toMatchObject({ kind: "overloaded", retryable: true });
    expect(classifyAnthropicError(mk(500, "internal"))).toMatchObject({ kind: "server_error", retryable: true });
  });

  it("a plain 400 is an invalid-request config fault, never retryable", () => {
    expect(classifyAnthropicError(mk(400, "tool_choice: type \"any\" is not supported for this model")))
      .toMatchObject({ kind: "invalid_request", retryable: false });
  });

  it("never echoes the provider body into its fixed message", () => {
    const f = classifyAnthropicError(Object.assign(mk(400, "credit balance too low"), { responseBody: "SECRET-SEED jordan@example.com" }));
    expect(f.message).not.toMatch(/SECRET-SEED|jordan@example\.com/);
  });
});

describe("checks.orchestrator_anthropic", () => {
  const input = {
    keyPresent: true, pin: "anthropic", selectedProvider: "anthropic",
    modelId: "claude-sonnet-5", modelSource: "default" as const, thinking: "disabled" as const, effort: null,
    limits: { maxInputTokens: 1_500_000, maxCostMicroUsd: 2_000_000 },
  };

  it("reports configured / pinned / selected / model id", () => {
    expect(anthropicOrchestratorHealth(input)).toMatchObject({
      ok: true, configured: true, pinned: true, selected: true, model_id: "claude-sonnet-5", forced_tool_choice_supported: true, pricing_known: true,
    });
  });

  it("never contains a key-shaped string (the key is never an input)", () => {
    const out = JSON.stringify(anthropicOrchestratorHealth(input));
    expect(out).not.toMatch(/sk-ant|api[-_]?key\s*[:=]/i);
  });

  it("is inactive and OK with no key (zero behaviour change)", () => {
    const h = anthropicOrchestratorHealth({ ...input, keyPresent: false, pin: "", selectedProvider: "deepseek" });
    expect(h).toMatchObject({ ok: true, configured: false, pinned: false, selected: false });
    expect(h.detail).toMatch(/inactive/);
  });

  it("flags a pin without a key, a forced-tool-incompatible model, and an unpriced model", () => {
    expect(anthropicOrchestratorHealth({ ...input, keyPresent: false, selectedProvider: "deepseek" }).detail).toMatch(/pinned_but_key_missing/);
    expect(anthropicOrchestratorHealth({ ...input, modelId: "claude-sonnet-5-5" }).detail).toMatch(/model_rejects_forced_tool_choice/);
    expect(anthropicOrchestratorHealth({ ...input, modelId: "claude-mystery-1" }).detail).toMatch(/model_not_in_rate_table/);
  });
});

import { salvageReserve, salvageWithinBudget } from "../../supabase/functions/osint-agent/anthropic-orchestrator.ts";
describe("salvage admission", () => {
  const limits = { maxInputTokens: 1000, maxCostMicroUsd: 500 };
  const none = { inputTokens: 0, costMicroUsd: 0 };
  it("allows a bounded overrun but not an unbounded one", () => {
    expect(salvageWithinBudget({ inputTokens: 1000, costMicroUsd: 500 }, limits, none)).toBe(true);
    expect(salvageWithinBudget({ inputTokens: 1501, costMicroUsd: 0 }, limits, none)).toBe(false);
  });
  it("reserves the request's own worst case: spent-just-under + a large request is refused", () => {
    expect(salvageWithinBudget({ inputTokens: 0, costMicroUsd: 740 }, limits, { inputTokens: 0, costMicroUsd: 11 })).toBe(false);
    expect(salvageWithinBudget({ inputTokens: 0, costMicroUsd: 740 }, limits, { inputTokens: 0, costMicroUsd: 10 })).toBe(true);
  });
  it("prices the reserve as uncached input plus the full output cap", () => {
    expect(salvageReserve("claude-sonnet-5", 30_000, 8192)).toEqual({ inputTokens: 30_000, costMicroUsd: 141_920 });
  });
});
