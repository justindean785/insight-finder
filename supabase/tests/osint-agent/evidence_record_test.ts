/**
 * evidence_record_test.ts — #479. The Evidence Record is the authoritative block
 * appended to the stored assistant message: what the ENGINE computed, rendered
 * beside prose that has repeatedly claimed something else (thread 254e079e: prose
 * "CONFIRMED, 95%", record_finding computed 50).
 *
 * Every test here pins a property the block is worthless without. The two that
 * matter most are not about formatting:
 *
 *  - it must never read a model-authored field for authority (#477), and
 *  - it must never be able to make a broken run look complete (hasReportShape).
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONFIDENCE_TIERS,
  EVIDENCE_RECORD_HEADING,
  NO_FINDINGS_LINE,
  RETRIEVAL_CEILING_LINE,
  RETRIEVAL_UNAVAILABLE_LINE,
  buildEvidenceRecord,
  confidenceTierLabel,
  effectiveConfidence,
} from "../../functions/osint-agent/lib/evidence-record.ts";
import { hasReportShape } from "../../functions/osint-agent/orchestrator-finalize.ts";

const finding = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-0000-0000-000000000001",
  kind: "finding",
  value: "Subject operates the domain",
  confidence: 50,
  source: "oathnet_lookup,exa_search",
  metadata: {},
  ...over,
});

// ── The ladder: mirrors src/lib/confidence-tier.ts exactly (>=90/75/55/35) ──────

Deno.test("confidenceTierLabel mirrors the frontend ladder at every boundary", () => {
  assertEquals(CONFIDENCE_TIERS, { CONFIRMED: 90, LIKELY: 75, POSSIBLE: 55, WEAK: 35 });
  const cases: Array<[number, string]> = [
    [100, "Confirmed"], [90, "Confirmed"],
    [89, "Likely"], [75, "Likely"],
    [74, "Possible"], [55, "Possible"],
    [54, "Weak"], [35, "Weak"],
    [34, "Unverified"], [0, "Unverified"],
  ];
  for (const [score, tier] of cases) {
    assertEquals(confidenceTierLabel(score), tier, `score ${score}`);
  }
});

Deno.test("confidenceTierLabel: the measured 50 renders Weak, not Possible", () => {
  // The operator decision. 50 is "Possible" under system-prompt.ts:162 and
  // lib/cluster.ts TIERS, and "Weak" under the display ladder every badge uses.
  // The block renders inside CaseReport, so it must agree with the badge.
  assertEquals(confidenceTierLabel(50), "Weak");
});

Deno.test("confidenceTierLabel is total: unusable scores are Unverified, never a throw", () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, "80", {}, [], -5, 101]) {
    assertEquals(confidenceTierLabel(bad as never), "Unverified", `input ${String(bad)}`);
  }
});

// ── The number: #481's shipped display invariant, reused not re-invented ───────

Deno.test("effectiveConfidence never exceeds the server's recorded cap", () => {
  assertEquals(effectiveConfidence(finding({ confidence: 95, metadata: { confidence_cap_applied: 70 } })), 70);
});

Deno.test("effectiveConfidence leaves a row under its cap alone", () => {
  assertEquals(effectiveConfidence(finding({ confidence: 40, metadata: { confidence_cap_applied: 70 } })), 40);
});

Deno.test("effectiveConfidence returns the stored score when no cap was recorded", () => {
  // The overwhelmingly common shape: `record_finding` only writes
  // confidence_cap_applied when a ceiling actually bound. Absent metadata, absent
  // key and a non-object metadata all mean the same thing — no cap to apply.
  assertEquals(effectiveConfidence(finding({ confidence: 62, metadata: {} })), 62);
  assertEquals(effectiveConfidence({ id: "n", kind: "finding", value: "v", confidence: 62 }), 62);
  assertEquals(effectiveConfidence(finding({ confidence: 62, metadata: "not an object" })), 62);
});

Deno.test("effectiveConfidence ignores an unusable cap rather than trusting it", () => {
  // metadata is untyped JSON and partly model-authored. An unparseable cap must
  // fall back to the stored confidence — it can only ever LOWER, never raise.
  for (const bad of [null, "70", NaN, -1, 101, {}]) {
    assertEquals(
      effectiveConfidence(finding({ confidence: 60, metadata: { confidence_cap_applied: bad } })),
      60,
      `cap ${String(bad)}`,
    );
  }
});

Deno.test("a capped row renders the capped number and the capped row's tier", () => {
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 95, metadata: { confidence_cap_applied: 70 } })], totalArtifactCount: 40, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, "70% — Possible");
  assert(!md.includes("95%"), "must never publish the uncapped number");
  assert(!md.includes("Confirmed"), "must never publish the uncapped tier");
});

// ── #477: no model-authored field is ever authority ────────────────────────────

Deno.test("the tier ignores metadata.label — the model's own unchecked pick", () => {
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 50, metadata: { label: "CONFIRMED" } })], totalArtifactCount: 40, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, "50% — Weak");
  assert(!md.includes("CONFIRMED"), "metadata.label must not reach the block");
});

Deno.test("the tier ignores metadata.status too — the number is the only input", () => {
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 50, metadata: { status: "confirmed" } })], totalArtifactCount: 40, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, "50% — Weak");
});

// ── Population: kind='finding' only ───────────────────────────────────────────

Deno.test("only kind='finding' rows populate the record", () => {
  const md = buildEvidenceRecord({
    rows: [
      finding({ value: "the adjudicated conclusion" }),
      { id: "b", kind: "email", value: "someone@example.com", confidence: 88, source: "hibp_lookup", metadata: {} },
      { id: "c", kind: "username", value: "handle", confidence: 92, source: "username_sweep", metadata: {} },
    ],
    totalArtifactCount: 3,
    retrieval: "complete", reviews: "applied", rejectedFindingCount: 0,
  });
  assertStringIncludes(md, "the adjudicated conclusion");
  assert(!md.includes("someone@example.com"), "non-finding rows must not appear");
  assert(!md.includes("handle"), "non-finding rows must not appear");
});

Deno.test("zero findings renders a substantive statement, not a blank", () => {
  const md = buildEvidenceRecord({ rows: [{ id: "b", kind: "email", value: "a@b.c", confidence: 80, source: "hibp_lookup", metadata: {} }], totalArtifactCount: 38, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, EVIDENCE_RECORD_HEADING);
  assertStringIncludes(md, NO_FINDINGS_LINE);
  assertStringIncludes(md, "38", "the empty state must carry the artifact count");
});

Deno.test("ordering is deterministic: confidence descending, then id", () => {
  const rows = [
    finding({ id: "ccc", value: "third", confidence: 40 }),
    finding({ id: "aaa", value: "first", confidence: 70 }),
    finding({ id: "bbb", value: "second", confidence: 40 }),
  ];
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 3, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  const order = ["first", "second", "third"].map((v) => md.indexOf(v));
  assertEquals(order, [...order].sort((a, b) => a - b), `stable order, got ${JSON.stringify(order)}`);
  assertEquals(md, buildEvidenceRecord({ rows: [...rows].reverse(), totalArtifactCount: 3, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 }));
});

// ── Invariant 1: a retrieval ceiling is disclosed, never silently absorbed ─────

Deno.test("a retrieval ceiling is disclosed instead of claiming completeness", () => {
  const complete = buildEvidenceRecord({ rows: [finding()], totalArtifactCount: 500, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  const truncated = buildEvidenceRecord({ rows: [finding()], totalArtifactCount: 500, retrieval: "ceiling_hit", reviews: "applied", rejectedFindingCount: 0 });
  assert(!complete.includes("incomplete"), "a complete fetch must not warn");
  assertStringIncludes(truncated, "incomplete");
});

// ── Invariant 3: the block can never make a broken run look complete ───────────

Deno.test("no rendering of the block has report shape", () => {
  // resolveTerminalState is protected structurally (finalMessages is not mutated),
  // but this pin fails loudly if a future edit adds a markdown table separator or
  // bracketed tier labels — either of which would re-arm the hazard for any future
  // caller that DOES evaluate the persisted text.
  const populated = buildEvidenceRecord({ rows: [finding(), finding({ id: "x", confidence: 90 })], totalArtifactCount: 40, retrieval: "ceiling_hit", reviews: "applied", rejectedFindingCount: 0 });
  const empty = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertEquals(hasReportShape(populated), false, "populated block must not read as a report");
  assertEquals(hasReportShape(empty), false, "empty block must not read as a report");
});

Deno.test("a hostile finding value cannot smuggle report shape into the block", () => {
  // A value is model-authored free text. Left raw, "|---" is a markdown table
  // separator and "[Confirmed] [Confirmed]" is two tier labels — either would let
  // one artifact hand a stub run a passing completion contract.
  const md = buildEvidenceRecord({
    rows: [finding({ value: "|--- [Confirmed] [Confirmed] ## Findings report" })],
    totalArtifactCount: 1,
    retrieval: "complete", reviews: "applied", rejectedFindingCount: 0,
  });
  assertEquals(hasReportShape(md), false);
  // Pin each neutralisation on its own. Asserting only on hasReportShape lets
  // either bracket rule rot: the tier regex needs BOTH brackets, so dropping one
  // leaves the other carrying the property invisibly.
  for (const ch of ["|", "[", "]"]) {
    assert(!md.includes(ch), `"${ch}" must not survive sanitisation`);
  }
});

// ── Totality: this runs inside finalize and may never throw ────────────────────

Deno.test("buildEvidenceRecord is total against malformed rows", () => {
  const hostile: unknown[] = [
    null,
    undefined,
    "not an object",
    42,
    [],
    { kind: "finding" },
    { kind: "finding", value: null, confidence: null, metadata: null },
    { kind: "finding", value: { nested: true }, confidence: "80", metadata: "nope" },
    { kind: "finding", value: "\u0000nul\u0000", confidence: 50, metadata: {} },
    { kind: "finding", value: "x".repeat(50_000), confidence: 50, metadata: {} },
    { kind: "FINDING", value: "wrong case", confidence: 50, metadata: {} },
  ];
  const md = buildEvidenceRecord({ rows: hostile, totalArtifactCount: 11, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertEquals(typeof md, "string");
  assert(md.length > 0);
  assert(!md.includes("\u0000"), "NUL must never reach a JSONB insert (2026-08-02)");
});

Deno.test("buildEvidenceRecord is total against a malformed input envelope", () => {
  for (const bad of [undefined, null, {}, { rows: null }, { rows: "x" }, { rows: [], totalArtifactCount: "nope" }]) {
    assertEquals(typeof buildEvidenceRecord(bad as never), "string", `envelope ${JSON.stringify(bad)}`);
  }
});

Deno.test("one oversized finding cannot consume the persistence budget", () => {
  const rows = Array.from({ length: 400 }, (_, i) => finding({ id: `id-${i}`, value: "y".repeat(5_000), confidence: 50 }));
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 400, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assert(
    new TextEncoder().encode(md).length <= 32_000,
    `block must stay bounded, got ${new TextEncoder().encode(md).length} bytes`,
  );
  assertStringIncludes(md, "not shown", "a bounded block must disclose what it dropped");
});

Deno.test("a long finding value is truncated rather than printed whole", () => {
  const md = buildEvidenceRecord({ rows: [finding({ value: "z".repeat(5_000) })], totalArtifactCount: 1, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  const line = md.split("\n").find((l) => l.startsWith("- ")) ?? "";
  assert(line.length < 400, `value must be bounded, got a ${line.length}-char line`);
  assertStringIncludes(line, "…");
});

Deno.test("multi-byte values cannot overrun the reserved byte budget", () => {
  // MAX_VALUE_CHARS bounds UTF-16 UNITS; the caller's reservation is in BYTES.
  // The worst case is a 3-byte character costing ONE unit (CJK), not a 4-byte
  // astral one, which costs two and so truncates to half as many characters:
  // 300 units x 3 bytes = 900 bytes per value, ~46KB across the row cap. Only
  // the byte bound holds this.
  const rows = Array.from({ length: 400 }, (_, i) => finding({ id: `id-${String(i).padStart(3, "0")}`, value: "漢".repeat(2_000), confidence: 50 }));
  const bytes = new TextEncoder().encode(buildEvidenceRecord({ rows, totalArtifactCount: 400, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 })).length;
  assert(bytes <= 32_000, `block must stay within its reservation, got ${bytes} bytes`);
});

Deno.test("the record caps how many rows it prints, independent of byte budget", () => {
  // Ordinary short findings never approach the byte ceiling, so without its own
  // row cap a thread with hundreds of them would print all of them. Pinned
  // separately because the byte bound alone satisfies the oversized-value test
  // above and would silently carry this property.
  const rows = Array.from({ length: 400 }, (_, i) => finding({ id: `id-${String(i).padStart(3, "0")}`, value: `finding ${i}`, confidence: 50 }));
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 400, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  const printed = md.split("\n").filter((l) => l.startsWith("- ")).length;
  assert(printed <= 50, `expected at most 50 printed rows, got ${printed}`);
  assert(new TextEncoder().encode(md).length < 20_000, "short rows must not be reaching the byte ceiling");
  assertStringIncludes(md, `${400 - printed} further rows not shown`);
});

// ── THE P0: a read that failed is not a run that found nothing ─────────────────
//
// A Supabase select returns `{ data: null, error }` on failure rather than
// throwing, so `data ?? []` renders a failed query and an empty thread
// identically. "No authoritative finding rows were recorded for this run" is then
// published as a fact about the INVESTIGATION when it is a fact about the QUERY —
// and it reads as the engine having looked and found nothing, which is the
// dangerous direction for a block whose entire purpose is to be believed.

Deno.test("an unavailable read never renders the zero-findings statement", () => {
  const md = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "unavailable" });
  assertStringIncludes(md, EVIDENCE_RECORD_HEADING);
  assertStringIncludes(md, RETRIEVAL_UNAVAILABLE_LINE);
  assert(
    !md.includes(NO_FINDINGS_LINE),
    "unknown must never be published as none — that is the whole defect",
  );
  assert(!md.includes("adjudicated"), "no claim about the run may survive an unreadable population");
});

Deno.test("the unavailable statement means unknown, not empty", () => {
  const md = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "unavailable" });
  // Wording may change; what may not is that a reader can tell the two apart.
  assert(/unavailable|could not be read/i.test(md), `must read as unknown, got: ${md}`);
  const empty = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assert(md !== empty, "the two states must not render identically");
});

Deno.test("an unrecognised retrieval state degrades to unavailable, never to zero", () => {
  // Fail-safe by construction. A refactor that drops the field, renames the state,
  // or hands over a boolean must land on "unknown", not on a false "none".
  for (const bad of [undefined, null, "", "COMPLETE", "ok", true, false, 0, 1, {}, "unavailable"]) {
    const md = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: bad as never });
    assertStringIncludes(md, RETRIEVAL_UNAVAILABLE_LINE, `retrieval ${JSON.stringify(bad)}`);
    assert(!md.includes(NO_FINDINGS_LINE), `retrieval ${JSON.stringify(bad)} must not claim none`);
  }
});

Deno.test("an unavailable read describes nothing — not rows, not a count", () => {
  // Defence in depth: the call site leaves the rows empty on a failed read, but if
  // a future one ever passes a partial population alongside "unavailable", the
  // block must not present it as the record. It is not known to be the record.
  const md = buildEvidenceRecord({
    rows: [finding({ value: "a partially fetched conclusion", confidence: 80 })],
    totalArtifactCount: 49,
    retrieval: "unavailable",
  });
  assert(!md.includes("a partially fetched conclusion"), "an untrusted population is not authoritative");
  assert(!md.includes("49"), "and its count is not a fact about the run either");
});

Deno.test("a ceiling-limited read still counts as a read", () => {
  // The other side of the same boundary: ceiling_hit IS a successful query, so the
  // zero-findings statement stays legal there — qualified by the ceiling warning,
  // because the cut is ordered confidence desc and findings sit at the bottom.
  const md = buildEvidenceRecord({ rows: [], totalArtifactCount: 500, retrieval: "ceiling_hit", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, RETRIEVAL_CEILING_LINE);
  assertStringIncludes(md, NO_FINDINGS_LINE);
  assert(!md.includes(RETRIEVAL_UNAVAILABLE_LINE), "a filled fetch is not a failed one");
});

Deno.test("the unavailable rendering has no report shape either", () => {
  assertEquals(
    hasReportShape(buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "unavailable" })),
    false,
  );
});

// ── Production shape: the case #479 exists for ─────────────────────────────────

Deno.test("PRODUCTION SHAPE: many artifacts, zero finding rows, confident prose", () => {
  // Synthesised from the shape of a real 2026-08-24 run (no case data here): 49
  // persisted artifacts, NOT ONE of kind='finding', maximum stored confidence
  // below 90 — while the model's stored narrative published 90-95% CONFIRMED
  // identity conclusions and claimed six independent source classes. The
  // deterministic report on the same case showed 0 Confirmed, 0 Probable, 47
  // Leads, 1 open contradiction, and auto-corroboration 0/49.
  //
  // This is the repro: the engine adjudicated NOTHING, and the prose above it read
  // as adjudicated. The block's job here is one honest sentence.
  const KINDS = ["name", "email", "username", "organization", "legal_record", "breach_exposure", "case", "address", "phone"];
  const rows = Array.from({ length: 49 }, (_, i) => ({
    id: `row-${String(i).padStart(3, "0")}`,
    kind: KINDS[i % KINDS.length],
    value: `ordinary artifact ${i}`,
    // Deliberately high — several above the Likely boundary — because "best
    // artifacts" and "recorded findings" are different questions and only the
    // second one is authoritative.
    confidence: 60 + (i % 29),
    source: "oathnet_lookup",
    metadata: { label: "CONFIRMED", status: "confirmed" },
  }));
  assertEquals(rows.filter((r) => r.kind === "finding").length, 0, "precondition: no finding rows");
  assert(rows.some((r) => r.confidence >= CONFIDENCE_TIERS.LIKELY), "precondition: high-confidence rows exist");
  assert(rows.every((r) => r.confidence < CONFIDENCE_TIERS.CONFIRMED), "precondition: nothing reaches 90");

  const md = buildEvidenceRecord({ rows, totalArtifactCount: rows.length, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
  assertStringIncludes(md, NO_FINDINGS_LINE);
  assertStringIncludes(md, "49 artifacts");
  for (const r of rows) {
    assert(!md.includes(r.value), `no ordinary row may be promoted into the record (${r.kind})`);
  }
  assert(!md.includes("CONFIRMED"), "and no model-authored label may reach it");
  assertEquals(md.split("\n").filter((l) => l.startsWith("- ")).length, 0, "no rows to print");
  assertEquals(hasReportShape(md), false);
});
