import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  buildIdentityClusters,
  groupForKind,
  normalizeHandle,
  type Group,
} from "@/lib/intel";
import { isCollisionArtifact } from "@/lib/report-hygiene";

/**
 * Entity-connection graph transform — PURE and DETERMINISTIC.
 *
 * Turns the case artifacts into a node/edge model the Graph tab can draw. Two
 * hard rules keep it honest (this is an evidence tool):
 *
 *  1. Edges are DERIVED, never invented. Every edge comes from a real signal in
 *     the data — two artifacts sharing a normalized selector (email / phone /
 *     handle / ip / address / wallet), a shared parent-seed pointer, or (as a
 *     faint last resort) the fact an artifact was discovered under the seed.
 *     Each edge carries a human `reason` so it is auditable on hover.
 *  2. Infrastructure selectors (ip / address / wallet) never imply identity —
 *     they render as weak "shared-infra" links, distinct from identity links,
 *     so a shared IP is never mistaken for "same person".
 *
 * Clustering is reused READ-ONLY from intel.buildIdentityClusters (the
 * integrity-critical merge logic is untouched) purely to group nodes spatially
 * and to mark cross-cluster BRIDGE edges. Layout is computed from a stable
 * id-sort + golden-angle spiral, so the same case always settles to the same
 * frame — no jitter on re-render, snapshot-stable.
 */

export const SEED_ID = "__seed__";

export type EdgeType = "identity" | "shared-infra" | "seed-discovery";

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  group: Group;
  confidence: number; // 0-100 (seed = 100)
  isSeed: boolean;
  conflict: boolean; // collision / conflict / breach — restrained destructive accent
  clusterId: string | null;
  degree: number;
  x: number;
  y: number;
  art: Artifact | null; // null only for the synthetic seed node
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  reason: string; // human-readable WHY, for tooltip + a11y
  strength: number; // 0-1 — drives edge opacity/width
  bridge: boolean; // connects two different identity clusters
}

export interface GraphCluster {
  id: string;
  label: string;
  confidence: number;
  warnings: string[];
}

export interface EntityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  warnings: string[];
  stats: {
    nodeCount: number; // excludes the synthetic seed
    edgeCount: number;
    realEdgeCount: number; // identity + shared-infra (excludes seed-discovery fallback)
    clusterCount: number;
    bridgeCount: number;
    isolatedCount: number; // nodes only tied to the seed by the discovery fallback
  };
}

type SelectorKind = "email" | "phone" | "handle" | "ip" | "address" | "wallet" | "parent";

interface Selector {
  key: string;
  kind: SelectorKind;
  raw: string;
}

/** Relative trust of each selector class (0-1). Email/phone are the strongest
 * single proofs; infrastructure is weak; a parent pointer is provenance only. */
const SELECTOR_STRENGTH: Record<SelectorKind, number> = {
  email: 0.7,
  phone: 0.7,
  handle: 0.5,
  wallet: 0.4,
  address: 0.35,
  ip: 0.3,
  parent: 0.15,
};

const INFRA_KINDS = new Set<SelectorKind>(["ip", "address", "wallet"]);

function normIp(v: string): string {
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return m.slice(1).map((n) => String(parseInt(n, 10))).join(".");
  return v.toLowerCase();
}

/**
 * Extract the normalized selectors an artifact carries. Mirrors the selector
 * vocabulary used elsewhere (email/phone/handle/ip/address/wallet/parent) but
 * is a standalone pure function — it does NOT reach into the clustering closure.
 */
function selectorsFor(kind: string, value: string, metadata: Record<string, unknown> | null): Selector[] {
  const hits: Selector[] = [];
  const k = kind.toLowerCase();
  const v = (value ?? "").trim();
  const meta = metadata ?? {};

  if (k === "email" && v) hits.push({ key: `email:${v.toLowerCase()}`, kind: "email", raw: v });
  if (k === "phone" && v) {
    const d = v.replace(/\D+/g, "");
    if (d) hits.push({ key: `phone:${d}`, kind: "phone", raw: v });
  }

  const handleRaws: string[] = [];
  if ((k === "username" || k === "handle" || k === "social") && v) handleRaws.push(v);
  if (typeof meta.handle === "string" && (meta.handle as string).trim()) handleRaws.push((meta.handle as string).trim());
  for (const raw of handleRaws) {
    const n = normalizeHandle(raw);
    if (n) hits.push({ key: `handle:${n}`, kind: "handle", raw });
  }

  if (k === "ip" && v) hits.push({ key: `ip:${normIp(v)}`, kind: "ip", raw: v });
  if (k === "address" && v) hits.push({ key: `address:${v.toLowerCase().replace(/\s+/g, " ")}`, kind: "address", raw: v });
  if ((k === "wallet" || k === "crypto_wallet" || k === "crypto") && v) {
    hits.push({ key: `wallet:${v.toLowerCase()}`, kind: "wallet", raw: v });
  }

  const parent = String(meta.parent ?? meta.parent_seed ?? meta.seed ?? "").trim().toLowerCase();
  if (parent) hits.push({ key: `parent:${parent}`, kind: "parent", raw: parent });

  return hits;
}

