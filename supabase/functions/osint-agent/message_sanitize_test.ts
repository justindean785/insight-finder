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
