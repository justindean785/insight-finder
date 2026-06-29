import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  proposedCallToCandidate,
  selectPivots,
  pivotTargetNode,
  type ProposedCall,
} from "./graph_pivots.ts";
import type { GraphNode } from "./graph.ts";

/**
 * graph_pivots tests — Slice 2 / Phase B1.
 *
 * Covers the planner→selector glue that was previously broken: the dark-launched
 * block read `parsed.pivots`, but the planner emits `proposed_calls` with a
 * different shape, so the selector never ran even when GRAPH_PIVOTS_ENABLED=true.
 * proposedCallToCandidate is the mapper that fixes that; these tests pin its
 * behavior plus selectPivots ordering / drop semantics.
 */

function node(partial: Partial<GraphNode> & { id: string; type: GraphNode["type"]; value: string }): GraphNode {
  return { raw: partial.value, evidence: [], metadata: {}, ...partial };
}

Deno.test("proposedCallToCandidate maps tool_name/expected_value and keys selector by type", () => {
  const pc: ProposedCall = {
    tool_name: "leakcheck_lookup",
    selector: "Alice@Example.com",
    selector_type: "email",
    expected_value: 72,
    params_preview: { foo: "bar" },
  };
  const c = proposedCallToCandidate(pc);
  assertEquals(c.tool, "leakcheck_lookup");
  assertEquals(c.priority, 72);
  // selector exposed both generically and under its typed key; params preserved.
  assertEquals((c.args as Record<string, unknown>).value, "Alice@Example.com");
  assertEquals((c.args as Record<string, unknown>).email, "Alice@Example.com");
  assertEquals((c.args as Record<string, unknown>).foo, "bar");
  // original payload preserved verbatim for restoration after selection.
  assertEquals(c._orig, pc);
});

Deno.test("proposedCallToCandidate tolerates missing/odd fields", () => {
  const c = proposedCallToCandidate({} as ProposedCall);
  assertEquals(c.tool, "");
  assertEquals(c.priority, 0);
  assertEquals(Object.keys(c.args as Record<string, unknown>).length, 0);
});

Deno.test("a mapped candidate resolves its target node via the typed selector key", () => {
  const nodes = [node({ id: "email:dead@x.com", type: "email", value: "dead@x.com" })];
  const c = proposedCallToCandidate({ tool_name: "oathnet_lookup", selector: "dead@x.com", selector_type: "email" });
  assertEquals(pivotTargetNode(c.args, nodes)?.id, "email:dead@x.com");
});

Deno.test("selectPivots drops a candidate that targets a dead-end node", () => {
  const nodes = [
    node({ id: "email:dead@x.com", type: "email", value: "dead@x.com", metadata: { status: "exhausted" } }),
  ];
  const live = proposedCallToCandidate({ tool_name: "username_sweep", selector: "freshhandle", selector_type: "username" });
  const dead = proposedCallToCandidate({ tool_name: "username_sweep", selector: "dead@x.com", selector_type: "email" });
  const { selected, dropped } = selectPivots([live, dead], nodes);
  assertEquals(selected.length, 1);
  assertEquals(selected[0].tool, "username_sweep");
  assert(dropped.some((d) => d.reason === "dead_end"));
});

Deno.test("selectPivots orders cheapest-justified first (free before expensive)", () => {
  // No graph nodes match these selectors → all kept; ordering is by cost.
  const expensive = proposedCallToCandidate({ tool_name: "oathnet_lookup", selector: "a@new.com", selector_type: "email", expected_value: 99 });
  const free = proposedCallToCandidate({ tool_name: "username_sweep", selector: "newhandle", selector_type: "username", expected_value: 10 });
  const { selected } = selectPivots([expensive, free], []);
  // username_sweep (cost 0) ranks ahead of oathnet_lookup (expensive) despite
  // lower planner expected_value — cost dominates, EV is only the tiebreak.
  assertEquals(selected.map((c) => c.tool), ["username_sweep", "oathnet_lookup"]);
});

Deno.test("selectPivots enforces the call-count budget and reports over_budget drops", () => {
  const calls = [
    proposedCallToCandidate({ tool_name: "username_sweep", selector: "h1", selector_type: "username" }),
    proposedCallToCandidate({ tool_name: "github_user", selector: "h2", selector_type: "username" }),
    proposedCallToCandidate({ tool_name: "reddit_user", selector: "h3", selector_type: "username" }),
  ];
  const { selected, dropped } = selectPivots(calls, [], { budget: 2 });
  assertEquals(selected.length, 2);
  assert(dropped.some((d) => d.reason === "over_budget"));
});

Deno.test("round-trip: selected candidates restore the original planner payload", () => {
  const orig1: ProposedCall = { tool_name: "username_sweep", selector: "h1", selector_type: "username", reason: "cheap check" };
  const orig2: ProposedCall = { tool_name: "oathnet_lookup", selector: "a@new.com", selector_type: "email", reason: "premium" };
  const candidates = [orig1, orig2].map(proposedCallToCandidate);
  const { selected } = selectPivots(candidates, []);
  const restored = (selected as Array<ReturnType<typeof proposedCallToCandidate>>).map((c) => c._orig);
  // cheapest first → username_sweep payload leads, full object intact.
  assertEquals(restored[0], orig1);
  assertEquals(restored[0].reason, "cheap check");
});
