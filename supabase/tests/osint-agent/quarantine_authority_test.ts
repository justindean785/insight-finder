/**
 * quarantine_authority_test.ts — `subject_unlinked` must bind every authority
 * boundary, not just clustering.
 *
 * P0-A closed the WRITE path: a name-only query's root `name` row now carries
 * `subject_unlinked` unless the queried name is the investigation's seed. But the
 * flag only ever bound ONE reader — `lib/cluster.ts:isExcluded`. Three others read
 * the artifacts table and never consulted it, so a quarantined row still reached
 * the analyst with authority it was explicitly denied:
 *
 *   1. tool-registry.ts — the planner's relationship hint builds graph NODES and
 *      infers identity EDGES from every artifact on the thread. A quarantined row
 *      became a node and could form an edge that steers the next pivot.
 *   2. tool-registry.ts — the collision detector counts distinct `source`s and
 *      `cluster_id`s for a value and emits a `contradiction` at >= 3 sources or
 *      >= 2 clusters. Quarantined rows inflated both counts.
 *   3. recovery.ts — the salvage report classifies rows for rendering, and a
 *      quarantined row classified as an ordinary `candidate` finding.
 *
 * THE CONTRACT — authority, not evidence:
 *   A quarantined row stays PERSISTED, VISIBLE and AUDITABLE. It may not count
 *   toward identity, corroboration, graph edges, promotion, salvage, or automatic
 *   investigative direction.
 *
 * FIXTURES ARE SYNTHETIC — RFC 2606 reserved domains, reserved 555-01xx phones.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildNodes } from "../../functions/osint-agent/graph.ts";
import { inferEdges } from "../../functions/osint-agent/graph_reasoning.ts";
import { collisionPeerSignal, isSubjectUnlinked } from "../../functions/osint-agent/lib/quarantine.ts";
import { buildRecoveredAssistantText, classifyRecoveryRow } from "../../functions/osint-agent/recovery.ts";

const SUBJECT_EMAIL = "subject@example.com";
const STRANGER_EMAIL = "stranger@example.com";
const SHARED_NAME = "Example Collision Name";

/** Metadata as auto-persist-findings.ts writes it for a quarantined row. */
const QUARANTINED = {
  auto_persist_source: "tool_return_extractor",
  subject_unlinked: true,
  subject_unlinked_reason: "harvested from a name-only query — same-name collision axis",
};
const LINKED = { auto_persist_source: "tool_return_extractor" };

// ---- 1. The predicate itself ------------------------------------------------

Deno.test("isSubjectUnlinked reads the flag and nothing else", () => {
  assert(isSubjectUnlinked(QUARANTINED), "an explicitly quarantined row");
  assert(!isSubjectUnlinked(LINKED), "a linked row");
  assert(!isSubjectUnlinked(null), "absent metadata is not an accusation");
  assert(!isSubjectUnlinked(undefined), "absent metadata is not an accusation");
  assert(!isSubjectUnlinked({ subject_unlinked: "true" }), "only a real boolean counts");
});

// ---- 2. Graph nodes and identity edges --------------------------------------

Deno.test("graph: a quarantined artifact contributes no node", () => {
  const nodes = buildNodes([
    { kind: "email", value: SUBJECT_EMAIL, confidence: 80, metadata: LINKED },
    { kind: "email", value: STRANGER_EMAIL, confidence: 45, metadata: QUARANTINED },
  ]);
  const values = nodes.map((n) => String(n.value ?? "").toLowerCase());
  assert(
    values.some((v) => v.includes("subject@example.com")),
    "the subject-linked row still builds a node",
  );
  assert(
    !values.some((v) => v.includes("stranger@example.com")),
    "a quarantined row may not become a graph node — a node can carry an identity edge",
  );
});

