/**
 * orchestrator_select.ts — pure orchestrator model selection.
 *
 * Generalizes the previous binary MiniMax→Lovable(Gemini) choice into an
 * ordered, env-gated provider chain so additional OpenAI-compatible providers
 * (OpenAdapter, xAI Grok) can participate without changing the streamText call.
 *
 * This module is intentionally runtime-agnostic — no Deno/npm imports — so it
 * is unit-testable under Vitest. Provider *construction* (createOpenAICompatible)
 * lives in env.ts; this file only decides *which* provider+model to use.
 *
 * Behavior is preserved when only MINIMAX_API_KEY / LOVABLE_API_KEY are set:
 *   - normal, MiniMax present        → MiniMax           (was useFallback=false)
 *   - context overflow OR no MiniMax → Lovable/Gemini    (was useFallback=true)
 */

export type ProviderId = "minimax" | "openadapter" | "grok" | "lovable";

export const PROVIDER_IDS: ProviderId[] = ["minimax", "openadapter", "grok", "lovable"];

export interface ProviderProfile {
  id: ProviderId;
  /** model id passed to provider.chatModel(...) */
  model: string;
  /** cost-meter rate, micro-USD per input token (estimate; override per plan) */
  inRate: number;
  /** cost-meter rate, micro-USD per output token */
  outRate: number;
  /** large (≈1M-token) context window — preferred when the prompt would overflow */
  largeContext: boolean;
}

export interface OrchestratorChoice {
  providerId: ProviderId;
  model: string;
  inRate: number;
  outRate: number;
  reason: "preferred" | "primary" | "overflow" | "fallback";
  label: string;
}

export interface SelectInput {
  /** which provider keys are present (constructed providers) */
  available: Record<ProviderId, boolean>;
  /** per-provider profile (model id + rates), already env-merged */
  profiles: Record<ProviderId, ProviderProfile>;
  /** prompt would exceed the primary (MiniMax) context window */
  overflow: boolean;
  /** explicit ORCHESTRATOR_PROVIDER override (operator-pinned primary) */
  preferred?: ProviderId | null;
}

// When the primary is unavailable: try cheaper/closer providers first.
const FALLBACK_ORDER: ProviderId[] = ["lovable", "openadapter", "grok", "minimax"];
// When the prompt would overflow MiniMax: prefer large-context providers.
const OVERFLOW_ORDER: ProviderId[] = ["lovable", "openadapter", "grok", "minimax"];

/** Default per-provider profiles. Pass `over` to patch model ids / rates from env. */
export function defaultProfiles(
  over?: Partial<Record<ProviderId, Partial<ProviderProfile>>>,
): Record<ProviderId, ProviderProfile> {
  const base: Record<ProviderId, ProviderProfile> = {
    // Rates match the previous hard-coded cost meter so behavior is preserved.
    minimax: { id: "minimax", model: "MiniMax-M2.7", inRate: 0.3, outRate: 1.2, largeContext: false },
    openadapter: { id: "openadapter", model: "MiniMax-M2.7", inRate: 0.5, outRate: 2, largeContext: true },
    grok: { id: "grok", model: "grok-4.3", inRate: 3, outRate: 15, largeContext: false },
    lovable: { id: "lovable", model: "google/gemini-2.5-pro", inRate: 1.25, outRate: 10, largeContext: true },
  };
  if (over) {
    for (const id of Object.keys(over) as ProviderId[]) {
      base[id] = { ...base[id], ...over[id] };
    }
  }
  return base;
}

/**
 * Choose the orchestrator provider + model for this turn.
 * Throws if no provider key is configured at all (same contract as before).
 */
export function selectOrchestrator(input: SelectInput): OrchestratorChoice {
  const { available, profiles, overflow, preferred } = input;

  const make = (id: ProviderId, reason: OrchestratorChoice["reason"]): OrchestratorChoice => {
    const p = profiles[id];
    const suffix = reason === "primary" ? "" : ` ${reason}`;
    return { providerId: id, model: p.model, inRate: p.inRate, outRate: p.outRate, reason, label: `${p.model} (${id}${suffix})` };
  };

  // 1) Operator override wins when its key is present.
  if (preferred && available[preferred]) return make(preferred, "preferred");

  // 2) Overflow: prefer a large-context provider, else any available.
  if (overflow) {
    const big = OVERFLOW_ORDER.find((id) => available[id] && profiles[id].largeContext);
    if (big) return make(big, "overflow");
    const any = OVERFLOW_ORDER.find((id) => available[id]);
    if (any) return make(any, "overflow");
  }

  // 3) Normal path: MiniMax primary when available.
  if (available.minimax) return make("minimax", "primary");

  // 4) Otherwise the first available provider in fallback order.
  const fb = FALLBACK_ORDER.find((id) => available[id]);
  if (fb) return make(fb, "fallback");

  throw new Error(
    "No orchestrator provider configured: set MINIMAX_API_KEY, OPENADAPTER_API_KEY, XAI_API_KEY (Grok), or LOVABLE_API_KEY.",
  );
}
