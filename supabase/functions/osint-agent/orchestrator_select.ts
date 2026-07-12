// orchestrator_select.ts — pure, runtime-agnostic selection of which provider
// drives the top-level orchestrator/synthesis turn. No Deno or network imports,
// so it is fully unit-testable from vitest.
//
// Design goal (Tranche 2): make the orchestrator provider swappable by a single
// secret WITHOUT changing default behavior. With nothing new configured the
// choice is always "minimax" — byte-for-byte the prior behavior. A non-default
// provider is selected only when its key is configured AND it is either pinned
// via ORCHESTRATOR_PROVIDER or is the only available provider.

export type OrchestratorProvider = "deepseek" | "minimax" | "grok" | "openadapter" | "lovable";

export interface OrchestratorAvailability {
  /** ORCHESTRATOR_PROVIDER secret, lowercased/trimmed ("" if unset). */
  pin: string;
  /** DeepSeek gateway configured (DEEPSEEK_API_KEY present). */
  deepseek: boolean;
  /** MINIMAX_API_KEY configured. */
  minimax: boolean;
  /** xAI/Grok gateway configured (XAI_API_KEY present). */
  grok: boolean;
  /** OpenAdapter gateway configured (key + base URL present). */
  openadapter: boolean;
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
  if (p === "openadapter" || p === "open-adapter") return "openadapter";
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
 *   4. Otherwise the first configured alternative → "only-available".
 *   5. Nothing configured → "minimax" / "none-configured" (caller errors,
 *      same contract as before).
 */
export function selectOrchestratorProvider(a: OrchestratorAvailability): OrchestratorChoice {
  const has: Partial<Record<OrchestratorProvider, boolean>> = {
    deepseek: a.deepseek,
    minimax: a.minimax,
    grok: a.grok,
    openadapter: a.openadapter,
  };

  const pin = normalizePin(a.pin);
  if (pin && has[pin]) return { provider: pin, reason: "pinned" };

  // DeepSeek takes the lead orchestrator role by default when configured —
  // MiniMax stays wired as a secondary/fallback provider (still runs sub-tools
  // via minimaxChat) rather than being removed.
  if (has.deepseek) return { provider: "deepseek", reason: "default-deepseek" };

  if (has.minimax) return { provider: "minimax", reason: "default-minimax" };

  for (const p of ["grok", "openadapter"] as OrchestratorProvider[]) {
    if (has[p]) return { provider: p, reason: "only-available" };
  }
  return { provider: "minimax", reason: "none-configured" };
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
