import { describe, it, expect } from "vitest";
import { selectOrchestratorProvider, selectFallbackProvider } from "../../supabase/functions/osint-agent/orchestrator_select.ts";

// Tranche 2 provider chain. The load-bearing guarantee: with nothing new
// configured the orchestrator provider is ALWAYS minimax — merging the wiring
// cannot change live behavior. A non-default provider is chosen only when its
// key is configured.

describe("selectOrchestratorProvider — default safety", () => {
  it("defaults to minimax when only minimax is configured", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });

  it("stays on minimax even when grok is ALSO configured but not pinned", () => {
    // This is the safety property: adding the key without pinning changes nothing.
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: true, grok: true, openadapter: true }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });

  it("reports none-configured (still minimax) when nothing is set", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: false, grok: false, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "none-configured" });
  });
});

describe("selectOrchestratorProvider — DeepSeek default precedence", () => {
  it("defaults to deepseek when configured, even with minimax also configured", () => {
    // DeepSeek is the new default lead — MiniMax stays wired as a
    // secondary/fallback provider (still runs sub-tools) but no longer wins
    // the top-level orchestrator role when both are available.
    expect(selectOrchestratorProvider({ pin: "", deepseek: true, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "deepseek", reason: "default-deepseek" });
  });

  it("does NOT select deepseek when its key is absent (safety property preserved)", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: true, grok: true, openadapter: true }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });

  it("selects deepseek when pinned and configured", () => {
    expect(selectOrchestratorProvider({ pin: "deepseek", deepseek: true, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "deepseek", reason: "pinned" });
  });

  it("ignores a deepseek pin whose key is NOT configured (falls back to minimax)", () => {
    expect(selectOrchestratorProvider({ pin: "deepseek", deepseek: false, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });

  it("an explicit minimax pin overrides the deepseek default", () => {
    expect(selectOrchestratorProvider({ pin: "minimax", deepseek: true, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "pinned" });
  });
});

describe("selectOrchestratorProvider — explicit pin", () => {
  it("selects grok when pinned and configured", () => {
    expect(selectOrchestratorProvider({ pin: "grok", deepseek: false, minimax: true, grok: true, openadapter: false }))
      .toEqual({ provider: "grok", reason: "pinned" });
  });

  it("accepts 'xai' as an alias for grok", () => {
    expect(selectOrchestratorProvider({ pin: "xai", deepseek: false, minimax: true, grok: true, openadapter: false }).provider)
      .toBe("grok");
  });

  it("selects openadapter when pinned and configured", () => {
    expect(selectOrchestratorProvider({ pin: "openadapter", deepseek: false, minimax: true, grok: false, openadapter: true }))
      .toEqual({ provider: "openadapter", reason: "pinned" });
  });

  it("honors an explicit minimax pin", () => {
    expect(selectOrchestratorProvider({ pin: "minimax", deepseek: false, minimax: true, grok: true, openadapter: true }))
      .toEqual({ provider: "minimax", reason: "pinned" });
  });

  it("ignores a pin whose provider is NOT configured (falls back to minimax)", () => {
    expect(selectOrchestratorProvider({ pin: "grok", deepseek: false, minimax: true, grok: false, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });

  it("ignores an unknown pin value", () => {
    expect(selectOrchestratorProvider({ pin: "gpt5", deepseek: false, minimax: true, grok: true, openadapter: false }))
      .toEqual({ provider: "minimax", reason: "default-minimax" });
  });
});

describe("selectOrchestratorProvider — only-available fallthrough", () => {
  it("uses grok when it is the only provider configured", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: false, grok: true, openadapter: false }))
      .toEqual({ provider: "grok", reason: "only-available" });
  });

  it("uses openadapter when it is the only provider configured", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: false, grok: false, openadapter: true }))
      .toEqual({ provider: "openadapter", reason: "only-available" });
  });

  it("prefers grok over openadapter when both are configured and minimax is absent", () => {
    expect(selectOrchestratorProvider({ pin: "", deepseek: false, minimax: false, grok: true, openadapter: true }).provider)
      .toBe("grok");
  });
});

describe("selectFallbackProvider — tool-level fallback selection", () => {
  it("selects direct Gemini when available (deterministic priority)", () => {
    expect(selectFallbackProvider({ gemini: true, lovable: true, allowLovable: true }))
      .toEqual({ provider: "gemini", reason: "GEMINI_API_KEY configured" });
  });

  it("selects direct Gemini when it is the only provider available", () => {
    expect(selectFallbackProvider({ gemini: true, lovable: false, allowLovable: false }))
      .toEqual({ provider: "gemini", reason: "GEMINI_API_KEY configured" });
  });

  it("selects lovable only behind the ALLOW_LOVABLE_FALLBACK opt-in", () => {
    expect(selectFallbackProvider({ gemini: false, lovable: true, allowLovable: true }))
      .toEqual({ provider: "lovable", reason: "ALLOW_LOVABLE_FALLBACK=true" });
  });

  it("refuses the lovable gateway without the opt-in", () => {
    const result = selectFallbackProvider({ gemini: false, lovable: true, allowLovable: false });
    expect(result.provider).toBeNull();
    expect(result.reason).toMatch(/ALLOW_LOVABLE_FALLBACK/);
  });

  it("returns null provider when nothing is available", () => {
    const result = selectFallbackProvider({ gemini: false, lovable: false, allowLovable: false });
    expect(result.provider).toBeNull();
    expect(result.reason).toMatch(/exhausted/i);
  });
});
