import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { modelMessageSchema, type ModelMessage } from "npm:ai@6";
import { capToolResultOutputs, normalizeToolOutput, sanitizeModelMessages } from "./message-sanitize.ts";

/**
 * Asserts an array satisfies the AI SDK's ModelMessage[] schema — i.e. it would
 * NOT throw InvalidPromptError ("messages do not match the ModelMessage[]
 * schema") inside streamText.
 */
function assertSchemaValid(msgs: ModelMessage[], label: string) {
  for (const [i, m] of msgs.entries()) {
    const r = (modelMessageSchema as { safeParse: (v: unknown) => { success: boolean; error?: unknown } })
      .safeParse(m);
    assert(r.success, `${label}: message[${i}] failed ModelMessage schema: ${JSON.stringify(r.error)}`);
  }
}

// ---------------------------------------------------------------------------
// REPRODUCTION: the CURRENT (pre-sanitize) shapes that wedge the run. These
// prove the exact failure modes from the production log before asserting the
// sanitizer fixes them.
// ---------------------------------------------------------------------------

Deno.test("REPRO: bare-string / typeless / undefined tool-result outputs are schema-INVALID", () => {
  const bad: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    // bare string output — what the char-budget elision path can emit
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: "[elided]" }] },
  ] as unknown as ModelMessage[];
  const r = (modelMessageSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(bad[2]);
  assert(!r.success, "bare-string tool-result output should fail the schema");
});

Deno.test("REPRO: orphaned assistant tool-call (matching tool-result removed) is unpaired", () => {
  // A trimmer that drops small messages while keeping the giant tool-result can
  // sever a pair — here the assistant tool-call survives but its result is gone.
  const orphaned: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    // (tool result for c1 has been removed)
  ] as unknown as ModelMessage[];
  const hasResult = orphaned.some(
    (m) => m.role === "tool" && Array.isArray(m.content) &&
      (m.content as Array<{ type?: string; toolCallId?: string }>).some(
        (p) => p.type === "tool-result" && p.toolCallId === "c1"),
  );
  assert(!hasResult, "repro fixture must contain an unpaired tool-call");
});

Deno.test("REPRO: undefined/null message content is schema-INVALID", () => {
  const r1 = (modelMessageSchema as { safeParse: (v: unknown) => { success: boolean } })
    .safeParse({ role: "assistant", content: undefined });
  const r2 = (modelMessageSchema as { safeParse: (v: unknown) => { success: boolean } })
    .safeParse({ role: "assistant", content: null });
  assert(!r1.success && !r2.success, "undefined/null content should fail the schema");
});

// ---------------------------------------------------------------------------
// FIX: sanitizer output is always schema-valid and tool-paired.
// ---------------------------------------------------------------------------

Deno.test("normalizeToolOutput coerces every shape into a valid {type,value} union", () => {
  assertEquals(normalizeToolOutput("hi"), { type: "text", value: "hi" });
  assertEquals(normalizeToolOutput(undefined), { type: "text", value: "[result dropped to fit context]" });
  assertEquals(normalizeToolOutput(null), { type: "text", value: "[result dropped to fit context]" });
  assertEquals(normalizeToolOutput({ value: "x" }), { type: "json", value: { value: "x" } });
  // already-valid output passes through untouched
  const good = { type: "json", value: { a: 1 } };
  assertEquals(normalizeToolOutput(good), good);
});

Deno.test("FIX: repro array (bad output + content) becomes schema-valid after sanitize", () => {
  const bad: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: "[elided]" }] },
    { role: "assistant", content: undefined }, // invalid content
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(bad);
  assertSchemaValid(out, "sanitized repro");
  // the undefined-content message is dropped
  assertEquals(out.filter((m) => m.content == null).length, 0);
});

Deno.test("FIX: orphaned tool-call gets a synthesized placeholder result (pairing repaired)", () => {
  const orphaned: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "whois", input: {} }] },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(orphaned);
  assertSchemaValid(out, "paired");
  const toolMsg = out.find((m) => m.role === "tool");
  assert(toolMsg, "a synthesized tool message should follow the orphaned call");
  const part = (toolMsg!.content as Array<{ toolCallId?: string; output?: { value?: unknown } }>)[0];
  assertEquals(part.toolCallId, "c1");
  assertEquals(part.output?.value, "[result dropped to fit context]");
  // placeholder appears immediately AFTER the assistant message
  const ai = out.findIndex((m) => m.role === "assistant");
  assertEquals(out[ai + 1].role, "tool");
});

Deno.test("FIX: orphaned tool-RESULT (no matching call) is dropped", () => {
  const orphanResult: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "ghost", toolName: "x", output: { type: "json", value: 1 } }] },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(orphanResult);
  assertSchemaValid(out, "dropped orphan result");
  assert(!out.some((m) => m.role === "tool"), "orphaned tool-result message should be dropped");
});

Deno.test("FIX: empty text parts / empty content arrays are dropped, never emitted", () => {
  const empties: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "text", text: "" }] }, // becomes empty → dropped
    { role: "assistant", content: [] }, // empty → dropped
    { role: "assistant", content: "   " }, // whitespace string → dropped
    { role: "assistant", content: [{ type: "text", text: "real answer" }] },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(empties);
  assertSchemaValid(out, "no empties");
  // only user + the one real assistant message survive
  assertEquals(out.length, 2);
  assert(out.every((m) => !(Array.isArray(m.content) && m.content.length === 0)));
});

