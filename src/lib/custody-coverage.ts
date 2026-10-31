/**
 * Chain-of-custody coverage: how many artifacts have at least one evidence_log row.
 *
 * WHY NOT `artifact_id`. Every writer of `append_evidence` passes
 * `_artifact_id: null` (record_artifacts, recording tools, auto-persist, cache).
 * Measured 2026-10-30: all 17,575 production evidence_log rows have a NULL
 * artifact_id. Counting distinct artifact_ids therefore always produced 1 (the
 * single NULL), so the Intelligence tab read "1/N" and flagged a coverage failure
 * that was really a missing link.
 *
 * An evidence row records the same thread, kind and value as the artifact it was
 * appended for, so that triple is the join key. A non-null artifact_id, once the
 * writers send one, is honoured first.
 */

export type CoverageArtifact = { id: string; thread_id: string; kind: string; value: string | null };
export type CoverageEvidence = {
  artifact_id: string | null;
  thread_id: string | null;
  kind: string | null;
  value: string | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const tripleKey = (thread: string | null, kind: string | null, value: string | null) =>
  `${thread ?? ""}\u0000${norm(kind)}\u0000${norm(value)}`;

export function countCustodyCovered(
  artifacts: readonly CoverageArtifact[],
  evidence: readonly CoverageEvidence[],
): number {
  const ids = new Set<string>();
  const triples = new Set<string>();
  for (const e of evidence) {
    if (e.artifact_id) ids.add(e.artifact_id);
    if (e.thread_id && norm(e.value)) triples.add(tripleKey(e.thread_id, e.kind, e.value));
  }
  let covered = 0;
  for (const a of artifacts) {
    if (ids.has(a.id) || (norm(a.value) && triples.has(tripleKey(a.thread_id, a.kind, a.value)))) covered++;
  }
  return covered;
}
