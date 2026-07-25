/**
 * unknown-tool-guard.ts — Phase B4: drop hallucinated tool calls before execution.
 *
 * MiniMax sometimes emits tool calls for names that are NOT in the live registry
 * (observed: `exify`, `hackerone_lookup`). ai@6 already turns these into non-fatal
 * `invalid` tool-error parts (never executed), but the hallucinated NAME still
 * surfaces in the timeline as a failed call. This guard, wired into streamText's
 * `experimental_repairToolCall`, redirects any non-registry name to a benign
 * internal sink tool so it is dropped silently, never executes the fake tool, and
 * never renders the invented name — the model gets a terse nudge instead.
 *
 * PURE: no I/O, no SDK calls, so the drop/keep decision is unit-testable.
 */

/** Registered no-op tool that hallucinated calls are redirected to. */
export const UNKNOWN_TOOL_SINK = "unknown_tool_ignored";

/** Terse nudge returned to the model when an unknown tool is dropped. */
export function unknownToolNudge(requested?: string): string {
  return `Ignored an unavailable tool${requested ? ` ("${requested}")` : ""}. ` +
    `Call only tools listed in your current schema.`;
}

export type RepairDecision =
  | { redirect: false }
  | { redirect: true; toolName: string; requested: string; aliased?: boolean };

/**
 * Decide how to handle an emitted tool-call NAME against the live registry.
 * - Known name → { redirect: false } (let the SDK validate its input as usual;
 *   a genuine bad-input error on a real tool is NOT our concern here).
 * - Known ALIAS (see tool-registry.ts TOOL_NAME_ALIASES) whose target is a real
 *   registered tool → redirect to the REAL tool, not the sink, so a known drift
 *   pattern (e.g. DeepSeek emitting "web_search" for "minimax_web_search")
 *   actually executes instead of being dropped and burning a step.
 * - Unknown name (not registered, not a known alias) → redirect to the sink,
 *   carrying the invented name so the sink can name it in its nudge for the
 *   model. Stays zero-cost — unchanged from before this map existed.
 */
export function repairUnknownTool(
  toolName: string,
  knownToolNames: Iterable<string>,
  aliases: Record<string, string> = {},
): RepairDecision {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames);
  if (known.has(toolName)) return { redirect: false };
  const aliasTarget = aliases[toolName];
  if (aliasTarget && known.has(aliasTarget)) {
    return { redirect: true, toolName: aliasTarget, requested: toolName, aliased: true };
  }
  return { redirect: true, toolName: UNKNOWN_TOOL_SINK, requested: toolName };
}
