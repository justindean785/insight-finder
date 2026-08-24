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
  buildEvidenceRecord,
  confidenceTierLabel,
  effectiveConfidence,
} from "./lib/evidence-record.ts";
import { hasReportShape } from "./orchestrator-finalize.ts";

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
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 95, metadata: { confidence_cap_applied: 70 } })], totalArtifactCount: 40, retrievalCeilingHit: false });
  assertStringIncludes(md, "70% — Possible");
  assert(!md.includes("95%"), "must never publish the uncapped number");
  assert(!md.includes("Confirmed"), "must never publish the uncapped tier");
});

// ── #477: no model-authored field is ever authority ────────────────────────────

Deno.test("the tier ignores metadata.label — the model's own unchecked pick", () => {
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 50, metadata: { label: "CONFIRMED" } })], totalArtifactCount: 40, retrievalCeilingHit: false });
  assertStringIncludes(md, "50% — Weak");
  assert(!md.includes("CONFIRMED"), "metadata.label must not reach the block");
});

Deno.test("the tier ignores metadata.status too — the number is the only input", () => {
  const md = buildEvidenceRecord({ rows: [finding({ confidence: 50, metadata: { status: "confirmed" } })], totalArtifactCount: 40, retrievalCeilingHit: false });
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
    retrievalCeilingHit: false,
  });
  assertStringIncludes(md, "the adjudicated conclusion");
  assert(!md.includes("someone@example.com"), "non-finding rows must not appear");
  assert(!md.includes("handle"), "non-finding rows must not appear");
});

Deno.test("zero findings renders a substantive statement, not a blank", () => {
  const md = buildEvidenceRecord({ rows: [{ id: "b", kind: "email", value: "a@b.c", confidence: 80, source: "hibp_lookup", metadata: {} }], totalArtifactCount: 38, retrievalCeilingHit: false });
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
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 3, retrievalCeilingHit: false });
  const order = ["first", "second", "third"].map((v) => md.indexOf(v));
  assertEquals(order, [...order].sort((a, b) => a - b), `stable order, got ${JSON.stringify(order)}`);
  assertEquals(md, buildEvidenceRecord({ rows: [...rows].reverse(), totalArtifactCount: 3, retrievalCeilingHit: false }));
});

// ── Invariant 1: a retrieval ceiling is disclosed, never silently absorbed ─────

Deno.test("a retrieval ceiling is disclosed instead of claiming completeness", () => {
  const complete = buildEvidenceRecord({ rows: [finding()], totalArtifactCount: 500, retrievalCeilingHit: false });
  const truncated = buildEvidenceRecord({ rows: [finding()], totalArtifactCount: 500, retrievalCeilingHit: true });
  assert(!complete.includes("incomplete"), "a complete fetch must not warn");
  assertStringIncludes(truncated, "incomplete");
});

// ── Invariant 3: the block can never make a broken run look complete ───────────

Deno.test("no rendering of the block has report shape", () => {
  // resolveTerminalState is protected structurally (finalMessages is not mutated),
  // but this pin fails loudly if a future edit adds a markdown table separator or
  // bracketed tier labels — either of which would re-arm the hazard for any future
  // caller that DOES evaluate the persisted text.
  const populated = buildEvidenceRecord({ rows: [finding(), finding({ id: "x", confidence: 90 })], totalArtifactCount: 40, retrievalCeilingHit: true });
  const empty = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrievalCeilingHit: false });
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
    retrievalCeilingHit: false,
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
  const md = buildEvidenceRecord({ rows: hostile, totalArtifactCount: 11, retrievalCeilingHit: false });
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
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 400, retrievalCeilingHit: false });
  assert(
    new TextEncoder().encode(md).length <= 32_000,
    `block must stay bounded, got ${new TextEncoder().encode(md).length} bytes`,
  );
  assertStringIncludes(md, "not shown", "a bounded block must disclose what it dropped");
});

Deno.test("a long finding value is truncated rather than printed whole", () => {
  const md = buildEvidenceRecord({ rows: [finding({ value: "z".repeat(5_000) })], totalArtifactCount: 1, retrievalCeilingHit: false });
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
  const bytes = new TextEncoder().encode(buildEvidenceRecord({ rows, totalArtifactCount: 400, retrievalCeilingHit: false })).length;
  assert(bytes <= 32_000, `block must stay within its reservation, got ${bytes} bytes`);
});

Deno.test("the record caps how many rows it prints, independent of byte budget", () => {
  // Ordinary short findings never approach the byte ceiling, so without its own
  // row cap a thread with hundreds of them would print all of them. Pinned
  // separately because the byte bound alone satisfies the oversized-value test
  // above and would silently carry this property.
  const rows = Array.from({ length: 400 }, (_, i) => finding({ id: `id-${String(i).padStart(3, "0")}`, value: `finding ${i}`, confidence: 50 }));
  const md = buildEvidenceRecord({ rows, totalArtifactCount: 400, retrievalCeilingHit: false });
  const printed = md.split("\n").filter((l) => l.startsWith("- ")).length;
  assert(printed <= 50, `expected at most 50 printed rows, got ${printed}`);
  assert(new TextEncoder().encode(md).length < 20_000, "short rows must not be reaching the byte ceiling");
  assertStringIncludes(md, `${400 - printed} further rows not shown`);
});
