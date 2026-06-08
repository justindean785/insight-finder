/**
 * graph_reasoning.ts — pure graph reasoning layer (Phase 2/3).
 *
 * Builds on graph.ts: infers edges between entity nodes, clusters them by
 * identity, splits contaminated clusters (the boobz_sexy vs Aladewura case),
 * and propagates confidence — support edges corroborate, contradiction edges
 * penalize the whole cluster, and dead-end nodes never strengthen neighbors.
 *
 * Like graph.ts this is PURE and ADDITIVE: no I/O, no side effects, and NOT
 * wired into the orchestrator. It produces deterministic outputs so #12 can
 * later flip decision-making onto the graph with zero production behavior
 * change until then.
 */

import {
  type GraphNode,
  type EdgeType,
  SOURCE_CLASS_WEIGHT,
  isDeadEnd,
  gradeConfidence,
} from "./graph.ts";

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  source: string;
  weight: number;
}

/** Edges that merge two nodes into the same identity cluster. `contradicts`
 *  is deliberately excluded — a conflict must not merge identities. */
const CLUSTER_EDGES = new Set<EdgeType>([
  "works_for",
  "alias_of",
  "same_selector",
  "derived_from",
  "supports",
]);

/** Edges that actively corroborate a node's confidence. */
const SUPPORT_FOR_SCORE = new Set<EdgeType>(["works_for", "alias_of", "supports"]);

const CONTRADICTION_PENALTY = 15;
const SUPPORT_STEP = 5;
const SUPPORT_CAP = 15;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The human identity a node asserts, if any (used to detect contamination). */
export function personLabel(node: GraphNode): string | null {
  const m = node.metadata ?? {};
  if (node.type === "person") return node.value;
  if (node.type === "organization" && typeof m.founder === "string") return norm(m.founder);
  if (
    (node.type === "social_profile" || node.type === "username") &&
    typeof m.display_name === "string"
  ) {
    return norm(m.display_name);
  }
  return null;
}

// ---- Edge inference (Phase 2) ----------------------------------------------

/** Infer relationship edges from node metadata. Deterministic. */
export function inferEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const personByName = new Map<string, GraphNode>();
  for (const n of nodes) if (n.type === "person") personByName.set(n.value, n);

  for (const n of nodes) {
    const m = n.metadata ?? {};
    // organization → its founder person
    if (n.type === "organization" && typeof m.founder === "string") {
      const p = personByName.get(norm(m.founder));
      if (p) edges.push({ from: p.id, to: n.id, type: "works_for", source: "founder", weight: 1 });
    }
    // a social/username whose display name matches a known person → alias
    if (
      (n.type === "social_profile" || n.type === "username") &&
      typeof m.display_name === "string"
    ) {
      const p = personByName.get(norm(m.display_name));
      if (p) edges.push({ from: n.id, to: p.id, type: "alias_of", source: "display_name", weight: 1 });
    }
    // explicit contradictions recorded upstream
    if (Array.isArray(m.contradictions)) {
      for (const c of m.contradictions) {
        if (typeof c === "string" && c) {
          edges.push({ from: n.id, to: c, type: "contradicts", source: "metadata", weight: 1 });
        }
      }
    }
  }

  // nodes sharing a parent selector are the same selector cluster
  const byParent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const parent = typeof n.metadata?.parent === "string" ? norm(n.metadata.parent as string) : null;
    if (!parent) continue;
    const arr = byParent.get(parent) ?? [];
    arr.push(n);
    byParent.set(parent, arr);
  }
  for (const group of byParent.values()) {
    for (let i = 1; i < group.length; i++) {
      edges.push({ from: group[0].id, to: group[i].id, type: "same_selector", source: "parent", weight: 1 });
    }
  }
  return edges;
}

// ---- Clustering + split (Phase 3) ------------------------------------------

export interface IdentityCluster {
  id: string;
  label: string | null;
  nodeIds: string[];
  conflicted: boolean;
  ambiguous: boolean;
}

export interface Clustering {
  clusters: IdentityCluster[];
  contradictions: GraphEdge[];
}

function connectedGroups(ids: string[], edges: GraphEdge[]): string[][] {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const e of edges) {
    if (!CLUSTER_EDGES.has(e.type)) continue;
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    parent.set(find(e.from), find(e.to));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const arr = groups.get(r) ?? [];
    arr.push(id);
    groups.set(r, arr);
  }
  return [...groups.values()];
}

