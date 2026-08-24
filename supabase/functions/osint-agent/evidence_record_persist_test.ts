/**
 * evidence_record_persist_test.ts — #479 invariants 2 and 3.
 *
 * Invariant 2: the authoritative block must survive message-size capping.
 *   capPartsSize's LAST stage (safety.ts:450) concatenates every text/reasoning
 *   part and binary-searches a PREFIX of that concatenation. A block appended at
 *   the tail and then capped is exactly what gets sliced off, so a long enough
 *   model narrative would silently delete the authoritative record. Reservation,
 *   not ordering, is what fixes this.
 *
 * Invariant 3: the block must not weaken the completion contract.
 *   resolveTerminalState reads `finalMessages`. If composing mutated the assistant
 *   message in place, a stub run's "I'll start" would gain structure it did not
 *   earn. The composer therefore never mutates its input — the persisted array is
 *   a separate value.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { composePersistedParts } from "./lib/evidence-record-persist.ts";
import { EVIDENCE_RECORD_MAX_BYTES, buildEvidenceRecord } from "./lib/evidence-record.ts";
import { meetsCompletionContract, resolveTerminalState } from "./orchestrator-finalize.ts";

const MAX = 500_000;
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
const textParts = (parts: unknown[]) =>
  parts.filter((p) => (p as { type?: string })?.type === "text");
const allText = (parts: unknown[]) =>
  textParts(parts).map((p) => (p as { text: string }).text).join("\n");

const RECORD = buildEvidenceRecord({
  rows: [{ id: "a", kind: "finding", value: "Subject operates the domain", confidence: 50, metadata: {} }],
  totalArtifactCount: 40,
  retrieval: "complete", reviews: "applied", rejectedFindingCount: 0,
});
/** The common production state: a successful read that found no adjudicated rows. */
const EMPTY_RECORD = buildEvidenceRecord({ rows: [], totalArtifactCount: 49, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 });
/** The failed-read state. Renders differently, and must be just as inert. */
const UNAVAILABLE_RECORD = buildEvidenceRecord({ rows: [], totalArtifactCount: 0, retrieval: "unavailable" });

const toolPart = (id: string, kb: number) => ({
  type: "tool-oathnet_lookup",
  toolCallId: id,
  toolName: "oathnet_lookup",
  state: "output-available",
  output: { raw: "x".repeat(kb * 1024) },
});

// ── Invariant 2 ───────────────────────────────────────────────────────────────

Deno.test("the record survives a narrative far larger than the whole budget", () => {
  const parts = [{ type: "text", text: "N".repeat(2_000_000) }];
  const out = composePersistedParts(parts, RECORD, MAX);
  assertStringIncludes(allText(out), RECORD, "the authoritative block must survive verbatim");
});

Deno.test("the record survives oversized tool payloads too", () => {
  const parts = [
    { type: "text", text: "the model's report" },
    toolPart("t1", 400),
    toolPart("t2", 400),
    toolPart("t3", 400),
  ];
  const out = composePersistedParts(parts, RECORD, MAX);
  assertStringIncludes(allText(out), RECORD);
});

Deno.test("composing never exceeds the hard storage ceiling", () => {
  for (const parts of [
    [{ type: "text", text: "N".repeat(2_000_000) }],
    [{ type: "text", text: "N".repeat(900_000) }, toolPart("t1", 600)],
    [toolPart("t1", 900), toolPart("t2", 900)],
  ]) {
    assert(bytes(composePersistedParts(parts, RECORD, MAX)) <= MAX, "must respect the 500KB ceiling");
  }
});

Deno.test("an oversized narrative is what gets trimmed, not the record", () => {
  const parts = [{ type: "text", text: "N".repeat(2_000_000) }];
  const out = composePersistedParts(parts, RECORD, MAX);
  const text = allText(out);
  assert(text.includes(RECORD), "record intact");
  assert(text.length < 2_000_000, "the narrative is the side that gives way");
});