Deno.test("graph: a quarantined row cannot form an identity edge", () => {
  const nodes = buildNodes([
    { kind: "name", value: SHARED_NAME, confidence: 65, metadata: QUARANTINED },
    { kind: "email", value: STRANGER_EMAIL, confidence: 45, metadata: QUARANTINED },
  ]);
  assertEquals(nodes.length, 0, "nothing quarantined enters the graph at all");
  assertEquals(inferEdges(nodes).length, 0, "so no edge can be inferred from it");
});

Deno.test("graph: linked artifacts are untouched by the filter", () => {
  const arts = [
    { kind: "email", value: SUBJECT_EMAIL, confidence: 80, metadata: LINKED },
    { kind: "username", value: "subjecthandle710", confidence: 70, metadata: null },
    { kind: "domain", value: "example.com", confidence: 60 },
  ];
  assertEquals(buildNodes(arts).length, buildNodes(arts).length, "stable");
  assert(buildNodes(arts).length >= 3, "no over-filtering — absent metadata still builds nodes");
});

// ---- 3. Corroboration / collision peer counting -----------------------------

Deno.test("corroboration: quarantined peers count toward neither sources nor clusters", () => {
  const sig = collisionPeerSignal([
    { source: "oathnet_lookup", metadata: { ...LINKED, cluster_id: "c1" } },
    { source: "namesearch_a", metadata: { ...QUARANTINED, cluster_id: "c2" } },
    { source: "namesearch_b", metadata: { ...QUARANTINED, cluster_id: "c3" } },
  ]);
  assertEquals(sig.sources.length, 1, "only the linked peer is a corroborating source");
  assertEquals(sig.clusters.length, 1, "a quarantined row may not imply a second cluster");
});

Deno.test("corroboration: a genuine collision among LINKED peers still fires", () => {
  const sig = collisionPeerSignal([
    { source: "oathnet_lookup", metadata: { ...LINKED, cluster_id: "c1" } },
    { source: "leakcheck_v2", metadata: { ...LINKED, cluster_id: "c2" } },
    { source: "exa_search", metadata: LINKED },
  ]);
  assert(
    sig.sources.length >= 3 || sig.clusters.length >= 2,
    "the detector must still catch a real collision — this fix narrows, it does not disable",
  );
});

Deno.test("corroboration: a peer with no metadata still counts (absent ≠ quarantined)", () => {
  const sig = collisionPeerSignal([
    { source: "oathnet_lookup", metadata: null },
    { source: "leakcheck_v2" },
  ]);
  assertEquals(sig.sources.length, 2, "a legacy row is not silently disenfranchised");
});

// ---- 4. Salvage / recovery --------------------------------------------------

Deno.test("salvage: a quarantined row classifies as excluded, not as a finding", () => {
  assertEquals(
    classifyRecoveryRow({ kind: "name", value: SHARED_NAME, confidence: 65, metadata: QUARANTINED }),
    "excluded",
    "a quarantined row is not salvageable evidence",
  );
});

Deno.test("salvage: an ordinary auto-recorded row is still a candidate", () => {
  assertEquals(
    classifyRecoveryRow({ kind: "email", value: SUBJECT_EMAIL, confidence: 45, metadata: LINKED }),
    "candidate",
    "the fix must not demote every extractor row",
  );
});

Deno.test("salvage: the quarantined row is disclosed, not silently dropped", () => {
  const text = buildRecoveredAssistantText(
    { seed_value: SUBJECT_EMAIL, title: null, last_heartbeat_at: null, run_started_at: null },
    [
      { kind: "email", value: SUBJECT_EMAIL, confidence: 70, source: "oathnet_lookup", metadata: LINKED },
      { kind: "name", value: SHARED_NAME, confidence: 65, source: "namesearch", metadata: QUARANTINED },
    ],
  );
  assert(text.includes(SUBJECT_EMAIL), "the linked finding is still rendered");
  assert(
    !text.includes(SHARED_NAME),
    "the quarantined VALUE is withheld — it is another person's data (existing exclusion policy)",
  );
  assert(
    /ruled out/i.test(text) && /1 row/i.test(text),
    "but its existence IS disclosed by count and kind — visible and auditable, never silent",
  );
});
