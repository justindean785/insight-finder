// tool_call_input_shape_test.ts — a tool call whose arguments were not valid JSON
// must never reach the provider as a STRING tool_use.input (message-sanitize.ts,
// "Tool-call INPUT shape"). Synthetic values only.
//
// The shape under test is what ai@6.0.304 convertToModelMessages emits for a UI
// tool part in state `output-error` with no parsed input: a `tool-call` whose
// `input` is `rawInput`, the unparsed text (dist/index.mjs:9770). Anthropic 400s
// on it ("messages.N.content.M.tool_use.input: Input should be an object");
// measured 2026-10-14 as 11 consecutive dead continuations on one thread.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { modelMessageSchema, type ModelMessage } from "npm:ai@6";
import {
  TOOL_CALL_INPUT_SHAPE_DISABLED_ENV,
  normalizeToolCallInput,
  sanitizeModelMessages,
  toolCallInputShapeDisabled,
  toolCallInputShapeSelfTest,
} from "./message-sanitize.ts";
import { classifyAnthropicError } from "./anthropic-orchestrator.ts";

type Part = { type: string; toolCallId?: string; input?: unknown; text?: string; [k: string]: unknown };
const parts = (msgs: ModelMessage[], type: string): Part[] =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]).filter((p) => p.type === type) : []));
const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);

function assertSchemaValid(msgs: ModelMessage[]) {
  for (const [i, m] of msgs.entries()) {
    const r = (modelMessageSchema as { safeParse: (v: unknown) => { success: boolean; error?: unknown } }).safeParse(m);
    assert(r.success, `message[${i}] failed ModelMessage schema: ${JSON.stringify(r.error)}`);
  }
}

/** The production shape: a good call, a JSON-string call, an unparseable call, each answered. */
function fixture(): ModelMessage[] {
  return [
    { role: "user", content: "seed" },
    { role: "assistant", content: [
      { type: "tool-call", toolCallId: "ok", toolName: "a", input: { kind: "x", value: "1" } },
      { type: "tool-call", toolCallId: "str", toolName: "record_artifacts", input: '{"artifacts":[{"kind":"email","value":"a@example.com"}]}' },
      { type: "tool-call", toolCallId: "bad", toolName: "record_artifacts", input: '{"artifacts":[{"kind":"email","value":"a@example' },
    ] },
    { role: "tool", content: [
      { type: "tool-result", toolCallId: "ok", toolName: "a", output: { type: "text", value: "r" } },
      { type: "tool-result", toolCallId: "str", toolName: "record_artifacts", output: { type: "text", value: "r" } },
      { type: "tool-result", toolCallId: "bad", toolName: "record_artifacts", output: { type: "text", value: "input was not valid JSON for record_artifacts: the tool-call text did not parse" } },
    ] },
    { role: "user", content: "continue" },
  ] as unknown as ModelMessage[];
}

Deno.test("REPRO: the SDK's ModelMessage schema ACCEPTS a string tool-call input, so nothing client-side catches it", () => {
  const msgs = fixture();
  assertSchemaValid(msgs); // passes — which is exactly why the 400 reached production
  assert(parts(msgs, "tool-call").some((p) => typeof p.input === "string"));
});

Deno.test("normalizeToolCallInput: object kept, JSON-object string repaired, everything else dropped", () => {
  assertEquals(normalizeToolCallInput({ a: 1 }), { action: "keep", input: { a: 1 } });
  assertEquals(normalizeToolCallInput('{"a":1}'), { action: "repair", input: { a: 1 } });
  assertEquals(normalizeToolCallInput('  {"a":1}  '), { action: "repair", input: { a: 1 } });
  for (const bad of ['{"a":', "[1,2]", '"text"', "42", "", "   ", null, undefined, 7, [1], true]) {
    assertEquals(normalizeToolCallInput(bad), { action: "drop" }, JSON.stringify(bad));
  }
  // A JSON string that is not an object (array / scalar) is NOT an input either.
  assertEquals(normalizeToolCallInput("[1]"), { action: "drop" });
});

