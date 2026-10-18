// orchestrator_select.ts — pure, runtime-agnostic selection of which provider
// drives the top-level orchestrator/synthesis turn. No Deno or network imports,
// so it is fully unit-testable from vitest.
//
// Design goal (Tranche 2): make the orchestrator provider swappable by a single
// secret WITHOUT changing default behavior. With nothing new configured the
// choice is always "minimax" — byte-for-byte the prior behavior. A non-default
// provider is selected only when its key is configured AND it is either pinned
// via ORCHESTRATOR_PROVIDER or is the only available provider.

export type OrchestratorProvider = "deepseek" | "minimax" | "grok" | "anthropic" | "lovable";

export interface OrchestratorAvailability {
  /** ORCHESTRATOR_PROVIDER secret, lowercased/trimmed ("" if unset). */
  pin: string;
  /** DeepSeek gateway configured (DEEPSEEK_API_KEY present). */
  deepseek: boolean;
  /** MINIMAX_API_KEY configured. */
  minimax: boolean;
  /** xAI/Grok gateway configured (XAI_API_KEY present). */
  grok: boolean;
  /**
   * Anthropic (Claude API) configured (ANTHROPIC_API_KEY present). Never a DEFAULT: it is the
   * primary only by an explicit ORCHESTRATOR_PROVIDER=anthropic|claude pin. Since E2b it is
   * also the BACKUP behind the GLM (deepseek-slot) primary — but only for an invocation GLM
   * cannot START (see `anthropicFallbackEligible` below and lib/orchestrator-fallback.ts);
   * never mid-run, never behind MiniMax/Grok/Lovable, and ANTHROPIC_FALLBACK_DISABLED=true
   * (read at call time) restores the old pin-only rule.
   */
  anthropic: boolean;
}

export interface OrchestratorChoice {
  provider: OrchestratorProvider;
  /** Why this provider was chosen — for logs/telemetry. */
  reason: "pinned" | "default-deepseek" | "default-minimax" | "only-available" | "none-configured";
}

/** Normalize provider aliases a user might set in ORCHESTRATOR_PROVIDER. */
function normalizePin(pin: string): OrchestratorProvider | "" {
  const p = pin.trim().toLowerCase();
  if (p === "deepseek") return "deepseek";
  if (p === "grok" || p === "xai") return "grok";
  if (p === "anthropic" || p === "claude") return "anthropic";
  if (p === "minimax") return "minimax";
  return "";
}

/**
 * Choose the PRIMARY orchestrator provider.
 *
 * Precedence:
 *   1. A valid pin whose provider is configured → that provider ("pinned").
 *   2. Otherwise DeepSeek if configured → "deepseek" ("default-deepseek").
 *   3. Otherwise MiniMax if configured → "minimax" ("default-minimax").
 *   4. Otherwise the first configured alternative → "only-available". Anthropic
 *      is deliberately NOT in that list: Claude spends finite prepaid credits, so
 *      it is the PRIMARY only by an explicit ORCHESTRATOR_PROVIDER=anthropic|claude
 *      pin (rule 1) and never by default or by absence of other keys. It may be the
 *      FALLBACK behind a GLM primary — see `anthropicFallbackEligible`.
 *   5. Nothing configured → "minimax" / "none-configured" (caller errors,
 *      same contract as before).
 */
export function selectOrchestratorProvider(a: OrchestratorAvailability): OrchestratorChoice {
  const has: Partial<Record<OrchestratorProvider, boolean>> = {
    deepseek: a.deepseek,
    minimax: a.minimax,
    grok: a.grok,
    anthropic: a.anthropic,
  };

  const pin = normalizePin(a.pin);
  if (pin && has[pin]) return { provider: pin, reason: "pinned" };

  // DeepSeek takes the lead orchestrator role by default when configured —
  // MiniMax stays wired as a secondary/fallback provider (still runs sub-tools
  // via minimaxChat) rather than being removed.
  if (has.deepseek) return { provider: "deepseek", reason: "default-deepseek" };

  if (has.minimax) return { provider: "minimax", reason: "default-minimax" };

  for (const p of ["grok"] as OrchestratorProvider[]) {
    if (has[p]) return { provider: p, reason: "only-available" };
  }
  return { provider: "minimax", reason: "none-configured" };
}

