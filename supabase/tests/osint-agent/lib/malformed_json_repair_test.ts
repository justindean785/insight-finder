// lib/malformed_json_repair_test.ts — JSON text that never parsed is repaired ONLY for a code fence and trailing commas.
// Driven through the REAL AI SDK (the same experimental_repairToolCall chain index.ts wires). Synthetic values only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateText, stepCountIs, tool } from "npm:ai@6";
import { MockLanguageModelV3 } from "npm:ai@6/test";
import { z } from "npm:zod@3";
import { malformedJsonRepairSelfTest, repairMalformedJsonInput } from "../../../functions/osint-agent/lib/malformed-json-repair.ts";
import { repairExactBooleanInput } from "../../../functions/osint-agent/lib/exact-boolean-repair.ts";

const PARSE_ERR = { name: "AI_InvalidToolInputError", cause: { name: "AI_JSONParseError", cause: { name: "SyntaxError" } } };
const SWITCH = "MALFORMED_JSON_REPAIR_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally { if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev); }
}

Deno.test("trailing commas (object, array, nested, with whitespace) are removed", () => {
  const r = repairMalformedJsonInput('{"a":"x","b":[1,2,\n],"c":{"d":1 ,},}', PARSE_ERR);
  assert(r);
  assertEquals(JSON.parse(r.input), { a: "x", b: [1, 2], c: { d: 1 } });
  assertEquals(r.fixes, ["trailing_comma"]);
});

Deno.test("one enclosing code fence is removed, alone or with a trailing comma", () => {
  assertEquals(JSON.parse(repairMalformedJsonInput('```json\n{"a":"x"}\n```', PARSE_ERR)!.input), { a: "x" });
  assertEquals(JSON.parse(repairMalformedJsonInput('```\n{"a":"x",}\n```', PARSE_ERR)!.input), { a: "x" });
  assertEquals(repairMalformedJsonInput('```json\n{"a":"x",}\n```', PARSE_ERR)!.fixes, ["code_fence", "trailing_comma"]);
});

Deno.test("commas and braces INSIDE a string value are never touched", () => {
  const r = repairMalformedJsonInput('{"a":"x,}","b":"y,]","c":"q\\",}",}', PARSE_ERR);
  assert(r);
  assertEquals(JSON.parse(r.input), { a: "x,}", b: "y,]", c: 'q",}' });
});

Deno.test("a TRUNCATED call is never closed", () => {
  for (const t of ['{"a":"x', '{"a":"x",', '{"a":["x",', '{"a":"x","b":{"c":"y",}', '{"email":"person@exam']) {
    assertEquals(repairMalformedJsonInput(t, PARSE_ERR), null, t);
  }
});

Deno.test("single quotes, unquoted keys, comments, surrounding prose, several objects are not repaired", () => {
  for (const t of ["{'a':'x',}", '{a:"x",}', '{"a":"x",} // note', 'Here you go: {"a":"x",}', '{"a":"x",}{"b":"y",}', '{"a":"x",} extra']) {
    assertEquals(repairMalformedJsonInput(t, PARSE_ERR), null, t);
  }
});

Deno.test("a non-object result, an unrelated error, a non-string or oversized input → null; never throws", () => {
  assertEquals(repairMalformedJsonInput("[1,2,]", PARSE_ERR), null);
  assertEquals(repairMalformedJsonInput('"x",', PARSE_ERR), null);
  assertEquals(repairMalformedJsonInput('{"a":"x",}', { name: "AI_InvalidToolInputError", cause: { name: "ZodError", issues: [] } }), null);
  assertEquals(repairMalformedJsonInput('{"a":"x",}', undefined), null);
  for (const v of [undefined, null, 5, {}, [], ""]) assertEquals(repairMalformedJsonInput(v, PARSE_ERR), null);
  assertEquals(repairMalformedJsonInput('{"a":"' + "x".repeat(200_001) + '",}', PARSE_ERR), null);
});

