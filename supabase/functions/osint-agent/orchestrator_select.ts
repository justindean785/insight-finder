// orchestrator_select.ts — pure, runtime-agnostic selection of which provider
// drives the top-level orchestrator/synthesis turn. No Deno or network imports,
// so it is fully unit-testable from vitest.
//
// Design goal (Tranche 2): make the orchestrator provider swappable by a single
// secret WITHOUT changing default behavior. With nothing new configured the
// choice is always "minimax" — byte-for-byte the prior behavior. A non-default
// provider is selected only when its key is configured AND it is either pinned
// via ORCHESTRATOR_PROVIDER or is the only available provider.

export type OrchestratorProvider = "minimax" | "grok" | "openadapter";

export interface OrchestratorAvailability {
  /** ORCHESTRATOR_PROVIDER secret, lowercased/trimmed ("" if unset). */
  pin: string;
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
  reason: "pinned" | "default-minimax" | "only-available" | "none-configured";
}

/** Normalize provider aliases a user might set in ORCHESTRATOR_PROVIDER. */
function normalizePin(pin: string): OrchestratorProvider | "" {
  const p = pin.trim().toLowerCase();
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
 *   2. Otherwise MiniMax if configured → "minimax" ("default-minimax").
 *   3. Otherwise the first configured alternative → "only-available".
 *   4. Nothing configured → "minimax" / "none-configured" (caller errors,
 *      same contract as before).
 */
export function selectOrchestratorProvider(a: OrchestratorAvailability): OrchestratorChoice {
  const has: Record<OrchestratorProvider, boolean> = {
    minimax: a.minimax,
    grok: a.grok,
    openadapter: a.openadapter,
  };

  const pin = normalizePin(a.pin);
  if (pin && has[pin]) return { provider: pin, reason: "pinned" };

  if (has.minimax) return { provider: "minimax", reason: "default-minimax" };

  for (const p of ["grok", "openadapter"] as OrchestratorProvider[]) {
    if (has[p]) return { provider: p, reason: "only-available" };
  }
  return { provider: "minimax", reason: "none-configured" };
}