Deno.test("FIX: a single oversized tool result is truncated in history, staying schema-valid", () => {
  const huge = "x".repeat(60_000);
  const msgs: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: { type: "json", value: huge } }] },
  ] as unknown as ModelMessage[];
  const before = JSON.stringify(msgs).length;
  const out = capToolResultOutputs(msgs, 6000);
  const after = JSON.stringify(out).length;
  assertSchemaValid(out, "capped");
  assert(after < before, "capping should shrink the history");
  const part = (out[2].content as Array<{ output?: { value?: string } }>)[0];
  assert((part.output?.value as string).length < 7000, "oversized value should be truncated");
  assert((part.output?.value as string).includes("[truncated"), "truncation marker present");
});

Deno.test("FIX: capping a large object/array tool-result coerces to a valid text output", () => {
  const bigArr = Array.from({ length: 5000 }, (_, i) => ({ i, v: "data" }));
  const msgs: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: { type: "json", value: bigArr } }] },
  ] as unknown as ModelMessage[];
  const out = capToolResultOutputs(msgs, 6000);
  assertSchemaValid(out, "capped object");
  const part = (out[2].content as Array<{ output?: { type?: string; value?: unknown } }>)[0];
  assertEquals(part.output?.type, "json"); // json may hold a (truncated) string value
  assert(typeof part.output?.value === "string");
});

Deno.test("FIX: a well-formed paired conversation is left structurally intact", () => {
  const good: ModelMessage[] = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: { q: "x" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: { type: "json", value: { ok: true } } }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(good);
  assertSchemaValid(out, "good preserved");
  assertEquals(out.length, 4);
});

// ---------------------------------------------------------------------------
// THE OVERLAP WEDGE — a tool-call id repeated across two assistant messages.
//
// Two runs overlapping on one thread (12.2% of invocations) can persist the
// SAME toolCallId in two separate assistant messages. The AI SDK validates
// pairing POSITIONALLY: each assistant tool-call must be answered by the tool
// message(s) directly following it. Production thread bfa55610 (2026-09-12)
// died twice in 85 ms on one repeated id, before any provider call.
// ---------------------------------------------------------------------------

/**
 * Asserts pairing the way the SDK does — per POSITION. For every assistant
 * message, every tool-call it issues must be answered by a tool-result in the
 * run of `tool` messages immediately following it. An id answered only
 * somewhere else in the array does NOT satisfy this (that was the defect).
 */
function assertPairedPositionally(msgs: ModelMessage[], label: string) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < msgs.length; j++) {
      const n = msgs[j] as { role?: string; content?: unknown };
      if (n.role !== "tool" || !Array.isArray(n.content)) break;
      for (const p of n.content as Array<{ type?: string; toolCallId?: string }>) {
        if (p?.type === "tool-result" && typeof p.toolCallId === "string") answered.add(p.toolCallId);
      }
    }
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p?.type !== "tool-call" || typeof p.toolCallId !== "string") continue;
      assert(
        answered.has(p.toolCallId),
        `${label}: assistant message[${i}] tool-call ${p.toolCallId} is unpaired at its own position`,
      );
    }
  }
}

/** The shape an overlapping run persists: one id, two assistant messages, one real result (on the SECOND). */
function overlapWedgeInput(): ModelMessage[] {
  return [
    { role: "user", content: "seed" },
    // First run issues the call…
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dup_1", toolName: "username_sweep", input: { q: "a" } }] },
    // …the second, overlapping run re-issues the SAME id…
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dup_1", toolName: "username_sweep", input: { q: "a" } }] },
    // …and only the later one is answered.
    { role: "tool", content: [{ type: "tool-result", toolCallId: "dup_1", toolName: "username_sweep", output: { type: "json", value: { ok: true } } }] },
  ] as unknown as ModelMessage[];
}

Deno.test("REPRO: a tool-call id repeated across two assistant messages is unpaired at the FIRST position", () => {
  const wedged = overlapWedgeInput();
  // Every message is individually schema-valid — which is why this reached the
  // SDK's pairing check rather than being rejected as malformed.
  assertSchemaValid(wedged, "overlap wedge input");
  let threw = false;
  try {
    assertPairedPositionally(wedged, "raw");
  } catch {
    threw = true;
  }
  assert(threw, "the raw overlap shape should be positionally unpaired — that is the production failure");
});

Deno.test("FIX: the repeated tool-call id is paired at BOTH positions", () => {
  const out = sanitizeModelMessages(overlapWedgeInput());
  assertSchemaValid(out, "overlap wedge sanitized");
  assertPairedPositionally(out, "sanitized");
  // The real result is preserved, not replaced by a placeholder.
  const realResults = out.filter((m) =>
    (m as { role?: string }).role === "tool" &&
    ((m as { content?: unknown }).content as Array<{ output?: { value?: unknown } }>)
      .some((p) => p?.output?.value !== undefined && typeof p.output.value === "object")
  );
  assertEquals(realResults.length, 1, "the genuine tool-result must survive");
});

Deno.test("FIX: a duplicate id WITHIN one assistant message gets exactly one placeholder", () => {
  const msgs = [
    { role: "user", content: "seed" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "same", toolName: "foo", input: {} },
        { type: "tool-call", toolCallId: "same", toolName: "foo", input: {} },
      ],
    },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(msgs);
  assertSchemaValid(out, "intra-message duplicate");
  assertPairedPositionally(out, "intra-message duplicate");
  const toolMsgs = out.filter((m) => (m as { role?: string }).role === "tool");
  assertEquals(toolMsgs.length, 1, "one synthesized tool message");
  assertEquals((toolMsgs[0].content as unknown[]).length, 1, "one placeholder for the repeated id");
});

Deno.test("FIX: an already-answered call never gains a spurious placeholder", () => {
  const msgs = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "foo", output: { type: "json", value: { ok: true } } }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "bar", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "bar", output: { type: "json", value: { ok: true } } }] },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(msgs);
  assertPairedPositionally(out, "no spurious");
  assertEquals(out.length, 5, "nothing added to an already-paired conversation");
});
