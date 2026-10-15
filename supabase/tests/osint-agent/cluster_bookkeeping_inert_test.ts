// cluster_bookkeeping_inert_test.ts — the agent's own setup rows are not evidence.
//
// Measured on a live case (2026-10-06): the Stage-1 `triage_decision` row
// ("Stage 2 OPEN for <handle>") carries the seed handle in its text, so it joined
// the subject's cluster on it — and, being written first, it became the
// `owners[0]` anchor that 13 of 15 logged merges paired a real finding with.
// Across production a `triage_decision` row shares a cluster with real findings in
// 68 of the 107 threads that have one. A control record is not an observation about
// the subject: it must be neither a member nor the anchor.
//
// Synthetic, non-sensitive fixtures only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clusterArtifacts,
  clusterBookkeepingInertDisabled,
  clusterBookkeepingSelfTest,
  isBookkeepingArtifact,
  isClusterInert,
  type Artifact,
} from "../../functions/osint-agent/lib/cluster.ts";

const art = (over: Partial<Artifact>): Artifact => ({
  kind: "other", value: "x", source: "s", confidence: 50, metaRaw: "{}", ...over,
});

const HANDLE = "samplehandle42";
const triage = art({ kind: "triage_decision", value: `triage_decision: Stage 2 OPEN for ${HANDLE}`, source: "triage_seed", confidence: 0, metaRaw: '{"label":"triage_decision"}' });
const username = art({ kind: "username", value: HANDLE, source: "username_sweep", confidence: 50 });
const profile = art({ kind: "social_profile", value: `https://soundcloud.example.test/${HANDLE}`, source: "username_sweep", confidence: 60 });
const music = art({ kind: "music_profile", value: `https://audiomack.example.test/${HANDLE}`, source: "exa_search", confidence: 50 });

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

Deno.test("a setup row written FIRST is not a cluster member and not the merge anchor", () => {
  const { members, decisions } = clusterArtifacts([triage, username, profile, music]);
  assertEquals(members[0].cluster_id, null, "the triage row must not belong to any cluster");
  assertEquals(members[0].subject_id, null);
  const real = members.slice(1);
  assert(real.every((m) => m.cluster_id !== null && m.cluster_id === real[0].cluster_id), "the real rows still join on the handle");
  assert(
    decisions.every((d) => !d.a.startsWith("triage_decision") && !d.b.startsWith("triage_decision")),
    "no logged merge may pair a finding with the setup row",
  );
  assert(decisions.length >= 2, "the real merges are still recorded");
});

Deno.test("removing the setup row does not change the real cluster", () => {
  const withRow = clusterArtifacts([triage, username, profile, music]);
  const without = clusterArtifacts([username, profile, music]);
  assertEquals(withRow.members.slice(1).map((m) => m.cluster_id), without.members.map((m) => m.cluster_id));
  assertEquals(withRow.subjects.length, without.subjects.length);
  assertEquals(withRow.subjects[0].members.length, 3, "the cluster holds the three real rows, not four");
});

Deno.test("the setup row keeps its own tier — inert is NOT 'Excluded'", () => {
  const { members } = clusterArtifacts([triage, username]);
  assert(members[0].tier !== "Excluded", `bookkeeping must not be painted as an excluded collision, got ${members[0].tier}`);
});

Deno.test("every bookkeeping kind is inert; a finding that merely MENTIONS one is not", () => {
  for (const kind of ["triage_decision", "cluster_decision", "coverage_audit", "tool_audit"]) {
    const a = art({ kind, value: `${kind}: ${HANDLE}` });
    assert(isBookkeepingArtifact(a), kind);
    assert(isClusterInert(a), kind);
  }
  const mention = art({ kind: "finding", value: `triage_decision was recorded for ${HANDLE}` });
  assert(!isBookkeepingArtifact(mention), "structural on kind/label, never on value text");
  assert(!isClusterInert(mention));
});

Deno.test("a row stamped label:cluster_decision under a generic kind is inert", () => {
  assert(isBookkeepingArtifact(art({ kind: "other", metaRaw: '{"label":"cluster_decision"}' })));
});

Deno.test("excluded rows stay inert exactly as before", () => {
  const ex = art({ kind: "excluded_collision", value: HANDLE });
  assert(isClusterInert(ex));
});

Deno.test("CLUSTER_BOOKKEEPING_INERT_DISABLED=true restores the old behaviour (the setup row clusters)", async () => {
  await withEnv("CLUSTER_BOOKKEEPING_INERT_DISABLED", "true", () => {
    assert(clusterBookkeepingInertDisabled());
    const { members } = clusterArtifacts([triage, username, profile]);
    assert(members[0].cluster_id !== null, "legacy: the triage row joined the handle cluster");
    assertEquals(members[0].cluster_id, members[1].cluster_id);
  });
  await withEnv("CLUSTER_BOOKKEEPING_INERT_DISABLED", undefined, () => {
    assert(!clusterBookkeepingInertDisabled());
  });
});

Deno.test("the /health self-test engages and reports ok", () => {
  const t = clusterBookkeepingSelfTest();
  assert(t.ok, t.detail);
});
