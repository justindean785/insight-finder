/**
 * graph_pivots.ts — pure graph-driven pivot selection (Phase 9).
 *
 * Re-ranks and filters the planner's candidate pivots against the entity graph:
 * drop pivots that target dead-end / over-broad / already-confirmed entities,
 * and order the rest cheapest-justified-first (free validation before premium
 * confirmation). This is the "evidence → graph → reasoning → cheapest justified
 * pivot" layer.
 *
 * PURE: no I/O. It is dark-launched in index.ts behind GRAPH_PIVOTS_ENABLED
 * (default off), so merging changes nothing in production until enabled.
 */

import {
  type GraphNode,
  type NodeType,
  normalizeSelector,
  isDeadEnd,
  isGenericHandle,
  gradeConfidence,
} from "./graph.ts";
import { isPremiumTool } from "./circuit.ts";
import { costForTool } from "./costs.ts";

export interface PivotCandidate {
  tool: string;
  args?: Record<string, unknown> | null;
  reason?: string;
  priority?: number;
}

export type DropReason = "dead_end" | "over_broad_unconfirmed" | "already_confirmed" | "over_budget";

export interface PivotDecision {
  selected: PivotCandidate[];
  dropped: Array<{ tool: string; reason: DropReason }>;
}

const ARG_KEYS: Array<[string, NodeType]> = [
  ["email", "email"],
  ["username", "username"],
  ["handle", "username"],
  ["domain", "domain"],
  ["ip", "ip"],
  ["phone", "phone"],
  ["url", "url"],
];

/** A planner `proposed_calls[]` entry. The planner LLM emits this shape; it
 *  differs from PivotCandidate (which selectPivots consumes). */
export interface ProposedCall {
  tool_name?: unknown;
  selector?: unknown;
  selector_type?: unknown;
  params_preview?: unknown;
  expected_value?: unknown;
  [k: string]: unknown;
}

/** Map a planner proposed_call → PivotCandidate, carrying the original call
 *  under `_orig` so the caller can restore the full planner payload after
 *  selection (selectPivots preserves object identity). The planner emits
 *  {tool_name, selector, selector_type, params_preview, expected_value, ...};
 *  selectPivots needs {tool, args, priority}. `selector` is mapped both to a
 *  generic `value` arg and (when selector_type is known) to its typed key, so
 *  pivotTargetNode can resolve the target node either way. */
export function proposedCallToCandidate(pc: ProposedCall): PivotCandidate & { _orig: ProposedCall } {
  const args: Record<string, unknown> = {
    ...(pc.params_preview && typeof pc.params_preview === "object" ? pc.params_preview as Record<string, unknown> : {}),
  };
  const selector = typeof pc.selector === "string" ? pc.selector.trim() : "";
  if (selector) {
    args.value = selector;
    const st = typeof pc.selector_type === "string" ? pc.selector_type.trim() : "";
    if (st) args[st] = selector;
  }
  return {
    tool: String(pc.tool_name ?? ""),
    args,
    priority: typeof pc.expected_value === "number" ? pc.expected_value : 0,
    _orig: pc,
  };
}

/** Find the graph node a pivot targets, by inspecting its args. */
export function pivotTargetNode(args: Record<string, unknown> | null | undefined, nodes: GraphNode[]): GraphNode | null {
  if (!args) return null;
  for (const [key, type] of ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) {
      const norm = normalizeSelector(type, v);
      const hit = nodes.find((n) => n.id === `${type}:${norm}`) ?? nodes.find((n) => n.value === norm);
      if (hit) return hit;
    }
  }
  if (typeof args.value === "string" && args.value.trim()) {
    const v = args.value.trim().toLowerCase();
    return nodes.find((n) => n.value === v) ?? null;
  }
  return null;
}

/** Select & order pivots given the current graph. Conservative: a candidate
 *  whose target isn't in the graph is kept (we only have reason to drop what we
 *  can see). Ordering is cheapest-justified first, planner priority as tiebreak. */
export function selectPivots(
  candidates: PivotCandidate[],
  nodes: GraphNode[],
  opts: { budget?: number; costOf?: (tool: string) => number } = {},
): PivotDecision {
  const costOf = opts.costOf ?? costForTool;
  const dropped: Array<{ tool: string; reason: DropReason }> = [];
  const kept: Array<{ c: PivotCandidate; cost: number }> = [];

  for (const c of candidates) {
    const node = pivotTargetNode(c.args, nodes);
    if (node) {
      if (isDeadEnd(node)) {
        dropped.push({ tool: c.tool, reason: "dead_end" });
        continue;
      }
      if (isPremiumTool(c.tool)) {
        const grade = gradeConfidence(node);
        if (isGenericHandle(node) && grade.distinctClasses.length < 2) {
          // Don't spend premium credits confirming a squatted handle until
          // independent evidence corroborates it.
          dropped.push({ tool: c.tool, reason: "over_broad_unconfirmed" });
          continue;
        }
        if (grade.status === "verified") {
          // Already corroborated across ≥2 classes — a premium re-confirm adds
          // no marginal value.
          dropped.push({ tool: c.tool, reason: "already_confirmed" });
          continue;
        }
      }
    }
    kept.push({ c, cost: costOf(c.tool) });
  }

  kept.sort((a, b) => a.cost - b.cost || (b.c.priority ?? 0) - (a.c.priority ?? 0));
  let selected = kept.map((k) => k.c);

  if (opts.budget != null && selected.length > opts.budget) {
    for (const k of kept.slice(opts.budget)) dropped.push({ tool: k.c.tool, reason: "over_budget" });
    selected = selected.slice(0, opts.budget);
  }

  return { selected, dropped };
}