export interface AnthropicFallbackInput {
  /** What selectOrchestratorProvider chose as the PRIMARY. */
  primary: OrchestratorProvider;
  /** ANTHROPIC_API_KEY configured (the gateway exists). */
  anthropicKey: boolean;
  /** The configured ANTHROPIC_MODEL_ID accepts forced tool_choice (the finalize phases need it). */
  modelAcceptsForcedToolChoice: boolean;
  /** ANTHROPIC_FALLBACK_DISABLED=true — the kill switch, read at call time by the caller. */
  disabled: boolean;
}

/**
 * The E2b rule (operator decision, 2026-10-15): GLM-5.2 in the deepseek slot stays the
 * PRIMARY and Anthropic is its BACKUP. Anthropic takes an invocation only when:
 *   - the primary is the deepseek/GLM slot (never behind MiniMax, Grok or the Lovable gateway,
 *     and never "behind itself" when Anthropic is pinned);
 *   - ANTHROPIC_API_KEY is configured;
 *   - the model accepts forced tool_choice (otherwise the fallback run would 400 at step 1);
 *   - ANTHROPIC_FALLBACK_DISABLED is not "true".
 * WHEN it takes over is decided elsewhere and only ever BEFORE the run admits a tool
 * (lib/preflight-pivot.ts for the preflight, lib/orchestrator-fallback.ts for the first
 * real model call). With the kill switch on, today's Gemini → Lovable chain is restored.
 */
export function anthropicFallbackEligible(a: AnthropicFallbackInput): boolean {
  return a.primary === "deepseek" && a.anthropicKey && a.modelAcceptsForcedToolChoice && !a.disabled;
}

export interface FallbackAvailability {
  /** Direct Gemini API configured (GEMINI_API_KEY present). */
  gemini: boolean;
  /** Lovable AI Gateway configured (LOVABLE_API_KEY present). */
  lovable: boolean;
  /** Operator opt-in for the Lovable gateway (ALLOW_LOVABLE_FALLBACK=true). */
  allowLovable: boolean;
}

export interface FallbackChoice {
  provider: "gemini" | "lovable" | null;
  reason: string;
}

/**
 * Choose the FALLBACK provider when MiniMax can't take (or dropped) a turn.
 *
 * Scope: this is the SUB-TOOL fallback for `minimaxChat` (providers.ts), not the
 * orchestrator's. The orchestrator's precedence — including Anthropic as GLM's backup —
 * lives in `resolveFallbackProvider` (lib/preflight-pivot.ts). Anthropic is deliberately
 * NOT added here: it would route every failed sub-tool LLM call onto prepaid Claude credits.
 *
 * Order: direct Gemini → Lovable gateway (opt-in only) → none. Grok/xAI is
 * deliberately never a fallback — it stays an explicit primary pin
 * (ORCHESTRATOR_PROVIDER=grok) or nothing. The Lovable gateway is gated
 * behind ALLOW_LOVABLE_FALLBACK because it proxies shared quota and has
 * burned runs on credit-gated models.
 */
export function selectFallbackProvider(a: FallbackAvailability): FallbackChoice {
  if (a.gemini) return { provider: "gemini", reason: "GEMINI_API_KEY configured" };
  if (a.lovable && a.allowLovable) {
    return { provider: "lovable", reason: "ALLOW_LOVABLE_FALLBACK=true" };
  }
  if (a.lovable) {
    return { provider: null, reason: "Lovable gateway present but ALLOW_LOVABLE_FALLBACK is not true" };
  }
  return { provider: null, reason: "All orchestrators exhausted — check API quotas" };
}