Deno.test("the record is merged into the last text part, not appended as a new one", () => {
  // useThreadMessages.ts:73 takes the LAST text part as the thread-list preview.
  // A separate trailing part would replace the report's preview with the block's.
  const parts = [{ type: "text", text: "the model's report" }, toolPart("t1", 1)];
  const out = composePersistedParts(parts, RECORD, MAX);
  assertEquals(textParts(out).length, 1, "no new text part when one already exists");
  const only = (textParts(out)[0] as { text: string }).text;
  assert(only.startsWith("the model's report"), "the report still leads the part");
  assertStringIncludes(only, RECORD);
});

Deno.test("a message with no text part still receives the record", () => {
  const out = composePersistedParts([toolPart("t1", 1)], RECORD, MAX);
  assertEquals(textParts(out).length, 1);
  assertStringIncludes(allText(out), RECORD);
});

Deno.test("NUL never reaches the insert", () => {
  const parts = [{ type: "text", text: "report\u0000with a nul" }];
  const out = composePersistedParts(parts, RECORD, MAX);
  assert(!JSON.stringify(out).includes("\\u0000"), "2026-08-02: one NUL discards the whole report");
});

Deno.test("an oversized record squeezes the narrative rather than breaching the ceiling", () => {
  // The renderer bounds the record at EVIDENCE_RECORD_MAX_BYTES, so this cannot
  // happen in production — but composePersistedParts is a general function, and a
  // reserve that is clamped (or a floor under the narrative) would silently push
  // the total past maxBytes here. The ceiling is the hard DB constraint; the
  // narrative is what yields.
  const huge = "R".repeat(400_000);
  const out = composePersistedParts([{ type: "text", text: "N".repeat(600_000) }], huge, MAX);
  assert(bytes(out) <= MAX, `ceiling must hold, got ${bytes(out)}`);
  assertStringIncludes(allText(out), huge, "the record is the half that survives");
});

Deno.test("the ceiling holds for a small maxBytes too", () => {
  const out = composePersistedParts([{ type: "text", text: "N".repeat(100_000) }], RECORD, 10_000);
  assert(bytes(out) <= 10_000, `ceiling must hold at any budget, got ${bytes(out)}`);
});

Deno.test("the reserved budget is bounded by the record's own ceiling", () => {
  // A pathological record must not be able to starve the narrative outright: the
  // renderer bounds itself, and the reservation can never exceed that bound.
  assert(new TextEncoder().encode(RECORD).length <= EVIDENCE_RECORD_MAX_BYTES);
  const parts = [{ type: "text", text: "N".repeat(600_000) }];
  const out = composePersistedParts(parts, RECORD, MAX);
  assert(allText(out).length > 100_000, "the narrative must keep the lion's share of the budget");
});

// ── Invariant 3 ───────────────────────────────────────────────────────────────

Deno.test("composing does not mutate the caller's parts array", () => {
  const parts: unknown[] = [{ type: "text", text: "I'll start" }];
  const snapshot = JSON.parse(JSON.stringify(parts));
  composePersistedParts(parts, RECORD, MAX);
  assertEquals(parts, snapshot, "finalMessages must be untouched — the contract reads it");
});

Deno.test("THE STUB CASE: a run that never reported stays Interrupted", () => {
  // The production failure this guards: a 10-character stub was a run's durable
  // final message. If the Evidence Record reached `finalMessages`, its heading and
  // rows would hand that stub the structure the completion contract looks for.
  const finalMessages = [{ role: "assistant", parts: [{ type: "text", text: "I'll start" }] }];
  const before = meetsCompletionContract(finalMessages as never);
  assertEquals(before, false, "precondition: the stub does not meet the contract");

  composePersistedParts(finalMessages[0].parts, RECORD, MAX);

  assertEquals(meetsCompletionContract(finalMessages as never), false, "still not a report");
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: true, finalMessages: finalMessages as never }).recoveryReason,
    "incomplete: run ended without a durable report",
  );
});

Deno.test("a genuine report is still COMPLETE after composing", () => {
  const finalMessages = [{
    role: "assistant",
    parts: [{ type: "text", text: "## Findings report\n\nThe subject operates the domain, corroborated across two classes." }],
  }];
  composePersistedParts(finalMessages[0].parts, RECORD, MAX);
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: true, finalMessages: finalMessages as never }).recoveryReason,
    null,
  );
});

