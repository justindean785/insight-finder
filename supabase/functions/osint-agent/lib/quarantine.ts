// lib/quarantine.ts — the `subject_unlinked` authority boundary, in one place.
//
// P0-A (#433) made the WRITE path honest: a row harvested from a name-only query
// carries `subject_unlinked` in its metadata, including the echo of the queried
// name unless that name is the investigation's seed.
//
// This module is the READ side. Before it, the flag bound exactly one consumer —
// `lib/cluster.ts:isExcluded`, which parses the RAW metadata string for
// union-find. Every other reader holds a parsed metadata OBJECT and had no shared
// predicate to consult, so each one silently granted authority the write path had
// already denied.
//
// THE CONTRACT — authority, not evidence. A quarantined row stays persisted,
// visible and auditable. It may not count toward identity, corroboration, graph
// edges, promotion, salvage, or automatic investigative direction.

/**
 * Is this artifact's metadata marked `subject_unlinked`?
 *
 * Strictly `=== true`. A string "true", a truthy number, or an absent metadata
 * object are all NOT accusations — a legacy row with no metadata predates the
 * gate and must keep its authority rather than be silently disenfranchised.
 */
export function isSubjectUnlinked(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).subject_unlinked === true;
}

/** A peer row as the collision detector selects it: `source` + `metadata`. */
export type CollisionPeer = {
  source?: unknown;
  metadata?: Record<string, unknown> | null;
};

/**
 * Distinct corroborating `source`s and `cluster_id`s among a value's peer rows —
 * the two counts the collision detector thresholds on (>= 3 sources or >= 2
 * clusters emits a `contradiction`).
 *
 * QUARANTINED PEERS ARE SKIPPED. Both counts are corroboration measures: "three
 * independent sources carry this value" and "this value spans two identity
 * clusters". A row whose linkage to the subject is unproven can support neither
 * claim — counting it let a single name sweep manufacture a high-severity
 * contradiction out of strangers who merely share a name. This NARROWS the
 * detector; a collision among linked rows still fires unchanged.
 */
export function collisionPeerSignal(peers: readonly CollisionPeer[] | null | undefined): {
  sources: string[];
  clusters: string[];
} {
  const sources = new Set<string>();
  const clusters = new Set<string>();
  for (const p of peers ?? []) {
    if (isSubjectUnlinked(p?.metadata)) continue;
    if (p?.source) sources.add(String(p.source));
    const cid = (p?.metadata ?? {}).cluster_id;
    if (cid) clusters.add(String(cid));
  }
  return { sources: [...sources], clusters: [...clusters] };
}