function isConflict(a: Artifact): boolean {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  const k = a.kind.toLowerCase();
  return (
    isCollisionArtifact(a) ||
    m.conflict === true ||
    m.collision === true ||
    m.false_positive === true ||
    k === "breach" ||
    k.endsWith("_conflict")
  );
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈2.39996 rad
const CX = 500;
const CY = 360;
const round1 = (n: number) => Math.round(n * 10) / 10;

const EDGE_PRIORITY: Record<EdgeType, number> = { identity: 3, "shared-infra": 2, "seed-discovery": 1 };

/**
 * Build the deterministic entity-connection graph for a case.
 *
 * @param artifacts the case artifact set (already de-duped by the hook)
 * @param seedValue the investigation seed value (the anchor node)
 * @param seedType  the seed's kind (email / username / …)
 */
export function buildEntityGraph(
  artifacts: Artifact[],
  seedValue: string | null,
  seedType: string | null,
): EntityGraph {
  // Stable ordering: everything downstream (selector heroes, layout angles)
  // derives from this sort, so the same case always produces the same frame.
  const sorted = [...artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- Nodes ------------------------------------------------------------
  const clusterReport = buildIdentityClusters(artifacts, seedValue);
  const clusterOf = new Map<string, string>();
  for (const c of clusterReport.clusters) {
    for (const a of c.artifacts) clusterOf.set(a.id, c.id);
  }

  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();
  const seedNode: GraphNode | null = seedValue
    ? {
        id: SEED_ID,
        label: seedValue,
        kind: seedType ?? "seed",
        group: groupForKind(seedType ?? ""),
        confidence: 100,
        isSeed: true,
        conflict: false,
        clusterId: null,
        degree: 0,
        x: CX,
        y: CY,
        art: null,
      }
    : null;
  if (seedNode) {
    nodes.push(seedNode);
    nodeById.set(SEED_ID, seedNode);
  }

  for (const a of sorted) {
    const node: GraphNode = {
      id: a.id,
      label: a.value,
      kind: a.kind,
      group: groupForKind(a.kind),
      confidence: a.confidence ?? 0,
      isSeed: false,
      conflict: isConflict(a),
      clusterId: clusterOf.get(a.id) ?? null,
      degree: 0,
      x: CX,
      y: CY,
      art: a,
    };
    nodes.push(node);
    nodeById.set(a.id, node);
  }

  // ---- Selector index ---------------------------------------------------
  // Collision/false-positive artifacts may still appear as (conflict) nodes,
  // but must NOT seed identity edges — exactly the clustering rule.
  const selectorMembers = new Map<string, { kind: SelectorKind; raw: string; ids: string[] }>();
  const addSelectors = (id: string, sels: Selector[]) => {
    for (const s of sels) {
      const bucket = selectorMembers.get(s.key) ?? { kind: s.kind, raw: s.raw, ids: [] };
      if (!bucket.ids.includes(id)) bucket.ids.push(id);
      selectorMembers.set(s.key, bucket);
    }
  };
  if (seedNode && seedValue) {
    const seedSels = selectorsFor(seedType ?? "", seedValue, null);
    // The seed also anchors any artifact tagged with it as a parent pointer.
    seedSels.push({ key: `parent:${seedValue.trim().toLowerCase()}`, kind: "parent", raw: seedValue });
    addSelectors(SEED_ID, seedSels);
  }
  for (const a of sorted) {
    if (isCollisionArtifact(a) || (a.metadata as Record<string, unknown> | null)?.false_positive === true) continue;
    addSelectors(a.id, selectorsFor(a.kind, a.value, a.metadata));
  }

  // ---- Edges ------------------------------------------------------------
  // For each selector shared by ≥2 nodes, connect members as a STAR to the
  // highest-confidence holder (N-1 edges, not N²/2 — no hairball).
  const edgeMap = new Map<string, GraphEdge>();
  const conf = (id: string) => nodeById.get(id)?.confidence ?? 0;

  const upsertEdge = (aId: string, bId: string, type: EdgeType, reason: string, strength: number) => {
    if (aId === bId) return;
    const [s, t] = aId < bId ? [aId, bId] : [bId, aId];
    const key = `${s}__${t}`;
    const existing = edgeMap.get(key);
    if (!existing || EDGE_PRIORITY[type] > EDGE_PRIORITY[existing.type]) {
      edgeMap.set(key, { id: key, source: s, target: t, type, reason, strength, bridge: false });
    }
  };

  for (const [, bucket] of selectorMembers) {
    if (bucket.ids.length < 2) continue;
    // Hero = highest confidence (ties broken by id for determinism).
    const hero = [...bucket.ids].sort((a, b) => conf(b) - conf(a) || (a < b ? -1 : 1))[0];
    const infra = INFRA_KINDS.has(bucket.kind);
    const isParent = bucket.kind === "parent";
    for (const id of bucket.ids) {
      if (id === hero) continue;
      let type: EdgeType;
      let reason: string;
      if (isParent) {
        const seedTied = hero === SEED_ID || id === SEED_ID;
        type = seedTied ? "seed-discovery" : "shared-infra";
        reason = seedTied
          ? `Discovered under seed ${bucket.raw}`
          : `Shares parent pointer ${bucket.raw}`;
      } else if (infra) {
        type = "shared-infra";
        reason = `Shares ${bucket.kind} ${bucket.raw} — shared infrastructure, not an identity match`;
      } else {
        type = "identity";
        reason = `Shares ${bucket.kind} ${bucket.raw}`;
      }
      upsertEdge(hero, id, type, reason, SELECTOR_STRENGTH[bucket.kind]);
    }
  }

  // Seed-discovery fallback: nothing should float unexplained. Any non-seed
  // node with no edge yet ties to the seed with a faint provenance edge — this
  // is honest (it WAS surfaced under the seed), and visibly the weakest link.
  if (seedNode) {
    const connected = new Set<string>();
    for (const e of edgeMap.values()) {
      connected.add(e.source);
      connected.add(e.target);
    }
    for (const n of nodes) {
      if (n.isSeed || connected.has(n.id)) continue;
      upsertEdge(SEED_ID, n.id, "seed-discovery", `Discovered while investigating ${seedNode.label}`, SELECTOR_STRENGTH.parent);
    }
  }

  const edges = [...edgeMap.values()];

  // Bridge = an edge whose endpoints sit in two DIFFERENT identity clusters.
  for (const e of edges) {
    const ca = nodeById.get(e.source)?.clusterId ?? null;
    const cb = nodeById.get(e.target)?.clusterId ?? null;
    if (ca && cb && ca !== cb) e.bridge = true;
  }

  // Degrees.
  for (const e of edges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (a) a.degree++;
    if (b) b.degree++;
  }

  // ---- Layout (deterministic constellation) -----------------------------
  layout(nodes, nodeById, clusterReport.clusters);

  const realEdgeCount = edges.filter((e) => e.type !== "seed-discovery").length;
  // Every seed-discovery edge is built touching the seed, so this counts the
  // nodes that only tie in via the faint provenance fallback.
  const isolatedCount = edges.filter((e) => e.type === "seed-discovery").length;

  return {
    nodes,
    edges,
    clusters: clusterReport.clusters.map((c) => ({ id: c.id, label: c.label, confidence: c.confidence, warnings: c.warnings })),
    warnings: clusterReport.warnings,
    stats: {
      nodeCount: nodes.filter((n) => !n.isSeed).length,
      edgeCount: edges.length,
      realEdgeCount,
      clusterCount: clusterReport.clusters.length,
      bridgeCount: edges.filter((e) => e.bridge).length,
      isolatedCount,
    },
  };
}

/** Place the seed at center, cluster discs on a golden-angle spiral (pulled
 * inward by cluster confidence), members phyllotaxis-packed inside each disc,
 * and unclustered nodes on an outer ring grouped by category. Fully
 * deterministic — positions depend only on the stable input ordering. */
function layout(
  nodes: GraphNode[],
  nodeById: Map<string, GraphNode>,
  clusters: { id: string; confidence: number; matchesSeedLocation: boolean | null; artifacts: Artifact[] }[],
): void {
  // Cluster discs.
  const ordered = [...clusters].sort(
    (a, b) =>
      (a.matchesSeedLocation === true ? 0 : 1) - (b.matchesSeedLocation === true ? 0 : 1) ||
      b.confidence - a.confidence ||
      (a.id < b.id ? -1 : 1),
  );
  ordered.forEach((c, i) => {
    const angle = i * GOLDEN;
    const baseR = 150 + 58 * Math.sqrt(i);
    const effR = baseR * (1 - 0.22 * (c.confidence / 100)); // higher confidence → closer in
    const ccx = CX + Math.cos(angle) * effR;
    const ccy = CY + Math.sin(angle) * effR;
    const members = c.artifacts
      .map((a) => nodeById.get(a.id))
      .filter((n): n is GraphNode => !!n)
      .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));
    const discR = 24 + 9 * Math.sqrt(Math.max(0, members.length - 1));
    members.forEach((n, j) => {
      if (j === 0) {
        n.x = round1(ccx);
        n.y = round1(ccy);
        return;
      }
      const rr = discR * Math.sqrt(j / members.length);
      const aa = j * GOLDEN;
      n.x = round1(ccx + Math.cos(aa) * rr);
      n.y = round1(ccy + Math.sin(aa) * rr);
    });
  });

  // Unclustered nodes (not the seed) → outer ring, grouped by category for
  // legibility, deterministic by GROUP order then id.
  const unclustered = nodes
    .filter((n) => !n.isSeed && !n.clusterId)
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.id < b.id ? -1 : 1));
  const outerR = 150 + 58 * Math.sqrt(Math.max(1, clusters.length)) + 70;
  const n = unclustered.length;
  unclustered.forEach((node, k) => {
    const angle = (k / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const ring = outerR + (k % 2) * 34;
    node.x = round1(CX + Math.cos(angle) * ring);
    node.y = round1(CY + Math.sin(angle) * ring);
  });
}