Deno.test("NUL inside the RECORD is scrubbed too, not only the narrative", () => {
  // The record is sanitized at render, but the composer is the persistence
  // boundary: whatever reaches it must be scrubbed regardless of provenance,
  // because it is the last thing to run before the JSONB insert.
  const out = composePersistedParts(
    [{ type: "text", text: "the model's report" }],
    "## Evidence Record — authoritative\n\nrow\u0000with a nul",
    MAX,
  );
  assert(!JSON.stringify(out).includes("\\u0000"), "one NUL discards the whole report (2026-08-02)");
  // Scrubbed, not dropped: stripNulCharacters removes the character and keeps the
  // surrounding text, so the record still arrives whole.
  assertStringIncludes(allText(out), "## Evidence Record — authoritative");
  assertStringIncludes(allText(out), "rowwith a nul");
});

Deno.test("the record is written exactly once", () => {
  const parts = [
    { type: "text", text: "opening narration" },
    toolPart("t1", 1),
    { type: "text", text: "the model's report" },
  ];
  const text = allText(composePersistedParts(parts, RECORD, MAX));
  assertEquals(text.split(RECORD).length - 1, 1, "duplicating the block would double every row in it");
});

Deno.test("the thread-list preview still leads with the narrative", () => {
  // useThreadMessages.ts:73 previews the LAST text part. The record is merged into
  // the tail of that part rather than replacing it, so the preview keeps showing
  // the analyst's report rather than an audit block on every row of the list.
  const parts = [{ type: "text", text: "The subject operates the domain." }];
  const out = composePersistedParts(parts, RECORD, MAX);
  const last = (textParts(out).at(-1) as { text: string }).text;
  assert(last.startsWith("The subject operates the domain."), `preview must lead with the report, got: ${last.slice(0, 60)}`);
});

// ── Completion isolation across EVERY rendering of the block ──────────────────

Deno.test("a stub run stays Interrupted for every record state", () => {
  // Populated, zero-findings and unavailable are three different strings, and any
  // one of them reaching `finalMessages` would be the regression #390 exists to
  // prevent. The composer's non-mutation is what holds; this pins it per state so
  // a future rendering cannot quietly acquire report shape.
  for (const [name, record] of [["populated", RECORD], ["empty", EMPTY_RECORD], ["unavailable", UNAVAILABLE_RECORD]] as const) {
    const finalMessages = [{ role: "assistant", parts: [{ type: "text", text: "I'll start" }] }];
    assertEquals(meetsCompletionContract(finalMessages as never), false, `${name}: precondition`);
    const persisted = composePersistedParts(finalMessages[0].parts, record, MAX);
    assertStringIncludes(allText(persisted), record, `${name}: the record must still be persisted`);
    assertEquals(meetsCompletionContract(finalMessages as never), false, `${name}: still not a report`);
    assertEquals(
      resolveTerminalState({ assistantRowPersisted: true, finalMessages: finalMessages as never }).recoveryReason,
      "incomplete: run ended without a durable report",
      `${name}: must stay Interrupted`,
    );
  }
});

Deno.test("a salvaged report stays COMPLETE, and the record is not what made it so", () => {
  // The salvage backstop is the ONE writer allowed to mutate assistant.parts,
  // because a salvaged report is a real report. Composing afterwards must neither
  // break that nor be the reason it passes.
  const salvaged = "## Findings report\n\nThe subject operates the domain, corroborated across two classes.";
  const finalMessages = [{ role: "assistant", parts: [] as unknown[] }];
  finalMessages[0].parts = [...finalMessages[0].parts, { type: "text", text: salvaged }];
  assertEquals(meetsCompletionContract(finalMessages as never), true, "salvage earns the contract on its own");
  composePersistedParts(finalMessages[0].parts, UNAVAILABLE_RECORD, MAX);
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: true, finalMessages: finalMessages as never }).recoveryReason,
    null,
  );
});
