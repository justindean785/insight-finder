import type { EntityGraph, GraphEdge, GraphNode } from "@/lib/entity-graph";
import { isIsolatedLead, linkedNodeIds, SEED_ID } from "@/lib/entity-graph";

/** One real relationship of the selected entity, seen from its side. */
export interface EntityLink {
  edge: GraphEdge;
  /** The node at the other end. */
  other: GraphNode;
}

export interface ConnectionsView {
  /** Entities with at least one real relationship, most-connected first (ties: label, for a stable order). */
  linked: Array<{ node: GraphNode; links: number }>;
  isolatedLeads: number;
  /** The isolated leads themselves, strongest evidence first, so a case with no links still has something to pivot from. */
  isolated: GraphNode[];
  seedRecords: number;
  realLinks: number;
  clusters: number;
}

/** Real relationships only: the faint seed-discovery provenance edge is not a connection. */
export function linksOf(graph: EntityGraph, id: string): EntityLink[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out: EntityLink[] = [];
  for (const edge of graph.edges) {
    if (edge.type === "seed-discovery") continue;
    if (edge.source !== id && edge.target !== id) continue;
    const other = byId.get(edge.source === id ? edge.target : edge.source);
    if (other) out.push({ edge, other });
  }
  // Strongest first, then a stable tiebreak so the list does not reshuffle between renders.
  return out.sort((a, b) => b.edge.strength - a.edge.strength || a.other.label.localeCompare(b.other.label));
}

export function connectionsView(graph: EntityGraph): ConnectionsView {
  const linkedIds = linkedNodeIds(graph);
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.type === "seed-discovery") continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const linked = graph.nodes
    .filter((n) => n.id !== SEED_ID && linkedIds.has(n.id))
    .map((node) => ({ node, links: degree.get(node.id) ?? 0 }))
    .sort((a, b) => b.links - a.links || a.node.label.localeCompare(b.node.label));
  const isolated = graph.nodes
    .filter((n) => isIsolatedLead(n, linkedIds))
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
  return {
    linked,
    isolated,
    isolatedLeads: isolated.length,
    seedRecords: graph.stats.seedRecordCount,
    realLinks: graph.stats.realEdgeCount,
    clusters: graph.stats.clusterCount,
  };
}
