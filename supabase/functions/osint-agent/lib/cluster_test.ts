// lib/cluster_test.ts — C-1 acceptance: deterministic, LLM-independent clustering +
// confidence promotion over the real ccc149bc artifact set (passwords redacted).
// If these fail, STOP and re-plan — do not patch forward.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { clusterArtifacts, clusterUpdatesFor, parseArtifactsCsv, type Artifact, type ClusterMember, type ClusterResult } from "./cluster.ts";

const CCC = parseArtifactsCsv(Deno.readTextFileSync(new URL("./fixtures/ccc149bc-artifacts.csv", import.meta.url)));
const E29 = parseArtifactsCsv(Deno.readTextFileSync(new URL("./fixtures/e29aa8c9-artifacts.csv", import.meta.url)));

function run(): ClusterResult { return clusterArtifacts(CCC); }
const has = (m: ClusterMember[], sub: string) => m.some((x) => x.value.includes(sub));
const subjectWith = (r: ClusterResult, sub: string) => r.subjects.find((s) => has(s.members, sub));

Deno.test("C-1: parses the real 73-artifact export (truncated metadata tolerated)", () => {
  assertEquals(CCC.length, 73);
  assert(E29.length > 0);
});

Deno.test("C-1: ≥90% of non-excluded artifacts get a non-null cluster_id AND subject_id", () => {
  const { members } = run();
  const nonExcluded = members.filter((m) => m.tier !== "Excluded");
  const clustered = nonExcluded.filter((m) => m.cluster_id !== null && m.subject_id !== null);
  assert(clustered.length / nonExcluded.length >= 0.9, `only ${clustered.length}/${nonExcluded.length} clustered`);
});

Deno.test("C-1: the Oakland identity is ONE subject containing all its aliases + proton email", () => {
  const r = run();
  const oakland = subjectWith(r, "616manii + ManzaVisuals + Hamza Shakoor = SAME");
  assert(oakland, "the self-admission artifact must belong to a subject");
  // Every acceptance alias lands in that SAME subject.
  assert(has(oakland!.members, "616manii"), "616manii in Oakland subject");
  assert(oakland!.members.some((m) => m.value === "manza_visuals"), "manza_visuals username");
  assert(oakland!.members.some((m) => m.value === "ManzaVisuals"), "ManzaVisuals");
  assert(oakland!.members.some((m) => /YouTube/.test(m.value) && /manzavisuals/i.test(m.value)), "@manzavisuals YouTube");
  assert(oakland!.members.some((m) => /TikTok/.test(m.value) && /manza_visuals/i.test(m.value)), "@manza_visuals TikTok");
  assert(has(oakland!.members, "manzavisuals@proton.me"), "proton.me email joined");
  assert(oakland!.members.some((m) => m.kind === "name" && m.value === "Hamza Shakoor"), "Hamza Shakoor name joined via self-admission");
});

Deno.test("C-1: the self-admission core identity artifact is promoted to ≥90 (Confirmed)", () => {
  const r = run();
  const core = r.members.find((m) => m.value.includes("= SAME PERSON"));
  assert(core, "core '= SAME' artifact present");
  assert(core!.promoted_confidence >= 90, `core promoted to ${core!.promoted_confidence}, want ≥90`);
  assertEquals(core!.tier, "Confirmed");
});

Deno.test("C-1: the Pakistani same-name person stays SEPARATE from Oakland", () => {
  const r = run();
  const oakland = subjectWith(r, "= SAME PERSON")!;
  const pak = subjectWith(r, "hamzashakoor77@yahoo.com");
  assert(pak, "yahoo cluster exists");
  assert(pak!.subjectId !== oakland.subjectId, "Pakistani yahoo must NOT be the Oakland subject");
  // The GitHub 'Muhammad Hamza Shakoor' confirmation is an excluded_collision — never joined.
  const github = r.members.find((m) => m.value.includes("Muhammad Hamza Shakoor"));
  assert(github && github.tier === "Excluded" && github.cluster_id === null, "Muhammad Hamza Shakoor GitHub excluded");
  // The Lahore IP is not pulled into Oakland.
  const lahore = r.members.find((m) => m.value.startsWith("182.177.92.225"));
  assert(lahore && lahore.subject_id !== oakland.subjectId, "Lahore IP not in Oakland subject");
});

Deno.test("C-1: the contradicted gmail is capped at 40 and NOT joined to Oakland", () => {
  const r = run();
  const oakland = subjectWith(r, "= SAME PERSON")!;
  const gmailMembers = r.members.filter((m) => m.kind === "email" && m.value === "hamzashakoor@gmail.com");
  assert(gmailMembers.length >= 1, "gmail email artifacts present");
  for (const g of gmailMembers) {
    assert(g.promoted_confidence <= 40, `gmail promoted to ${g.promoted_confidence}, must stay ≤40 (contradiction)`);
    assert(g.subject_id !== oakland.subjectId, "contradicted gmail must not join Oakland");
  }
});

Deno.test("C-1: excluded_collision artifacts stay excluded (untouched, no cluster)", () => {
  const r = run();
  const excluded = r.members.filter((m) => m.kind === "excluded_collision");
  assert(excluded.length === 3, `expected 3 excluded, got ${excluded.length}`);
  for (const e of excluded) {
    assertEquals(e.tier, "Excluded");
    assertEquals(e.cluster_id, null);
    assertEquals(e.promoted_confidence, e.confidence); // untouched
  }
});

Deno.test("C-1: clustering is LLM-independent + deterministic (identical on re-run)", () => {
  const a = clusterArtifacts(CCC), b = clusterArtifacts(CCC);
  const ids = (r: ClusterResult) => r.members.map((m) => `${m.value.slice(0, 20)}=${m.subject_id}`).sort();
  assertEquals(ids(a), ids(b), "same input → identical clustering (no randomness, no LLM)");
});

Deno.test("C-1: every merge is logged with the matched selector + rule (debuggable)", () => {
  const r = run();
  assert(r.decisions.length > 0, "merges recorded");
  for (const d of r.decisions.slice(0, 5)) {
    assert(d.shared_selector.includes(":"), "decision names the shared selector");
    assert(d.rule.length > 0, "decision names the rule");
  }
});

Deno.test("C-1: clusterUpdatesFor emits DB updates only for id-carrying rows", () => {
  // Fixtures have no ids → no updates.
  assertEquals(clusterUpdatesFor(CCC).length, 0);
  // Attach ids → one update per artifact, carrying cluster_id + promoted confidence.
  const withIds: Artifact[] = CCC.map((a, i) => ({ ...a, id: `id-${i}` }));
  const updates = clusterUpdatesFor(withIds);
  assertEquals(updates.length, withIds.length);
  const core = updates.find((u) => u.tier === "Confirmed");
  assert(core && core.promoted_confidence >= 90 && core.subject_id?.startsWith("subj_"), "confirmed update carries subject_id + ≥90");
  // Excluded rows surface null cluster ids in the update set.
  assert(updates.some((u) => u.cluster_id === null), "excluded rows → null cluster_id update");
});