Deno.test("FIX: after sanitize no tool-call carries a non-object input; the JSON string is repaired in place", () => {
  const out = sanitizeModelMessages(fixture(), { inputShape: true });
  assertSchemaValid(out);
  const calls = parts(out, "tool-call");
  assert(calls.every((c) => isObj(c.input)), "every surviving tool-call input is an object");
  const str = calls.find((c) => c.toolCallId === "str");
  assert(str, "the JSON-string call survives");
  assertEquals((str.input as { artifacts: unknown[] }).artifacts.length, 1);
  // Its result stays paired.
  assert(parts(out, "tool-result").some((r) => r.toolCallId === "str"));
});

Deno.test("FIX: the unparseable call is dropped together with its result, never faked as {}", () => {
  const out = sanitizeModelMessages(fixture(), { inputShape: true });
  assert(!parts(out, "tool-call").some((c) => c.toolCallId === "bad"), "call gone");
  assert(!parts(out, "tool-result").some((r) => r.toolCallId === "bad"), "its result gone (orphan rule)");
  assert(!parts(out, "tool-call").some((c) => c.toolCallId === "bad" && JSON.stringify(c.input) === "{}"), "never {}");
  // A note stands in for it so the transcript still records that a call happened.
  assert(parts(out, "text").some((t) => /not valid JSON was dropped/.test(String(t.text))), "note present");
  // Pairing is still whole: every surviving call is answered, no placeholder was needed for a dropped id.
  const callIds = new Set(parts(out, "tool-call").map((c) => c.toolCallId));
  const resultIds = new Set(parts(out, "tool-result").map((r) => r.toolCallId));
  assertEquals([...callIds].sort(), [...resultIds].sort());
});

Deno.test("FIX: an assistant message whose ONLY part was an unparseable call is not emitted empty", () => {
  const msgs = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "bad", toolName: "x", input: "{nope" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "bad", toolName: "x", output: { type: "text", value: "failed" } }] },
    { role: "user", content: "continue" },
  ] as unknown as ModelMessage[];
  const out = sanitizeModelMessages(msgs, { inputShape: true });
  assertSchemaValid(out);
  assert(out.every((m) => !Array.isArray(m.content) || m.content.length > 0), "no empty content");
  assertEquals(parts(out, "tool-call").length, 0);
  assertEquals(parts(out, "tool-result").length, 0);
});

Deno.test("FIX: a well-formed conversation is byte-for-byte unchanged by the input-shape pass", () => {
  const msgs = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "a", input: { q: "x" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "a", output: { type: "text", value: "r" } }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ] as unknown as ModelMessage[];
  assertEquals(sanitizeModelMessages(msgs, { inputShape: true }), sanitizeModelMessages(msgs, { inputShape: false }));
});

Deno.test("kill switch: TOOL_CALL_INPUT_SHAPE_DISABLED=true restores the pass-through (string input survives)", () => {
  const out = sanitizeModelMessages(fixture(), { inputShape: false });
  assert(parts(out, "tool-call").some((c) => typeof c.input === "string"), "legacy: string input sent as-is");
  assertEquals(toolCallInputShapeDisabled((k) => (k === TOOL_CALL_INPUT_SHAPE_DISABLED_ENV ? " TRUE " : undefined)), true);
  assertEquals(toolCallInputShapeDisabled(() => "false"), false);
  assertEquals(toolCallInputShapeDisabled(() => undefined), false);
});

Deno.test("/health self-test: ok on this build, LEGACY when disabled, and it would catch a drift", () => {
  const r = toolCallInputShapeSelfTest();
  assertEquals(r.ok, true);
  assertStringIncludes(r.detail, "no string input reaches the provider");
  assertStringIncludes(toolCallInputShapeSelfTest(true).detail, "LEGACY");
});

Deno.test("classifier: the history 400 is its own terminal class, not an operator configuration fault", () => {
  const f = classifyAnthropicError({ statusCode: 400, message: "messages.51.content.1.tool_use.input: Input should be an object [HTTP 400 invalid_request_error body=177B]" });
  assertEquals(f.kind, "history_invalid");
  assertEquals(f.retryable, false);
  assertEquals(f.operatorActionRequired, false);
  assert(!/ANTHROPIC_MODEL_ID/.test(f.message), "does not send the operator to the model id");
  // Other 400s keep their class.
  assertEquals(classifyAnthropicError({ statusCode: 400, message: "something else invalid_request_error" }).kind, "invalid_request");
  assertEquals(classifyAnthropicError({ statusCode: 400, message: "Your credit balance is too low" }).kind, "credit_exhausted");
});
