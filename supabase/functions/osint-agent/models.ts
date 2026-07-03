// Model registry — single source of truth for which model handles which kind of
// orchestrator step. Swap a model in one place and the whole agent picks it up.
//
// Tiers:
//   - "fast"  : cheap model. artifact summarization, entity extraction, web search
//               fan-out, dedup, simple routing, every default tool dispatch.
//   - "smart" : the strong model. multi-source reasoning, correlation, planning
//               the next pivot batch, and the top-level orchestrator turn that
//               actually writes the final synthesis report.
//
// Default tier for a step is "fast" unless its name is explicitly listed in
// SMART_TOOLS below. The orchestrator itself runs on the smart model because
// its job is multi-source synthesis.

export type Tier = "fast" | "smart" | "fallback";

export const MODELS: Record<Tier, string> = {
  fast: "MiniMax-M2.7",
  smart: "MiniMax-M2.7",
  // Fallback runs on the Lovable AI gateway when MiniMax is unavailable. The old
  // pinned "google/gemini-2.5-pro" returns 403 Forbidden on this gateway key (the
  // pro tier is credit-gated), which turned a MiniMax preflight-timeout into a
  // DEAD run instead of a graceful degrade (Phase B5). Repoint to the free/served
  // flash-class model and make it operator-overridable WITHOUT a code change via
  // LOVABLE_FALLBACK_MODEL_ID. Single source of truth — env.ts + health-handler.ts
  // read this value. The PRIMARY orchestrator model (MiniMax) is unchanged.
  fallback: Deno.env.get("LOVABLE_FALLBACK_MODEL_ID") ?? "google/gemini-2.5-flash",
};

// Steps that MUST run on the smart tier. Everything else defaults to "fast".
export const SMART_TOOLS = new Set<string>([
  "minimax_correlate",
  "minimax_plan_pivots",
]);

// The top-level orchestrator turn (the streamText loop that drives the agent
// and writes the final report) is always smart — it's the synthesis step.
export const ORCHESTRATOR_TIER: Tier = "smart";

export function tierForTool(name: string): Tier {
  return SMART_TOOLS.has(name) ? "smart" : "fast";
}

export function modelForTool(name: string): string {
  return MODELS[tierForTool(name)];
}