/** Cluster nodes by identity and split contaminated clusters. When a single
 *  selector accumulates >1 distinct person identity, each identity becomes its
 *  own cluster, leftover (label-less) nodes become an `ambiguous` shared
 *  cluster, and `contradicts` edges are emitted between the identities. */
export function clusterGraph(nodes: GraphNode[], edges: GraphEdge[]): Clustering {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = connectedGroups(nodes.map((n) => n.id), edges);
  const clusters: IdentityCluster[] = [];
  const contradictions: GraphEdge[] = [];
  let cid = 0;

  for (const group of groups) {
    const labelMap = new Map<string, GraphNode[]>();
    const labelless: string[] = [];
    for (const id of group) {
      const n = byId.get(id)!;
      const lbl = personLabel(n);
      if (lbl) {
        const arr = labelMap.get(lbl) ?? [];
        arr.push(n);
        labelMap.set(lbl, arr);
      } else {
        labelless.push(id);
      }
    }
    const labels = [...labelMap.keys()];

    if (labels.length >= 2) {
      const reps: GraphNode[] = [];
      for (const lbl of labels) {
        const members = labelMap.get(lbl)!;
        const rep = members.find((n) => n.type === "person") ?? members[0];
        reps.push(rep);
        clusters.push({
          id: `c${cid++}`,
          label: lbl,
          nodeIds: members.map((n) => n.id),
          conflicted: true,
          ambiguous: false,
        });
      }
      if (labelless.length) {
        clusters.push({ id: `c${cid++}`, label: null, nodeIds: labelless, conflicted: true, ambiguous: true });
      }
      for (let i = 0; i < reps.length; i++) {
        for (let j = i + 1; j < reps.length; j++) {
          contradictions.push({
            from: reps[i].id,
            to: reps[j].id,
            type: "contradicts",
            source: "cluster_split",
            weight: 1,
          });
        }
      }
    } else {
      clusters.push({
        id: `c${cid++}`,
        label: labels[0] ?? null,
        nodeIds: group,
        conflicted: false,
        ambiguous: false,
      });
    }
  }
  return { clusters, contradictions };
}

// ---- Confidence propagation (Phase 2) --------------------------------------

export interface PropagatedScore {
  base: number;
  adjusted: number;
  support: number;
  penalty: number;
  conflicted: boolean;
  overBroad: boolean;
  deadEnd: boolean;
}

function capForNode(node: GraphNode, overBroad: boolean): number {
  if (overBroad) return SOURCE_CLASS_WEIGHT.generic; // 20
  const evid = node.evidence ?? [];
  const onlyMarketing = evid.length > 0 && evid.every((e) => e.sourceClass === "marketing");
  return onlyMarketing ? SOURCE_CLASS_WEIGHT.marketing : 100; // 30 / 100
}

/** Final confidence for a node after graph propagation. Support neighbors add
 *  corroboration (dead-ends excluded); a conflicted cluster penalizes every
 *  member; generic/marketing caps from gradeConfidence are preserved. */
export function propagateConfidence(
  node: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
  clustering: Clustering,
): PropagatedScore {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const base = gradeConfidence(node);
  const deadEnd = isDeadEnd(node);

  let supportNeighbors = 0;
  for (const e of edges) {
    if (!SUPPORT_FOR_SCORE.has(e.type)) continue;
    const other = e.from === node.id ? e.to : e.to === node.id ? e.from : null;
    if (!other) continue;
    const nb = byId.get(other);
    if (!nb || isDeadEnd(nb)) continue; // dead-ends never strengthen a neighbor
    supportNeighbors++;
  }
  const support = deadEnd ? 0 : Math.min(supportNeighbors * SUPPORT_STEP, SUPPORT_CAP);

  const cluster = clustering.clusters.find((c) => c.nodeIds.includes(node.id));
  const conflicted = !!cluster?.conflicted;
  const penalty = conflicted ? CONTRADICTION_PENALTY : 0;

  const cap = capForNode(node, base.overBroad);
  const adjusted = Math.max(0, Math.min(base.score + support - penalty, cap));

  return { base: base.score, adjusted, support, penalty, conflicted, overBroad: base.overBroad, deadEnd };
}
