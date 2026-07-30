// recovery_output_integrity_test.ts — what the recovered stub is allowed to say.
//
// INCIDENT (2026-07-30, thread 6b3b0745): a run was reaped mid-work and published
// "## Findings report — recovered run" listing 27 rows — 20 breach hits at
// confidence 55, a Houston phone and a Puerto Rico phone — for a subject located
// in Maracaibo, Venezuela. During that run the agent had explicitly written that
// the OathNet name search was "a CLASSIC same-name collision situation... Many of
// these are clearly different people", and that the seed email did not appear in
// the email search at all.
//
// None of that reached the report, for three compounding reasons:
//   1. recovery.ts SELECTed id,kind,value,confidence,source,created_at and never
//      `metadata` — so status, reason_not_confirmed, source_category and the
//      collision flags physically could not be rendered.
//   2. The model called record_artifacts ZERO times, so all 27 rows were written
//      by the auto-persist extractor before any model judgement — yet they were
//      presented as "Recovered findings".
//   3. Collision gating (excluded_collision @ confidence 15) lives only inside
//      record_artifacts/record_artifact, so it was structurally unreachable from
//      the auto-persist path that produced every published row.
//
// This file pins the OUTPUT contract. It does not attempt to fix (3) — see the
// PR body; bulk-extractor collision inference is persistence-hygiene work.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRecoveredAssistantText,
  classifyRecoveryRow,
  type RecoveryArtifact,
} from "./recovery.ts";
import { hasReportShape } from "./orchestrator-finalize.ts";

const THREAD = {
  seed_value: "alexurdaneta60@gmail.com",
  title: null,
  last_heartbeat_at: "2026-07-30T07:15:47.750Z",
  run_started_at: "2026-07-30T07:14:02.750Z",
};

/** Shapes taken verbatim from production artifact rows. */
const autoPersisted = (over: Partial<RecoveryArtifact> = {}): RecoveryArtifact => ({
  kind: "breach",
  value: "MGM Resorts",
  confidence: 55,
  source: "oathnet_lookup",
  created_at: "2026-07-30T07:14:29.673Z",
  metadata: {
    via: "oathnet_db",
    status: "observed",
    auto_recorded: true,
    auto_persist_source: "tool_return_extractor",
    reason_not_confirmed: "needs second independent class of evidence",
    source_category: ["breach"],
  },
  ...over,
});

const modelRecorded = (over: Partial<RecoveryArtifact> = {}): RecoveryArtifact => ({
  kind: "organization",
  value: "Insomnia Security / Insomnia Scanner",
  confidence: 70,
  source: "http_fingerprint, jina_reader_scrape, exa_search",
  created_at: "2026-07-30T14:59:37.640Z",
  metadata: {
    status: "needs_corroboration",
    source_category: ["infra_scan", "independent_public"],
    reason_not_confirmed: "evidence does not yet meet official+independent threshold",
  },
  ...over,
});

Deno.test("excluded_collision rows never render", () => {
  const rows: RecoveryArtifact[] = [
    modelRecorded(),
    { kind: "excluded_collision", value: "Alex Urdaneta (France, DOB 1999)", confidence: 15, source: "oathnet_lookup", metadata: { status: "excluded" } },
    { kind: "name", value: "Wayne Young", confidence: 40, source: "oathnet_lookup", metadata: { status: "excluded_collision" } },
    { kind: "excluded_collision_summary", value: "12 excluded same-name matches", confidence: 15, source: "collision-policy", metadata: { status: "excluded" } },
  ];
  const out = buildRecoveredAssistantText(THREAD, rows);
  assert(!out.includes("France, DOB 1999"), "an excluded collision row was rendered");
  assert(!out.includes("Wayne Young"), "a row with status=excluded_collision was rendered");
  assert(!out.includes("12 excluded same-name matches"), "a collision summary row was rendered");
  assert(/3 rows were ruled out/.test(out), "the exclusion count must still be disclosed, not hidden");
});

