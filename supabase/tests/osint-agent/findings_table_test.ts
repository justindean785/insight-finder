/**
 * findings_table_test.ts — engine-authored closing Findings table.
 *
 * The orchestrator writes the literal line `{{FINDINGS_TABLE}}`; the server replaces it
 * from the run's persisted rows. Every fixture here is SYNTHETIC (invented values,
 * reserved .test / example names) — nothing from a real run belongs in this file.
 *
 * The properties worth pinning are not formatting:
 *  - the table carries PERSISTED values only (capped confidence, never metadata.label);
 *  - quarantined / excluded / bookkeeping rows never gain a figure;
 *  - unreadable verdicts fail CLOSED (no rows listed);
 *  - a stub that only contains the marker is NOT turned into a report-shaped message;
 *  - the expansion can never throw out of finalize and never leaves the marker visible
 *    when it did run.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FINDINGS_TABLE_MARKER,
  FINDINGS_TABLE_MAX_ROWS,
  expandFindingsTable,
  expandFindingsTableInParts,
  renderFindingsTable,
  runFindingsTableSelfTest,
} from "../../functions/osint-agent/lib/findings-table.ts";
import { hasReportShape, stripReasoning } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { EXCLUDED_KINDS, EXCLUDED_STATUSES, NON_EVIDENCE_KINDS } from "../../functions/osint-agent/recovery.ts";

type Row = Record<string, unknown>;

const finding = (id: string, value: string, confidence: number, meta: Row = {}): Row => ({
  id, kind: "finding", value, confidence, source: "record_finding",
  metadata: { source_category: ["breach_corpus", "live_profile"], ...meta },
});
const artifact = (id: string, value: string, confidence: number, source = "username_sweep", meta: Row = {}): Row => ({
  id, kind: "username", value, confidence, source, metadata: meta,
});

const input = (rows: Row[], over: Record<string, unknown> = {}) => ({
  rows,
  totalArtifactCount: rows.length,
  retrieval: "complete" as const,
  reviews: "applied" as const,
  rejectedFindingCount: 0,
  ...over,
});

const shapeOk = (t: string) => hasReportShape(stripReasoning(t));

Deno.test("marker constant is the exact literal the prompt tells the model to write", () => {
  assertEquals(FINDINGS_TABLE_MARKER, "{{FINDINGS_TABLE}}");
});

Deno.test("renders one GFM table: findings first, then confidence desc, id tiebreak, deterministic in any order", () => {
  const rows = [
    artifact("a2", "sample_user_b", 70),
    finding("f1", "sample_user_a and alias@example.test share an operator", 62),
    artifact("a1", "sample_user_a", 70),
    artifact("a3", "sample_user_c", 40),
  ];
  const a = renderFindingsTable(input(rows));
  const b = renderFindingsTable(input([...rows].reverse()));
  assertEquals(a, b, "ordering must not depend on fetch order");
  const lines = a.split("\n").filter((l) => l.startsWith("|"));
  // header, separator, then 4 data rows
  assertEquals(lines.length, 6);
  assertStringIncludes(lines[2], "share an operator", "adjudicated finding sorts first even at lower confidence");
  assertStringIncludes(lines[3], "sample_user_a");
  assertStringIncludes(lines[4], "sample_user_b");
  assertStringIncludes(lines[5], "sample_user_c");
});

Deno.test("basis column separates a record_finding row from an evidence-record row", () => {
  const out = renderFindingsTable(input([finding("f1", "claim one", 80), artifact("a1", "handle_one", 50)]));
  const [findingLine, artifactLine] = out.split("\n").filter((l) => l.startsWith("| 1 ") || l.startsWith("| 2 "));
  assertStringIncludes(findingLine, "finding");
  assertStringIncludes(artifactLine, "evidence row");
  assert(!artifactLine.includes("| finding"), "an artifact must not read as an adjudicated finding");
});

Deno.test("synthesis-origin findings are marked, not passed off as model/engine findings", () => {
  const out = renderFindingsTable(input([finding("f1", "synthesised claim", 60, { finding_origin: "synthesis" })]));
  assertStringIncludes(out, "finding (synthesis)");
});

Deno.test("confidence is the PERSISTED CAPPED number; metadata.label / status are never read", () => {
  const row = finding("f1", "capped claim", 95, {
    confidence_cap_applied: 60, label: "CONFIRMED", status: "confirmed",
  });
  const out = renderFindingsTable(input([row]));
  assertStringIncludes(out, "60%");
  assert(!out.includes("95%"), "the uncapped column value must not be published");
  assert(!/confirmed/i.test(out.split("\n").filter((l) => l.startsWith("| 1 "))[0]),
    "a model-authored label must not become the printed label");
  assertStringIncludes(out, "Possible", "label is the ladder tier of the stored capped number");
});

Deno.test("source classes: shows the persisted distinct count where present, an em dash where the engine stored nothing", () => {
  const out = renderFindingsTable(input([
    finding("f1", "has classes", 70, { source_category: ["a", "b", "b"] }),
    artifact("a1", "no classes", 40),
  ]));
  const rows = out.split("\n").filter((l) => /^\| [12] /.test(l));
  assertStringIncludes(rows[0], "| 2 |", "distinct classes counted, not array length");
  assertStringIncludes(rows[1], "| — |");
});

Deno.test("an unusable stored score prints an em dash and Unverified — never an estimate", () => {
  const out = renderFindingsTable(input([artifact("a1", "bad score", 101), artifact("a2", "null score", NaN)]));
  const rows = out.split("\n").filter((l) => /^\| [12] /.test(l));
  for (const r of rows) {
    assertStringIncludes(r, "—");
    assertStringIncludes(r, "Unverified");
  }
});

Deno.test("quarantined rows are withheld and counted, never listed with a figure; released rows are listed", () => {
  const out = renderFindingsTable(input([
    artifact("a1", "visible_one", 55),
    artifact("a2", "name_only_stranger", 65, "username_sweep", { subject_unlinked: true }),
    artifact("a3", "released_one", 50, "username_sweep", { subject_unlinked: true, linkage_confirmed: true }),
    { id: "a4", kind: "excluded_collision", value: "collision_value_zz", confidence: 15, source: "x", metadata: {} },
    { id: "a5", kind: "triage_decision", value: "Stage 2 OPEN", confidence: 50, source: "agent", metadata: {} },
  ]));
  assertStringIncludes(out, "visible_one");
  assertStringIncludes(out, "released_one");
  assert(!out.includes("name_only_stranger"));
  assert(!out.includes("collision_value_zz"));
  assert(!out.includes("Stage 2 OPEN"));
  assertStringIncludes(out, "3 withheld");
});

Deno.test("every persisted exclusion representation is withheld, however it is spelled (Codex P2 on #974)", () => {
  const cases: Row[] = [
    { id: "x1", kind: "social_profile", value: "ruled_out_by_status", confidence: 90, source: "s", metadata: { status: "excluded" } },
    { id: "x2", kind: "social_profile", value: "ruled_out_by_status_case", confidence: 90, source: "s", metadata: { status: "Excluded" } },
    { id: "x3", kind: "social_profile", value: "ruled_out_status_collision", confidence: 90, source: "s", metadata: { status: "excluded_collision" } },
    { id: "x4", kind: "social_profile", value: "ruled_out_status_rejected", confidence: 90, source: "s", metadata: { status: "rejected" } },
    { id: "x5", kind: "excluded_collision_summary", value: "ruled_out_summary_kind", confidence: 90, source: "s", metadata: {} },
    { id: "x6", kind: "social_profile", value: "ruled_out_collision_flag", confidence: 90, source: "s", metadata: { collision: true } },
    { id: "x7", kind: "social_profile", value: "ruled_out_possible_collision", confidence: 90, source: "s", metadata: { possible_collision: true } },
  ];
  const out = renderFindingsTable(input([artifact("a1", "kept_row", 60), ...cases]));
  assertStringIncludes(out, "kept_row");
  for (const c of cases) assert(!out.includes(String(c.value)), `${c.value} must not be listed`);
  assert(!/Confirmed/.test(out), "a status-excluded row at 90 must never print as Confirmed");
  assertStringIncludes(out, "7 withheld");
});

Deno.test("pin: the withholding set covers every kind/status recovery.ts and the report layer treat as excluded or non-evidence", () => {
  const rows: Row[] = [];
  for (const k of [...EXCLUDED_KINDS, ...NON_EVIDENCE_KINDS]) {
    rows.push({ id: `k-${k}`, kind: k, value: `pin_kind_${k}`, confidence: 80, source: "s", metadata: {} });
  }
  for (const st of EXCLUDED_STATUSES) {
    rows.push({ id: `s-${st}`, kind: "username", value: `pin_status_${st}`, confidence: 80, source: "s", metadata: { status: st } });
  }
  const out = renderFindingsTable(input(rows));
  for (const r of rows) assert(!out.includes(String(r.value)), `${r.value} listed — the sets drifted from recovery.ts`);
});

Deno.test("footer states the row basis honestly", () => {
  const out = renderFindingsTable(input([finding("f1", "c", 80), artifact("a1", "h", 50), artifact("a2", "h2", 50)], {
    rejectedFindingCount: 2,
  }));
  assertStringIncludes(out, "3 rows from this run's evidence record");
  assertStringIncludes(out, "1 recorded as findings (record_finding)");
  assertStringIncludes(out, "2 finding rows excluded by analyst review");
});

Deno.test("zero adjudicated rows: footer carries the honest count and does NOT reproduce the UI's own zero-adjudication sentence", () => {
  const out = renderFindingsTable(input([artifact("a1", "h", 50)]));
  assertStringIncludes(out, "0 recorded as findings (record_finding)");
  assert(!/nothing in the narrative above was adjudicated/i.test(out));
  assert(!/No authoritative finding rows were recorded/i.test(out));
});

Deno.test("zero rows at all: no empty table shell, an honest line instead", () => {
  const out = renderFindingsTable(input([]));
  assert(!out.includes("|---") && !out.includes("| ---"));
  assertStringIncludes(out, "0 rows from this run's evidence record");
});

Deno.test("ceiling_hit: footer discloses the window may be incomplete", () => {
  const out = renderFindingsTable(input([artifact("a1", "h", 50)], { retrieval: "ceiling_hit", totalArtifactCount: 500 }));
  assertStringIncludes(out, "retrieval ceiling reached");
});

Deno.test("retrieval unavailable: no rows, a stated reason, and no table", () => {
  const out = renderFindingsTable(input([artifact("a1", "h", 50)], { retrieval: "unavailable" }));
  assertStringIncludes(out, "could not be read");
  assert(!out.includes("| h |") && !out.includes("|---"));
});

Deno.test("analyst verdicts unreadable: FAIL CLOSED — no rows listed", () => {
  const out = renderFindingsTable(input([artifact("a1", "would_be_republished", 70)], { reviews: "unavailable" }));
  assert(!out.includes("would_be_republished"));
  assertStringIncludes(out, "analyst review");
});

Deno.test("bounded by rows: a huge population renders at most MAX_ROWS and says how many were cut", () => {
  const rows = Array.from({ length: FINDINGS_TABLE_MAX_ROWS + 25 }, (_, i) =>
    artifact(`a${String(i).padStart(4, "0")}`, `handle_${i}`, 50));
  const out = renderFindingsTable(input(rows));
  const dataRows = out.split("\n").filter((l) => /^\| \d+ /.test(l));
  assertEquals(dataRows.length, FINDINGS_TABLE_MAX_ROWS);
  assertStringIncludes(out, `first ${FINDINGS_TABLE_MAX_ROWS} of ${FINDINGS_TABLE_MAX_ROWS + 25}`);
});

Deno.test("bounded by bytes: hostile 50KB values cannot consume the budget", () => {
  const rows = Array.from({ length: 40 }, (_, i) => artifact(`a${i}`, "x".repeat(50_000), 50));
  const out = renderFindingsTable(input(rows));
  assert(new TextEncoder().encode(out).length < 20_000, "hard byte ceiling holds");
  assertStringIncludes(out, "…");
});

Deno.test("cell text is escaped: pipes, newlines, brackets, HTML and link syntax cannot break the table or inject markup", () => {
  const evil = "a|b\nc [x](https://example.test) <img src=x> `tick` *star*";
  const out = renderFindingsTable(input([artifact("a1", evil, 50)]));
  const row = out.split("\n").find((l) => l.startsWith("| 1 "))!;
  assert(!row.includes("\n"));
  assertEquals((row.match(/(?<!\\)\|/g) ?? []).length, 9, "only the structural pipes are unescaped (8 columns)");
  assert(!/(?<!\\)[<>`*]/.test(row), "no unescaped HTML / code / emphasis characters survive in the row");
  assert(!/(?<!\\)\[x\]/.test(row));
});

Deno.test("expand: marker alone on a line is replaced; surrounding text is untouched", () => {
  const src = "## Findings\n\n{{FINDINGS_TABLE}}\n\n## Summary\nbody";
  const { content, event } = expandFindingsTable(src, input([artifact("a1", "h", 50)]));
  assert(!content.includes(FINDINGS_TABLE_MARKER));
  assertStringIncludes(content, "## Summary\nbody");
  assertStringIncludes(content, "| h ");
  assertEquals(event.name, "findings_table_expanded");
  assertEquals(event.marker_found, true);
  assertEquals(event.replaced, 1);
});

Deno.test("expand: tolerates surrounding whitespace and one trailing colon, nothing else", () => {
  for (const line of ["  {{FINDINGS_TABLE}}  ", "{{FINDINGS_TABLE}}:", "\t{{FINDINGS_TABLE}} :"]) {
    const { content, event } = expandFindingsTable(`intro\n${line}\noutro`, input([artifact("a1", "h", 50)]));
    assertEquals(event.replaced, 1, JSON.stringify(line));
    assert(!content.includes(FINDINGS_TABLE_MARKER));
  }
});

Deno.test("expand: a marker embedded in prose is NOT replaced (no regex over model prose)", () => {
  const src = "The table goes where {{FINDINGS_TABLE}} appears, per the contract.";
  const { content, event } = expandFindingsTable(src, input([artifact("a1", "h", 50)]));
  assertEquals(content, src);
  assertEquals(event.marker_found, false);
});

Deno.test("expand: marker absent → content unchanged, marker_found false", () => {
  const src = "## Findings\n| a | b |\n|---|---|\n| 1 | 2 |";
  const { content, event } = expandFindingsTable(src, input([artifact("a1", "h", 50)]));
  assertEquals(content, src);
  assertEquals(event.marker_found, false);
  assertEquals(event.replaced, 0);
});

Deno.test("expand: marker twice → one table, the second occurrence is removed rather than duplicated", () => {
  const src = "{{FINDINGS_TABLE}}\nmid\n{{FINDINGS_TABLE}}\nend";
  const { content, event } = expandFindingsTable(src, input([artifact("a1", "h", 50)]));
  assertEquals((content.match(/\| 1 \|/g) ?? []).length, 1, "exactly one table");
  assert(!content.includes(FINDINGS_TABLE_MARKER));
  assertEquals(event.replaced, 2);
  assertStringIncludes(content, "mid");
  assertStringIncludes(content, "end");
});

Deno.test("expand: a render error leaves content UNCHANGED and reports the error NAME only", () => {
  const poisoned = {
    id: "p", kind: "username", confidence: 50, source: "s", metadata: {},
    get value(): string { throw new TypeError("secret-bearing message that must not be logged"); },
  };
  const src = "{{FINDINGS_TABLE}}";
  const { content, event } = expandFindingsTable(src, input([poisoned as unknown as Row]));
  assertEquals(content, src);
  assertEquals(event.name, "findings_table_expansion_failed");
  assertEquals(event.error, "TypeError");
  assert(!JSON.stringify(event).includes("secret-bearing"));
});

Deno.test("parts: expands text parts in a COPY; the input parts are never mutated (invariant 3)", () => {
  const parts = [
    { type: "text", text: "## Findings\n\n{{FINDINGS_TABLE}}\n\n## Summary\nbody" },
    { type: "tool-record_artifacts", state: "output-available" },
  ];
  const snapshot = JSON.stringify(parts);
  const out = expandFindingsTableInParts(parts, input([artifact("a1", "h", 50)]), { shapeOk });
  assertEquals(JSON.stringify(parts), snapshot, "input untouched");
  assertNotEquals(out.parts, parts);
  assertStringIncludes((out.parts[0] as { text: string }).text, "| h ");
  assertEquals(out.parts[1], parts[1], "non-text parts pass through by identity");
});

Deno.test("parts: a STUB containing only the marker is left raw — expansion must not manufacture report shape", () => {
  const parts = [{ type: "text", text: "{{FINDINGS_TABLE}}" }];
  const out = expandFindingsTableInParts(parts, input([artifact("a1", "h", 50)]), { shapeOk });
  assertEquals(out.parts, parts);
  assertEquals(out.event.skipped, "no_report_shape");
  assertEquals(out.event.marker_found, true);
  assertEquals(out.event.replaced, 0);
});

Deno.test("parts: report shape is judged on the text WITHOUT the marker, across all text parts", () => {
  const parts = [
    { type: "text", text: "narration before" },
    { type: "text", text: "## Summary\nstrongest leads\n\n{{FINDINGS_TABLE}}" },
  ];
  const out = expandFindingsTableInParts(parts, input([artifact("a1", "h", 50)]), { shapeOk });
  assertEquals(out.event.replaced, 1);
});

Deno.test("parts: no marker anywhere → the SAME array is returned, marker_found false", () => {
  const parts = [{ type: "text", text: "## Findings\nplain" }];
  const out = expandFindingsTableInParts(parts, input([]), { shapeOk });
  assertEquals(out.parts, parts);
  assertEquals(out.event.marker_found, false);
});

Deno.test("parts: malformed parts input degrades to unchanged, never throws", () => {
  const out = expandFindingsTableInParts(null as unknown as unknown[], input([]), { shapeOk });
  assertEquals(out.parts, null);
});

Deno.test("self-test: the /health fixture renders to its pinned expected string", () => {
  const r = runFindingsTableSelfTest();
  assertEquals(r.ok, true, r.detail);
  assertStringIncludes(r.expected, "| 1 | synthetic claim alpha |");
});
