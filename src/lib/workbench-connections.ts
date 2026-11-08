import type { EntityGraph, GraphEdge, GraphNode } from "@/lib/entity-graph";
import { isIsolatedLead, linkedNodeIds, SEED_ID } from "@/lib/entity-graph";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isNegativeResultArtifact, LOOKUP_RESULT_KINDS } from "@/lib/intel";
import { isClusterIneligible, isNullResultValue } from "@/lib/report-hygiene";
import { isBreachKind } from "@/lib/breach-kinds";
import { caseLacksSubject } from "@/lib/set-subject";

/** Metadata keys a lookup tool writes its result summary into ("breach_check_result": "0 hits"). */
const RESULT_KEY_RE = /_result$/;
/** Lookup statuses that mean the check did NOT run to completion (`not_found` is a completed zero, so it is absent). */
const FAILED_LOOKUP_STATUSES = new Set(["restricted", "blocked", "denied", "error"]);

/** A refused or failed lookup established nothing: it is missing coverage, never a clean check. */
function isFailedLookup(a: Artifact): boolean {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const status = typeof meta.lookup_status === "string" ? meta.lookup_status.trim().toLowerCase() : "";
  if (FAILED_LOOKUP_STATUSES.has(status)) return true;
  const http = Number(meta.http_status);
  return Number.isFinite(http) && http >= 400;
}

/**
 * A lookup that found NOTHING: coverage, not a candidate. Three shapes, any one suffices: numeric zero counters
 * (`isNegativeResultArtifact`), a null-result value ("port162 - no breach hits"), or — on a lookup-result kind only —
 * every `*_result` string in metadata reading as a null result. The last shape is what model-authored rows carry
 * (`breach_check_result: "0 hits"` as a STRING), which the numeric predicate cannot see. One positive result string
 * keeps the row a candidate. A failed or refused lookup (`isNegativeResultArtifact` also accepts those) is excluded:
 * it did not establish absence, so calling it "found nothing" would present missing coverage as a negative result.
 */
export function isCleanCheck(a: Artifact): boolean {
  if (isFailedLookup(a)) return false;
  if (isNegativeResultArtifact(a) || isNullResultValue(a.value, a.source)) return true;
  if (!LOOKUP_RESULT_KINDS.has(String(a.kind ?? "").toLowerCase())) return false;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const results = Object.entries(meta)
    .filter(([k, v]) => RESULT_KEY_RE.test(k) && typeof v === "string" && v.trim())
    .map(([, v]) => v as string);
  return results.length > 0 && results.every((v) => isNullResultValue(v, a.source));
}

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
  /** Unlinked lookups that found nothing (`isCleanCheck`): kept out of `isolated`, disclosed as a count. */
  cleanChecks: number;
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
  const unlinked = graph.nodes.filter((n) => isIsolatedLead(n, linkedIds));
  const isolated = unlinked
    .filter((n) => !(n.art && isCleanCheck(n.art)))
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label));
  return {
    linked,
    isolated,
    isolatedLeads: isolated.length,
    cleanChecks: unlinked.length - isolated.length,
    seedRecords: graph.stats.seedRecordCount,
    realLinks: graph.stats.realEdgeCount,
    clusters: graph.stats.clusterCount,
  };
}

/**
 * Why a case reads "0 evidence links" — measured, not guessed.
 *
 * Measured on a live upload-started case (2026-11-08): 70 rows, 0 links, 70
 * "unlinked candidates", while the analyst could see the same mailboxes and
 * handle repeated across uploads and scans. Every one of those repetitions sat
 * behind a gate this panel never named:
 *  - breach records may group selectors but never forge an identity edge
 *    (`entity-graph.ts`, the `isConflict` skip; integrity rule, unchanged here);
 *  - quarantined rows lend no linkage (`isClusterIneligible`);
 *  - an upload-only case has no subject for anything to link to (`caseLacksSubject`).
 * This only COUNTS rows behind those gates so the panel can say so. It changes no
 * edge, cluster, authority or confidence.
 */
export interface UnlinkedReasons {
  total: number;
  /** Breach/leak rows outside quarantine: they can co-record, never prove identity. */
  breachOnly: number;
  /** Rows under active quarantine or a collision flag. */
  quarantined: number;
  /** The case was started from an upload and has no subject selector. */
  noSubject: boolean;
}

export function unlinkedReasons(items: Artifact[], seedValue: string | null): UnlinkedReasons {
  let breachOnly = 0;
  let quarantined = 0;
  for (const a of items) {
    if (isClusterIneligible(a)) quarantined += 1;
    else if (isBreachKind(a.kind)) breachOnly += 1;
  }
  return { total: items.length, breachOnly, quarantined, noSubject: caseLacksSubject(seedValue) };
}