Deno.test("triage_decision never renders as evidence", () => {
  // In the incident this was published as finding #27 with confidence "—",
  // purely because the dump had no kind whitelist.
  const rows: RecoveryArtifact[] = [
    { kind: "triage_decision", value: "triage_decision: Stage 2 OPEN for alexurdaneta60@gmail.com", confidence: null, source: "triage_seed", metadata: {} },
    modelRecorded(),
  ];
  const out = buildRecoveredAssistantText(THREAD, rows);
  assert(!out.includes("Stage 2 OPEN"), "a triage_decision control row was rendered as evidence");
  assert(/control\/telemetry record/.test(out), "omission of control records must be disclosed");
});

Deno.test("auto-persisted rows are labelled UNREVIEWED and never called findings", () => {
  const out = buildRecoveredAssistantText(THREAD, [autoPersisted(), autoPersisted({ value: "Deezer" })]);
  assert(/Machine-extracted candidates — UNREVIEWED/.test(out), "candidates section missing");
  assert(
    /No model or analyst judgement was applied/.test(out),
    "the unreviewed caveat must be explicit, not implied by a section title",
  );
  assert(
    !/### Model-reviewed findings/.test(out),
    "a run with only extractor output must not present a model-reviewed findings section",
  );
  assert(
    /No model-reviewed findings exist for this run/.test(out),
    "zero reviewed rows must be stated plainly — this is the incident's core failure",
  );
  // The heading must not assert a findings report, which is what the old stub did.
  assert(!/^## Findings report/m.test(out), "stub still claims to be a findings report");
});

Deno.test("reviewed findings keep provenance and their not-confirmed caveat", () => {
  const out = buildRecoveredAssistantText(THREAD, [modelRecorded()]);
  assert(/### Model-reviewed findings/.test(out));
  assert(/http_fingerprint, jina_reader_scrape, exa_search/.test(out), "source provenance was dropped");
  assert(/needs_corroboration/.test(out), "metadata.status was not rendered");
  assert(
    /evidence does not yet meet official\+independent threshold/.test(out),
    "reason_not_confirmed was not surfaced — a 70 with no caveat reads as a finding",
  );
});

Deno.test("reviewed evidence outranks higher-confidence bulk rows", () => {
  // The extractor pushes breach rows at a hardcoded 55; a model-reviewed row at
  // 45 is worth more. Confidence-descending ordering alone put the bulk rows on
  // top of the incident report.
  const reviewed = modelRecorded({ value: "REVIEWED-ROW", confidence: 45 });
  const bulk = autoPersisted({ value: "BULK-ROW", confidence: 55 });
  const out = buildRecoveredAssistantText(THREAD, [bulk, reviewed]);
  assert(
    out.indexOf("REVIEWED-ROW") < out.indexOf("BULK-ROW"),
    "a bulk extractor row sorted above model-reviewed evidence on numeric confidence",
  );
});

Deno.test("an empty eligible set says so honestly — and stays report-shaped", () => {
  const out = buildRecoveredAssistantText(THREAD, []);
  assert(/No evidence was durably recorded/.test(out));
  assert(!/### Model-reviewed findings/.test(out));
  // Load-bearing: if the stub is not report-shaped, shouldInsertRecoveredAssistant
  // will not see `report_present` on a re-sweep and will stack a second stub.
  assert(
    hasReportShape(out),
    "empty recovery stub lost report shape — a re-sweep would insert a duplicate stub",
  );
});

Deno.test("legacy rows with missing metadata are treated conservatively", () => {
  // Rows written before metadata existed cannot be SHOWN to have been reviewed,
  // so they must not be promoted into the findings section by default.
  assertEquals(classifyRecoveryRow({ kind: "email", value: "a@b.c", confidence: 45 }), "candidate");
  assertEquals(classifyRecoveryRow({ kind: "email", value: "a@b.c", confidence: 45, metadata: null }), "candidate");
  const out = buildRecoveredAssistantText(THREAD, [{ kind: "email", value: "legacy@example.com", confidence: 45, source: "oathnet_lookup" }]);
  assert(/Machine-extracted candidates — UNREVIEWED/.test(out), "legacy row was not treated conservatively");
  assert(!/### Model-reviewed findings/.test(out));
});

Deno.test("a populated stub stays report-shaped (duplicate-insert suppression)", () => {
  for (const rows of [[modelRecorded()], [autoPersisted()], [modelRecorded(), autoPersisted()]]) {
    assert(hasReportShape(buildRecoveredAssistantText(THREAD, rows)), "stub lost report shape");
  }
});
