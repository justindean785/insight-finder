// cluster_adjudication_test.ts — the PURE half of the Claude cluster adjudicator:
// which clusters are put to the model, what the model is shown, what the hash
// keys on, and which answers are accepted.
//
// The I/O half (idempotence against the table, spend caps, never touching
// artifacts) is pinned in cluster_adjudication_sweep_test.ts.

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADJUDICATION_PROMPT_VERSION,
  MAX_EVIDENCE_MEMBERS,
  adjudicationInputHash,
  buildAdjudicationPrompt,
  parseAdjudication,
  selectAdjudicationCandidates,
} from "../../functions/osint-agent/lib/cluster-adjudication.ts";
import { clusterArtifacts } from "../../functions/osint-agent/lib/cluster.ts";

const EMAIL = "jordan.vale@example.test";

function row(id: string, kind: string, value: string, source: string, metadata: Record<string, unknown> = {}) {
  return { id, kind, value, source, confidence: 50, metadata };
}

/** The collision detector's marker plus two records carrying the contradicted email. */
function contradictedCase() {
  return [
    row("c1", "contradiction", `${EMAIL} is attached to two different names`, "collision_detector", { collision_value: EMAIL }),
    row("e1", "email", EMAIL, "breach_lookup", { name: "Jordan Vale", city: "Oakland" }),
    row("e2", "email", EMAIL, "people_search", { name: "Jordan Vale-Smith", city: "Leeds" }),
  ];
}

/** An ordinary joined cluster: no contradiction signal anywhere. */
function cleanCase() {
  return [
    row("u1", "username", "selftesthandle", "username_sweep"),
    row("u2", "social_profile", "https://example.test/selftesthandle", "username_sweep"),
  ];
}

// ---- cluster.ts additive report ------------------------------------------------

Deno.test("clusterArtifacts reports which subjects are contradicted", () => {
  const arts = [...contradictedCase(), ...cleanCase()].map((r) => ({
    id: r.id, kind: r.kind, value: r.value, source: r.source, confidence: r.confidence,
    metaRaw: JSON.stringify(r.metadata),
  }));
  const { subjects } = clusterArtifacts(arts);
  const contra = subjects.filter((s) => s.contradicted);
  assertEquals(contra.length, 1);
  assertEquals(contra[0].members.map((m) => m.id).sort(), ["c1", "e1", "e2"]);
  assert(subjects.some((s) => !s.contradicted && s.members.length === 2), "the clean cluster is not contradicted");
});

// ---- candidate selection --------------------------------------------------------

Deno.test("only contradicted clusters are candidates", () => {
  const sel = selectAdjudicationCandidates([...contradictedCase(), ...cleanCase()]);
  assertEquals(sel.candidates.length, 1);
  assert(sel.candidates[0].clusterId.startsWith("clus_"));
});

Deno.test("the contradiction marker is CONTEXT, never evidence", () => {
  // It is a cluster member (cluster.ts groups it with the rows it flags), but
  // listing it as evidence would let the detector's own statement count as a
  // record about the subject.
  const [c] = selectAdjudicationCandidates(contradictedCase()).candidates;
  assertEquals(c.context.map((m) => m.id), ["c1"]);
  assertEquals(c.evidence.map((m) => m.id), ["e1", "e2"]);
});

Deno.test("a cluster with fewer than two evidence records is not a question", () => {
  const rows = contradictedCase().slice(0, 2); // marker + one record
  const sel = selectAdjudicationCandidates(rows);
  assertEquals(sel.candidates.length, 0);
  assertEquals(sel.undersize, 1);
});

Deno.test("an oversize cluster is skipped, not truncated", () => {
  // Deciding on the first N of a larger set would silently change the answer —
  // the same reason finding synthesis declines a truncated thread.
  const rows = [contradictedCase()[0]];
  for (let i = 0; i <= MAX_EVIDENCE_MEMBERS; i++) rows.push(row(`e${i}`, "email", EMAIL, `src_${i}`));
  const sel = selectAdjudicationCandidates(rows);
  assertEquals(sel.candidates.length, 0);
  assertEquals(sel.oversize, 1);
});

Deno.test("rows without a string id are ignored rather than adjudicated anonymously", () => {
  const rows: Array<Record<string, unknown>> = contradictedCase();
  rows.push({ kind: "email", value: EMAIL, source: "no_id", confidence: 50, metadata: {} });
  const [c] = selectAdjudicationCandidates(rows).candidates;
  assertEquals(c.evidence.length, 2);
});

// ---- input hash ----------------------------------------------------------------

