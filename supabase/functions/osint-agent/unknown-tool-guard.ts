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
  | { redirect: true; toolName: string; requested: string };

/**
 * Decide how to handle an emitted tool-call NAME against the live registry.
 * - Known name → { redirect: false } (let the SDK validate its input as usual;
 *   a genuine bad-input error on a real tool is NOT our concern here).
 * - Unknown name → redirect to the sink, carrying the invented name so the sink
 *   can name it in its nudge for the model.
 */
export function repairUnknownTool(
  toolName: string,
  knownToolNames: Iterable<string>,
): RepairDecision {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames);
  if (known.has(toolName)) return { redirect: false };
  return { redirect: true, toolName: UNKNOWN_TOOL_SINK, requested: toolName };
}
