import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { inferEdges, clusterGraph } from "./graph_reasoning.ts";
import type { GraphNode } from "./graph.ts";

/**
 * graph_reasoning tests — Slice 2 / Phase A (item 2).
 *
 * graph_reasoning was written but never imported into the runtime. Slice 2 wires
 * inferEdges + clusterGraph into the planner (relationship-graph summary), so
 * these pin the edge-inference and cluster-split contract the planner now relies
 * on. propagateConfidence is intentionally NOT exercised here — it stays unwired
 * (mutating confidence would be an integrity change requiring sign-off).
 */

function node(p: Partial<GraphNode> & { id: string; type: GraphNode["type"]; value: string }): GraphNode {
  return { raw: p.value, evidence: [], metadata: {}, ...p };
}

Deno.test("inferEdges derives works_for (founder) and alias_of (display_name)", () => {
  const nodes = [
    node({ id: "person:alice", type: "person", value: "alice" }),
    node({ id: "organization:acme", type: "organization", value: "acme", metadata: { founder: "Alice" } }),
    node({ id: "username:al", type: "username", value: "al", metadata: { display_name: "Alice" } }),
  ];
  const edges = inferEdges(nodes);
  assert(edges.some((e) => e.type === "works_for" && e.from === "person:alice" && e.to === "organization:acme"));
  assert(edges.some((e) => e.type === "alias_of" && e.from === "username:al" && e.to === "person:alice"));
});

Deno.test("inferEdges links nodes sharing a parent selector via same_selector", () => {
  const nodes = [
    node({ id: "email:a@x.com", type: "email", value: "a@x.com", metadata: { parent: "seed1" } }),
    node({ id: "username:ax", type: "username", value: "ax", metadata: { parent: "seed1" } }),
  ];
  const edges = inferEdges(nodes);
  assert(edges.some((e) => e.type === "same_selector"));
});

Deno.test("clusterGraph merges connected nodes into one un-conflicted identity cluster", () => {
  const nodes = [
    node({ id: "person:alice", type: "person", value: "alice" }),
    node({ id: "organization:acme", type: "organization", value: "acme", metadata: { founder: "alice" } }),
    node({ id: "username:al", type: "username", value: "al", metadata: { display_name: "alice" } }),
  ];
  const { clusters } = clusterGraph(nodes, inferEdges(nodes));
  const big = clusters.find((c) => c.nodeIds.length === 3);
  assert(big, "expected all three nodes in one cluster");
  assertEquals(big!.conflicted, false);
  assertEquals(big!.label, "alice");
});

Deno.test("clusterGraph splits a contaminated cluster (one selector → two people)", () => {
  // alice, bob and a shared handle all share parent "seed1" → same_selector
  // connects them, but they assert two distinct person identities.
  const nodes = [
    node({ id: "person:alice", type: "person", value: "alice", metadata: { parent: "seed1" } }),
    node({ id: "person:bob", type: "person", value: "bob", metadata: { parent: "seed1" } }),
    node({ id: "username:shared", type: "username", value: "shared", metadata: { parent: "seed1" } }),
  ];
  const { clusters, contradictions } = clusterGraph(nodes, inferEdges(nodes));
  const labels = clusters.filter((c) => c.label).map((c) => c.label);
  assert(labels.includes("alice") && labels.includes("bob"), "both identities split out");
  assert(clusters.some((c) => c.conflicted), "split clusters flagged conflicted");
  assert(contradictions.length >= 1, "contradiction edge emitted between identities");
});
