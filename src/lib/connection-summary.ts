import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { EntityGraph } from "@/lib/entity-graph";
import { isClusterIneligible } from "@/lib/report-hygiene";

export interface ConnectionSummary {
  /** Every entity in the case graph, the same figure the Graph tab's footer shows. */
  entities: number;
  clusters: number;
  /** identity + co-record + shared-infra edges; the seed-discovery fallback is excluded. */
  links: number;
  /** Clusters joined to another cluster. */
  bridges: number;
  /** Entities attached to the seed only by discovery, with no shared selector of their own. */
  unlinked: number;
  /** Rows withheld from linking (quarantine/collision). Disclosed, never counted as links. */
  withheld: number;
}

/** Counts read straight off the entity graph the Graph tab draws. */
export function summarizeConnections(graph: EntityGraph, artifacts: Artifact[]): ConnectionSummary {
  const s = graph.stats;
  return {
    entities: s.nodeCount,
    clusters: s.clusterCount,
    links: s.realEdgeCount,
    bridges: s.bridgeCount,
    unlinked: s.isolatedCount,
    withheld: artifacts.filter((a) => isClusterIneligible(a)).length,
  };
}