Deno.test("only fix CODES are returned — never a value", () => {
  const r = repairMalformedJsonInput('{"q":"SECRET-VALUE",}', PARSE_ERR);
  assert(r);
  assertFalse(JSON.stringify(r.fixes).includes("SECRET"));
});

Deno.test("KILL SWITCH: MALFORMED_JSON_REPAIR_DISABLED=true restores invalid_json (read at call time); /health reports LEGACY", async () => {
  await withEnv(SWITCH, "true", () => {
    assertEquals(repairMalformedJsonInput('{"a":"x",}', PARSE_ERR), null);
    assert(malformedJsonRepairSelfTest().detail.startsWith("LEGACY"));
  });
  assert(repairMalformedJsonInput('{"a":"x",}', PARSE_ERR), "and back on");
});

// ── REAL SDK ───────────────────────────────────────────────────────────────────

const USAGE = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
function modelCalling(rawInput: string) {
  let n = 0;
  return new MockLanguageModelV3({
    doGenerate: () => {
      n++;
      return Promise.resolve((n === 1
        ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "spy", input: rawInput }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] }) as never);
    },
  });
}
async function drive(rawInput: string, repair: boolean) {
  const received: unknown[] = [];
  const t = tool({ description: "spy", inputSchema: z.object({ handle: z.string(), n: z.number().optional() }), execute: (i: unknown) => { received.push(i); return Promise.resolve({ ok: true }); } });
  const steps: Array<{ toolCalls: Array<{ invalid?: boolean }> }> = [];
  await generateText({
    model: modelCalling(rawInput),
    tools: { spy: t } as never,
    stopWhen: stepCountIs(3),
    prompt: "go",
    ...(repair
      ? {
        // the SAME chain index.ts wires: exact-boolean first, then malformed JSON
        experimental_repairToolCall: ({ toolCall, error }: { toolCall: { input: string }; error: unknown }) => {
          const b = repairExactBooleanInput(toolCall.input, error);
          if (b) return Promise.resolve({ ...toolCall, input: b.input });
          const j = repairMalformedJsonInput(toolCall.input, error);
          return Promise.resolve(j ? { ...toolCall, input: j.input } : null);
        },
      }
      : {}),
    onStepFinish: (s) => { steps.push(s as never); },
  } as never);
  return { received, invalid: steps[0]?.toolCalls?.some((c) => c.invalid === true) ?? false };
}

Deno.test("REAL SDK: a trailing-comma / fenced call reaches execute; the same call WITHOUT the repair is rejected (the defect)", async () => {
  for (const raw of ['{"handle":"example_user",}', '```json\n{"handle":"example_user"}\n```']) {
    const fixed = await drive(raw, true);
    assertFalse(fixed.invalid, raw);
    assertEquals(fixed.received, [{ handle: "example_user" }]);
    const control = await drive(raw, false);
    assert(control.invalid, raw);
    assertEquals(control.received.length, 0);
  }
});

Deno.test("REAL SDK: a truncated call stays rejected and nothing executes; a repaired call that fails the schema is still rejected", async () => {
  const t = await drive('{"handle":"example_us', true);
  assert(t.invalid);
  assertEquals(t.received.length, 0);
  const s = await drive('{"handle":5,}', true);
  assert(s.invalid, "repair fixes syntax only; the schema still decides");
  assertEquals(s.received.length, 0);
});

Deno.test("/health + WIRING: the proof key exists, the self-test passes, index.ts chains it after the exact-boolean repair", async () => {
  const st = malformedJsonRepairSelfTest();
  assertEquals(st.ok, true, st.detail);
  assertEquals(st.switch, "MALFORMED_JSON_REPAIR_DISABLED=false");
  const health = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.malformed_json_repair = malformedJsonRepairSelfTest();"));
  const src = await Deno.readTextFile(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
  const at = src.indexOf("experimental_repairToolCall:");
  const bool = src.indexOf("repairExactBooleanInput(toolCall.input, error)", at);
  const json = src.indexOf("repairMalformedJsonInput(toolCall.input, error)", at);
  assert(at > 0 && bool > at && json > bool, "malformed-JSON repair runs after the exact-boolean repair, inside the known-tool branch");
});