Deno.test("the input hash is stable across row order", async () => {
  const a = selectAdjudicationCandidates(contradictedCase()).candidates[0];
  const b = selectAdjudicationCandidates([...contradictedCase()].reverse()).candidates[0];
  assertEquals(await adjudicationInputHash(a), await adjudicationInputHash(b));
});

Deno.test("the input hash moves when a member's value changes", async () => {
  const a = selectAdjudicationCandidates(contradictedCase()).candidates[0];
  const rows = contradictedCase();
  rows.push(row("e3", "email", EMAIL, "third_source"));
  const b = selectAdjudicationCandidates(rows).candidates[0];
  assertNotEquals(await adjudicationInputHash(a), await adjudicationInputHash(b));
});

Deno.test("the input hash ignores metadata and the model, keys on the prompt version", async () => {
  // A model swap via env must not re-bill every cluster; a prompt change must.
  const a = selectAdjudicationCandidates(contradictedCase()).candidates[0];
  const rows = contradictedCase();
  (rows[1].metadata as Record<string, unknown>).city = "Elsewhere";
  const b = selectAdjudicationCandidates(rows).candidates[0];
  assertEquals(await adjudicationInputHash(a), await adjudicationInputHash(b));
  assertNotEquals(await adjudicationInputHash(a), await adjudicationInputHash(a, "other-prompt-version"));
  assert(ADJUDICATION_PROMPT_VERSION.length > 0);
});

// ---- prompt --------------------------------------------------------------------

Deno.test("the prompt carries the distinguishing metadata and frames records as untrusted", () => {
  const [c] = selectAdjudicationCandidates(contradictedCase()).candidates;
  const { system, user } = buildAdjudicationPrompt(c);
  assert(user.includes("Oakland") && user.includes("Leeds"), "metadata is where the answer lives");
  assert(/untrusted/i.test(system), "web-collected text must be framed as data");
  assert(/advisory/i.test(system));
  assert(system.includes("same_subject") && system.includes("different_subjects") && system.includes("insufficient"));
});

Deno.test("secret-looking metadata keys never leave the function", () => {
  const rows = contradictedCase();
  Object.assign(rows[1].metadata as Record<string, unknown>, {
    password: "hunter2", password_hash: "5f4dcc3b", api_key: "sk-test", session_token: "tok",
  });
  const [c] = selectAdjudicationCandidates(rows).candidates;
  const { user } = buildAdjudicationPrompt(c);
  for (const s of ["hunter2", "5f4dcc3b", "sk-test", "\"tok\""]) assert(!user.includes(s), `leaked ${s}`);
  assert(user.includes("Jordan Vale"), "ordinary fields survive");
});

// ---- parser --------------------------------------------------------------------

const GOOD = { verdict: "different_subjects", probability: 18, rationale: "Different cities and surnames." };

Deno.test("a clean JSON object is accepted", () => {
  const p = parseAdjudication(JSON.stringify(GOOD));
  assert(p.ok);
  if (p.ok) {
    assertEquals(p.verdict, "different_subjects");
    assertEquals(p.probability, 18);
    assertEquals(p.rationale, "Different cities and surnames.");
  }
});

Deno.test("a fenced JSON object is accepted", () => {
  assert(parseAdjudication("```json\n" + JSON.stringify(GOOD) + "\n```").ok);
});

Deno.test("⛔ anything but a clean object is refused", () => {
  const bad: Array<[string, string]> = [
    ["prose", "They are probably the same person."],
    ["prose around json", `Here you go: ${JSON.stringify(GOOD)}`],
    ["array", JSON.stringify([GOOD])],
    ["unknown verdict", JSON.stringify({ ...GOOD, verdict: "likely_same" })],
    ["float probability", JSON.stringify({ ...GOOD, probability: 18.5 })],
    ["string probability", JSON.stringify({ ...GOOD, probability: "18" })],
    ["probability > 100", JSON.stringify({ ...GOOD, probability: 101 })],
    ["negative probability", JSON.stringify({ ...GOOD, probability: -1 })],
    ["blank rationale", JSON.stringify({ ...GOOD, rationale: "   " })],
    ["missing rationale", JSON.stringify({ verdict: GOOD.verdict, probability: GOOD.probability })],
    ["extra key", JSON.stringify({ ...GOOD, confidence: 90 })],
    ["empty", ""],
  ];
  for (const [label, text] of bad) assertEquals(parseAdjudication(text).ok, false, label);
});

Deno.test("an over-long rationale is capped, not refused", () => {
  const p = parseAdjudication(JSON.stringify({ ...GOOD, rationale: "x".repeat(5000) }));
  assert(p.ok);
  if (p.ok) assert(p.rationale.length <= 1000);
});
