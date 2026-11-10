// L1 replay harness — tests over SYNTHETIC fixtures only (the repo is public).
//
// Each fixture reproduces one shape measured on a production case on 2026-11-09/10.
// Assertions marked KNOWN-DEFECT pin TODAY's behaviour so the harness can show the
// before/after of a fix: when the master-plan PR named beside one lands, that test
// is expected to fail and must be flipped in the same PR — on purpose, with review.
import { assert, assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert@^1";
import { clusterArtifacts, isClusterInert } from "../../../functions/osint-agent/lib/cluster.ts";
import { ruleV1, ruleV2, scoreDecisions, selectorOf } from "./attribution-rules.ts";
import { buildScorecard, scorecardHash } from "./scorecard.ts";
import { parseSnapshot, type Snapshot, toClusterArtifact } from "./snapshot.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

async function load(name: string): Promise<Snapshot> {
  return parseSnapshot(JSON.parse(await Deno.readTextFile(new URL(name, FIXTURES))));
}

const clusterOf = (s: Snapshot, id: string): string | null =>
  clusterArtifacts(s.artifacts.map(toClusterArtifact)).members.find((m) => m.id === id)!.cluster_id;

/** Run `fn` with env switches set, restoring them after (switches are read at call time). */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

// ── (a) a breach username and a same-handle stranger's profile ───────────────────

Deno.test("same-handle stranger: clustering keeps the contradicted profile apart (regression guard)", async () => {
  const s = await load("same-handle-stranger.json");
  assertNotEquals(clusterOf(s, "a3"), clusterOf(s, "a2"));
});

Deno.test("same-handle stranger: the v1 node rule auto-corroborates the stranger's handle, read either way", async () => {
  const s = await load("same-handle-stranger.json");
  for (const mode of ["literal", "counted"] as const) {
    const score = scoreDecisions(s, ruleV1(s, mode));
    assertEquals(score.rows, 2, `${mode}: breach username + contradicted profile`);
    assertEquals(score.on_vetoed_selectors, 2, `${mode}: every decision is on a selector the case contradicted`);
    assertEquals(score.key_only, 1, `${mode}: Key is importance, never a keep`);
    assertEquals(score.keep, 0);
  }
});

Deno.test("same-handle stranger, passive lookup (the 2026-11-09 shape): only the literal reading fires", async () => {
  const s = await load("same-handle-stranger.json");
  for (const a of s.artifacts) {
    if (a.id === "a3" || a.id === "a4") a.metadata = { ...a.metadata, source_category: ["social_profile_passive"] };
  }
  assertEquals(ruleV1(s, "literal").length, 2, "distinct classes: breach + social_profile_passive");
  assertEquals(ruleV1(s, "counted").length, 0, "countIndependentClasses drops social_profile_passive");
});

Deno.test("same-handle stranger written as prose: the engine reading still finds the handle, the strict one does not", async () => {
  const s = await load("same-handle-stranger.json");
  const a3 = s.artifacts.find((a) => a.id === "a3")!;
  a3.value = "LIVE profile @blue-heron-0142 on social.example.com — display name belongs to someone else";
  assertEquals(selectorOf(a3), null);
  assertEquals(ruleV1(s, "literal", "strict").length, 0, "the strict reading has nothing to compare");
  const engine = ruleV1(s, "literal", "engine");
  assert(engine.some((d) => d.artifact_id === "a3"), "the engine reading pulls the handle out of the prose");
  assert(engine.every((d) => d.selector === "handle:blueheron0142"));
});

Deno.test("same-handle stranger: the v2 edge rule vetoes it", async () => {
  const s = await load("same-handle-stranger.json");
  const r = ruleV2(s);
  assertEquals(r.decisions.length, 0);
  assertEquals(r.candidates, 1);
  assertEquals(r.vetoed, 1);
});

// ── (e) a real edge: the subject's own profile names the seed, and a breach row agrees ─

Deno.test("edge corroborated: v2 decides when two tool-derived classes name X with the anchor, one first-party", async () => {
  const s = await load("edge-corroborated.json");
  const r = ruleV2(s);
  assertEquals(r.decisions.map((d) => d.artifact_id).sort(), ["e2", "e3"]);
  assertEquals(r.decisions[0].selector, "handle:copperkite55");
});

Deno.test("edge corroborated: a row the model typed does not count toward v2 (blocked by origin)", async () => {
  const s = await load("edge-corroborated.json");
  const e2 = s.artifacts.find((a) => a.id === "e2")!;
  e2.metadata = { ...e2.metadata, auto_recorded: false };
  const r = ruleV2(s);
  assertEquals(r.decisions.length, 0);
  assertEquals(r.blocked_by_origin, 1);
});

Deno.test("edge corroborated: breach-only co-occurrence never qualifies for v2", async () => {
  const s = await load("edge-corroborated.json");
  s.artifacts = s.artifacts.filter((a) => a.id !== "e2");
  const r = ruleV2(s);
  assertEquals(r.decisions.length, 0);
  assertEquals(r.insufficient_corroboration, 1);
});

Deno.test("edge corroborated: an analyst Dismiss on X vetoes v2", async () => {
  const s = await load("edge-corroborated.json");
  s.reviews.push({ artifact_id: "e3", state: "dismissed", created_at: "2026-01-05T01:00:00Z" });
  const r = ruleV2(s);
  assertEquals(r.decisions.length, 0);
  assertEquals(r.vetoed, 1);
});

// ── (b) a written row bridges two people ─────────────────────────────────────────

Deno.test("written-row bridge: FIXED by 1d-i — a correlation note naming two handles no longer merges them", async () => {
  const s = await load("written-row-bridge.json");
  assertNotEquals(clusterOf(s, "b1"), clusterOf(s, "b2"));
  const c = buildScorecard(s).summary.clustering;
  assertEquals(c.clusters_bridged_only_by_written_rows, 0);
  assertEquals(c.prose_bridges_withheld, 1);
  assertEquals(clusterOf(s, "b3") === clusterOf(s, "b1") || clusterOf(s, "b3") === clusterOf(s, "b2"), false, "the note joins neither");
});

Deno.test("written-row bridge: CLUSTER_PROSE_NO_BRIDGE_DISABLED restores the old merge", async () => {
  const s = await load("written-row-bridge.json");
  await withEnv({ CLUSTER_PROSE_NO_BRIDGE_DISABLED: "true" }, () => {
    assertEquals(clusterOf(s, "b1"), clusterOf(s, "b2"));
    assertEquals(buildScorecard(s).summary.clustering.clusters_bridged_only_by_written_rows, 1);
  });
});

Deno.test("analyst rejection: clustering replays production's dropRejectedArtifacts — a Wrong on the bridging note removes the bridge", async () => {
  const s = await load("written-row-bridge.json");
  s.reviews.push({ artifact_id: "b3", state: "wrong", created_at: "2026-01-02T01:00:00Z" });
  const card = buildScorecard(s);
  assertEquals(card.summary.rows.removed_by_analyst_rejection, 1);
  assertEquals(card.summary.clustering.clusters_bridged_only_by_written_rows, 0);
  assertEquals(card.summary.clustering.clusters_with_2_plus, 0, "the two handles stay separate");
});

Deno.test("analyst rejection: a re-record of a rejected value under a new id is removed too", async () => {
  const s = await load("written-row-bridge.json");
  s.artifacts.push({ ...s.artifacts.find((a) => a.id === "b3")!, id: "b3-again", created_at: "2026-01-02T00:00:04Z" });
  s.reviews.push({ artifact_id: "b3", state: "dismissed", created_at: "2026-01-02T01:00:00Z" });
  assertEquals(buildScorecard(s).summary.rows.removed_by_analyst_rejection, 2);
});

Deno.test("blind backtest: a rule that labels a row the analyst rejected is scored as a reject", async () => {
  const s = await load("same-handle-stranger.json");
  s.reviews.push({ artifact_id: "a3", state: "wrong", created_at: "2026-01-01T00:20:00Z" });
  const v1 = buildScorecard(s).summary.attribution.v1_literal_strict;
  assertEquals(v1.rows, 2, "the blind rule still labels both rows");
  assertEquals(v1.reject, 1);
  assertEquals(v1.wrong, 1);
  assertEquals(v1.precision, 0);
  assertEquals(ruleV1(s, "literal").length, 0, "live mode drops the rejected row, and breach alone is one class");
});

// ── (c) a nameserver provider outside the curated list ───────────────────────────

Deno.test("nameserver provider: FIXED by 1d-iii — ns rows of an uncurated provider are inert, and the note naming it joins nothing", async () => {
  const s = await load("nameserver-provider.json");
  const c = buildScorecard(s).summary.clustering;
  assertEquals(c.infra_host_joins, 0);
  assertEquals(clusterOf(s, "c2"), null, "plumbing is not a cluster member");
  assertEquals(clusterOf(s, "c3"), null);
  assertNotEquals(clusterOf(s, "c4"), clusterOf(s, "c1"), "the note does not join the subject's domain");
  assert(clusterOf(s, "c1") !== null, "the subject's own domain still clusters");
});

Deno.test("nameserver provider: the subject's OWN zone keeps its ns rows (1d-iii is case-aware)", async () => {
  const s = await load("nameserver-provider.json");
  s.artifacts.push({ ...s.artifacts.find((a) => a.id === "c2")!, id: "c5", value: "ns1.subject-shop.example", created_at: "2026-01-03T00:00:09Z" });
  assertEquals(clusterOf(s, "c5"), clusterOf(s, "c1"), "ns1.<subject zone> beside <subject zone> stays a member");
});

Deno.test("nameserver provider: CLUSTER_INFRA_LABEL_SHAPE_DISABLED restores the old joins", async () => {
  const s = await load("nameserver-provider.json");
  await withEnv({ CLUSTER_INFRA_LABEL_SHAPE_DISABLED: "true", CLUSTER_PROSE_NO_BRIDGE_DISABLED: "true" }, () => {
    assertEquals(buildScorecard(s).summary.clustering.infra_host_joins, 1);
    assertEquals(clusterOf(s, "c2"), clusterOf(s, "c4"));
  });
});

// ── (d) an analyst-released quarantine row ───────────────────────────────────────

Deno.test("released row: FIXED by 1d-ii — an analyst-released row is a cluster member again", async () => {
  const s = await load("released-row.json");
  const d2 = s.artifacts.find((a) => a.id === "d2")!;
  assert(!isClusterInert(toClusterArtifact(d2)));
  assertEquals(clusterOf(s, "d2"), clusterOf(s, "d1"));
  assertEquals(buildScorecard(s).summary.clustering.released_rows_still_inert, 0);
});

Deno.test("released row: a quarantined row that was NOT released stays inert; an excluded one stays inert even if 'released'", async () => {
  const s = await load("released-row.json");
  const d2 = s.artifacts.find((a) => a.id === "d2")!;
  const unreleased = { ...d2, metadata: { ...d2.metadata, linkage_confirmed: false } };
  assert(isClusterInert(toClusterArtifact(unreleased)));
  const excluded = { ...d2, metadata: { ...d2.metadata, status: "excluded" } };
  assert(isClusterInert(toClusterArtifact(excluded)));
});

Deno.test("released row: CLUSTER_RELEASED_ROWS_JOIN_DISABLED restores the old inertness", async () => {
  const s = await load("released-row.json");
  await withEnv({ CLUSTER_RELEASED_ROWS_JOIN_DISABLED: "true" }, () => {
    assertEquals(clusterOf(s, "d2"), null);
    assertEquals(buildScorecard(s).summary.clustering.released_rows_still_inert, 1);
  });
});

// ── (e) prose about one subject, and prose naming two (production log 2026-11-08) ──

Deno.test("prose about one subject: attached without bridging; a note is ABOUT it, an `other` row stays evidence (1d-i)", async () => {
  const s = await load("prose-about-and-bridge.json");
  const r = clusterArtifacts(s.artifacts.map(toClusterArtifact));
  const subj = r.subjects.find((x) => x.members.some((m) => m.id === "e1"))!;
  // `other` is the catch-all kind (pasted records, model-typed tool output): attached as
  // evidence, as today — the change for it is only that it can no longer bridge.
  assertEquals(subj.members.map((m) => m.id).sort(), ["e1", "e2", "e3", "e4"]);
  assertEquals((subj.about ?? []).map((m) => m.id), ["e7"], "a model note is shown with the subject, not counted as evidence");
  assert(!subj.sources.includes("record_artifacts"), "the note adds no source");
  for (const id of ["e3", "e4", "e7"]) assertEquals(clusterOf(s, id), clusterOf(s, "e1"), "shown with the subject");
  assertEquals(buildScorecard(s).summary.clustering.written_rows_attached_as_about, 1);
});

Deno.test("prose naming two subjects: withheld, and the two handles stay apart (1d-i)", async () => {
  const s = await load("prose-about-and-bridge.json");
  assertNotEquals(clusterOf(s, "e1"), clusterOf(s, "e5"));
  const r = clusterArtifacts(s.artifacts.map(toClusterArtifact));
  assertEquals(r.prose_bridges_withheld, 1);
  const e6 = r.members.find((m) => m.id === "e6")!;
  assert(e6.cluster_id !== clusterOf(s, "e1") && e6.cluster_id !== clusterOf(s, "e5"));
});

Deno.test("prose: today's behaviour (switch off) — the finding bridges two handles into one subject of seven", async () => {
  const s = await load("prose-about-and-bridge.json");
  await withEnv({ CLUSTER_PROSE_NO_BRIDGE_DISABLED: "true" }, () => {
    assertEquals(clusterOf(s, "e1"), clusterOf(s, "e5"), "the finding bridged two handles");
    const card = buildScorecard(s).summary.clustering;
    assertEquals(card.clusters_with_2_plus, 1);
    assertEquals(card.singletons, 0);
    assertEquals(card.clusters_bridged_only_by_written_rows, 1);
  });
});

Deno.test("prose: subject ids of prose-free clusters do not move when prose is attached", async () => {
  const s = await load("prose-about-and-bridge.json");
  const withProse = clusterOf(s, "e1");
  const bare = { ...s, artifacts: s.artifacts.filter((a) => ["e1", "e2", "e5"].includes(a.id)) };
  assertEquals(clusterOf(bare, "e1"), withProse);
});

// ── harness contract ─────────────────────────────────────────────────────────────

Deno.test("determinism: shuffled input rows give the identical scorecard hash", async () => {
  for (const name of ["same-handle-stranger.json", "written-row-bridge.json", "nameserver-provider.json", "released-row.json", "edge-corroborated.json", "prose-about-and-bridge.json"]) {
    const raw = JSON.parse(await Deno.readTextFile(new URL(name, FIXTURES)));
    const h1 = await scorecardHash(buildScorecard(parseSnapshot(raw)));
    const shuffled = { ...raw, artifacts: [...raw.artifacts].reverse(), reviews: [...raw.reviews].reverse() };
    const h2 = await scorecardHash(buildScorecard(parseSnapshot(shuffled)));
    assertEquals(h1, h2, name);
  }
});

Deno.test("selectorOf: a row that only mentions a selector has none", () => {
  const base = { id: "x", source: "s", confidence: 50, metadata: {} };
  assertEquals(selectorOf({ ...base, kind: "email", value: "Subject@Example.com" }), "email:subject@example.com");
  assertEquals(selectorOf({ ...base, kind: "social_profile", value: "https://social.example.com/@Blue-Heron" }), "handle:blueheron");
  assertEquals(selectorOf({ ...base, kind: "phone", value: "+1 (555) 010-0142" }), "phone:+15550100142");
  assertEquals(selectorOf({ ...base, kind: "finding", value: "subject@example.com appears in two breaches" }), null);
  assertEquals(selectorOf({ ...base, kind: "username", value: "two words" }), null);
});

Deno.test("parseSnapshot: rejects shapes it cannot trust, unwraps the SQL export", () => {
  assertThrows(() => parseSnapshot({ version: 2, artifacts: [] }));
  assertThrows(() => parseSnapshot({ version: 1, artifacts: [{ kind: "email" }] }));
  assertThrows(() => parseSnapshot({ version: 1, artifacts: [{ id: "1" }, { id: "1" }] }));
  assertEquals(parseSnapshot({ snapshot: { version: 1, artifacts: [], reviews: null, tool_usage: null } }).artifacts.length, 0);
});

Deno.test("fixtures stay synthetic: reserved domains only, no free-mail, no non-555 phones", async () => {
  const freeMail = /@(gmail|yahoo|hotmail|outlook|icloud|aol|proton(mail)?|gmx|yandex|mail)\.[a-z]+/i;
  const realPhone = /\+?1?[\s.-]?\(?(?!555)\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
  for await (const e of Deno.readDir(FIXTURES)) {
    if (!e.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(new URL(e.name, FIXTURES));
    assert(!freeMail.test(text), `${e.name}: free-mail address`);
    assert(!realPhone.test(text), `${e.name}: phone outside 555`);
    for (const m of text.matchAll(/@([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      assert(/(^|\.)example\.(com|net|org)$/i.test(m[1]) || /\.example$/i.test(m[1]), `${e.name}: non-reserved domain ${m[1]}`);
    }
  }
});
