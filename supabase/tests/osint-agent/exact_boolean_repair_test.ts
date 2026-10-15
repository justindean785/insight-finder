// exact_boolean_repair_test.ts — a boolean parameter sent as the EXACT string "true"/"false" is repaired; nothing else is.
//
// The model sometimes sends a boolean as a string (serus_darkweb_scan `reveal`, skip_cache, …). The AI SDK rejects the
// call before `execute`, the step is burnt and the analyst sees a failed tool. The repair runs in
// experimental_repairToolCall, only for a call that already failed, only for `invalid_type` expected boolean / received
// string, and only when the value is exactly "true" or "false". These tests drive the REAL AI SDK against the REAL tool
// input schemas (serus_darkweb_scan, oathnet_victim_archive); synthetic values only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateText, stepCountIs, tool } from "npm:ai@6";
import { MockLanguageModelV3 } from "npm:ai@6/test";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";
import { serus_darkweb_scan } from "../../functions/osint-agent/tools/serus.ts";
import { exactBooleanRepairSelfTest, repairExactBooleanInput } from "../../functions/osint-agent/lib/exact-boolean-repair.ts";

const SWITCH = "EXACT_BOOLEAN_REPAIR_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

const boolIssue = (path: Array<string | number>, over: Record<string, unknown> = {}) => ({
  code: "invalid_type", expected: "boolean", received: "string", path, ...over,
});
const errWith = (...issues: Array<Record<string, unknown>>) => ({
  name: "AI_InvalidToolInputError",
  cause: { name: "AI_TypeValidationError", cause: { name: "ZodError", issues } },
});

// ── pure behaviour ─────────────────────────────────────────────────────────────

Deno.test("repairs the exact strings \"true\" and \"false\" — and only those fields", () => {
  const r = repairExactBooleanInput('{"identifierValue":"x","reveal":"false","skip_cache":"true"}', errWith(boolIssue(["reveal"]), boolIssue(["skip_cache"])));
  assert(r);
  assertEquals(JSON.parse(r.input), { identifierValue: "x", reveal: false, skip_cache: true });
  assertEquals(r.fields, ["reveal", "skip_cache"]);
});

Deno.test("repairs nested and array-indexed paths", () => {
  const r = repairExactBooleanInput('{"opts":{"deep":"true"},"flags":["false",true]}', errWith(boolIssue(["opts", "deep"]), boolIssue(["flags", 0])));
  assert(r);
  assertEquals(JSON.parse(r.input), { opts: { deep: true }, flags: [false, true] });
  assertEquals(r.fields, ["opts.deep", "flags.0"]);
});

Deno.test("NOTHING else is coerced: case variants, whitespace, words, digits, empty string", () => {
  for (const v of ["True", "TRUE", "False", " true", "true ", "yes", "no", "on", "off", "1", "0", "", "t", "y", "null"]) {
    assertEquals(repairExactBooleanInput(JSON.stringify({ reveal: v }), errWith(boolIssue(["reveal"]))), null, JSON.stringify(v));
  }
});

Deno.test("a consent flag (path ending in `confirm`) is never repaired — it must be a real boolean", () => {
  assertEquals(repairExactBooleanInput('{"confirm":"true"}', errWith(boolIssue(["confirm"]))), null);
  assertEquals(repairExactBooleanInput('{"x":{"confirm":"true"}}', errWith(boolIssue(["x", "confirm"]))), null);
  // mixed: the other field is repaired, the consent flag is left exactly as sent
  const r = repairExactBooleanInput('{"reveal":"true","confirm":"true"}', errWith(boolIssue(["reveal"]), boolIssue(["confirm"])));
  assert(r);
  assertEquals(JSON.parse(r.input), { reveal: true, confirm: "true" });
  assertEquals(r.fields, ["reveal"]);
});

Deno.test("only `invalid_type` expected boolean / received string is a candidate — other issues are left to be reported", () => {
  const cases: Array<Record<string, unknown>> = [
    boolIssue(["a"], { expected: "number" }),
    boolIssue(["a"], { received: "number" }),
    boolIssue(["a"], { code: "invalid_enum_value" }),
    { code: "too_small", path: ["a"], minimum: 1, type: "string" },
    { code: "unrecognized_keys", keys: ["a"], path: [] },
  ];
  for (const issue of cases) assertEquals(repairExactBooleanInput('{"a":"true"}', errWith(issue)), null, JSON.stringify(issue));
});

Deno.test("other invalid fields are NOT touched: only the exact boolean is repaired", () => {
  const r = repairExactBooleanInput('{"handle":5,"count":"7","reveal":"true"}', errWith(boolIssue(["handle"], { expected: "string", received: "number" }), boolIssue(["count"], { expected: "number" }), boolIssue(["reveal"])));
  assert(r);
  assertEquals(JSON.parse(r.input), { handle: 5, count: "7", reveal: true });
});

Deno.test("never throws and never repairs a non-object, unparsable or non-string input", () => {
  const e = errWith(boolIssue(["reveal"]));
  for (const input of ["{not json", "[\"true\"]", "\"true\"", "42", "null", "", undefined, null, 5, {}, []]) {
    assertEquals(repairExactBooleanInput(input, e), null, String(input));
  }
  assertEquals(repairExactBooleanInput('{"reveal":"true"}', undefined), null);
  assertEquals(repairExactBooleanInput('{"reveal":"true"}', { name: "AI_InvalidToolInputError" }), null);
});

Deno.test("a prototype-pollution path is never followed", () => {
  const before = Object.keys(Object.prototype).length;
  assertEquals(repairExactBooleanInput('{"__proto__":{"x":"true"}}', errWith(boolIssue(["__proto__", "x"]))), null);
  assertEquals(repairExactBooleanInput('{"constructor":{"x":"true"}}', errWith(boolIssue(["constructor", "x"]))), null);
  assertEquals(({} as Record<string, unknown>).x, undefined);
  assertEquals(Object.keys(Object.prototype).length, before);
});

Deno.test("the fields it reports are PATHS only — never a value", () => {
  const r = repairExactBooleanInput('{"reveal":"true","q":"SECRET-VALUE"}', errWith(boolIssue(["reveal"])));
  assert(r);
  assertFalse(JSON.stringify(r.fields).includes("SECRET"));
});

Deno.test("KILL SWITCH: EXACT_BOOLEAN_REPAIR_DISABLED=true restores the old behaviour (read at call time), /health reports LEGACY", async () => {
  const e = errWith(boolIssue(["reveal"]));
  await withEnv(SWITCH, "true", () => {
    assertEquals(repairExactBooleanInput('{"reveal":"true"}', e), null);
    assertEquals(exactBooleanRepairSelfTest().detail, "LEGACY via EXACT_BOOLEAN_REPAIR_DISABLED");
  });
  await withEnv(SWITCH, "false", () => assert(repairExactBooleanInput('{"reveal":"true"}', e)));
  assert(repairExactBooleanInput('{"reveal":"true"}', e), "and back on");
});

// ── through the REAL SDK, against the REAL schemas ─────────────────────────────

const USAGE = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
function modelCalling(toolName: string, input: unknown) {
  let n = 0;
  return new MockLanguageModelV3({
    doGenerate: () => {
      n++;
      return Promise.resolve((n === 1
        ? { content: [{ type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] }
        : { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] }) as never);
    },
  });
}

/** Runs one call through generateText with the SAME repair logic index.ts wires. Returns what `execute` received. */
async function drive(toolName: string, schema: unknown, input: unknown) {
  const received: unknown[] = [];
  const t = tool({ description: "spy", inputSchema: schema as never, execute: (i: unknown) => { received.push(i); return Promise.resolve({ ok: true }); } });
  const steps: Array<{ toolCalls: Array<{ invalid?: boolean }> }> = [];
  await generateText({
    model: modelCalling(toolName, input),
    tools: { [toolName]: t } as never,
    stopWhen: stepCountIs(3),
    prompt: "go",
    experimental_repairToolCall: ({ toolCall, error }: { toolCall: { input: string }; error: unknown }) => {
      const fixed = repairExactBooleanInput(toolCall.input, error);
      return Promise.resolve(fixed ? { ...toolCall, input: fixed.input } : null);
    },
    onStepFinish: (s) => { steps.push(s as never); },
  } as never);
  return { received, invalid: steps[0]?.toolCalls?.some((c) => c.invalid === true) ?? false };
}

Deno.test("REAL SDK + REAL serus_darkweb_scan schema: reveal:\"false\" / \"true\" reach execute as booleans", async () => {
  for (const [sent, want] of [["false", false], ["true", true]] as const) {
    const { received, invalid } = await drive("serus_darkweb_scan", serus_darkweb_scan.inputSchema, { identifierType: "email", identifierValue: "qa@example.invalid", reveal: sent });
    assertFalse(invalid, `reveal:${JSON.stringify(sent)} must not be rejected`);
    assertEquals(received.length, 1);
    assertEquals((received[0] as { reveal: unknown }).reveal, want);
  }
});

Deno.test("REAL SDK + REAL serus schema: a non-exact string is still rejected before execute (control)", async () => {
  for (const sent of ["False", "TRUE", "yes", "1"]) {
    const { received, invalid } = await drive("serus_darkweb_scan", serus_darkweb_scan.inputSchema, { identifierType: "email", identifierValue: "qa@example.invalid", reveal: sent });
    assert(invalid, `reveal:${JSON.stringify(sent)} must stay rejected`);
    assertEquals(received.length, 0);
  }
});

Deno.test("REAL SDK + REAL oathnet_victim_archive schema: confirm:\"true\" stays REJECTED (manual-consent flag)", async () => {
  const ctx = { supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "ebr", archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null } as unknown as ToolContext;
  const real = buildTools(ctx).tools as Record<string, { inputSchema: unknown }>;
  const a = await drive("oathnet_victim_archive", real.oathnet_victim_archive.inputSchema, { log_id: "L1", confirm: "true" });
  assert(a.invalid, "a string must never satisfy a consent flag");
  assertEquals(a.received.length, 0);
  const b = await drive("oathnet_victim_archive", real.oathnet_victim_archive.inputSchema, { log_id: "L1", confirm: true });
  assertFalse(b.invalid, "a real boolean still passes");
  assertEquals(b.received.length, 1);
});

Deno.test("WITHOUT the repair the same call is rejected — the defect this fixes", async () => {
  const received: unknown[] = [];
  const t = tool({ description: "spy", inputSchema: serus_darkweb_scan.inputSchema as never, execute: (i: unknown) => { received.push(i); return Promise.resolve({ ok: true }); } });
  const steps: Array<{ toolCalls: Array<{ invalid?: boolean }> }> = [];
  await generateText({
    model: modelCalling("serus_darkweb_scan", { identifierType: "email", identifierValue: "qa@example.invalid", reveal: "true" }),
    tools: { serus_darkweb_scan: t } as never, stopWhen: stepCountIs(3), prompt: "go",
    onStepFinish: (s) => { steps.push(s as never); },
  } as never);
  assert(steps[0].toolCalls.some((c) => c.invalid === true));
  assertEquals(received.length, 0);
});

// ── /health, wiring, scope ─────────────────────────────────────────────────────

Deno.test("/health: checks.exact_boolean_repair is wired and the self-test passes", async () => {
  const st = exactBooleanRepairSelfTest();
  assertEquals(st.ok, true, st.detail);
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.exact_boolean_repair = exactBooleanRepairSelfTest();"));
});

Deno.test("WIRING (source assertion): index.ts repairs a KNOWN tool's call, passes `error`, and leaves the unknown-tool/alias paths intact", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  const at = src.indexOf("experimental_repairToolCall:");
  assert(at > 0);
  const body = src.slice(at, at + 2200);
  assert(body.includes("async ({ toolCall, tools: liveTools, error })"));
  assert(body.includes("repairExactBooleanInput(toolCall.input, error)"));
  assert(body.includes("repairUnknownTool(toolCall.toolName"), "the unknown-tool guard is still first");
});

Deno.test("SCOPE: the breach-reveal policy and the Serus tool are untouched by the repair", async () => {
  const serus = await Deno.readTextFile(new URL("../../functions/osint-agent/tools/serus.ts", import.meta.url));
  assert(serus.includes("const effectiveReveal = reveal || REVEAL_BREACH_DATA;"), "effective reveal policy unchanged");
  const repair = await Deno.readTextFile(new URL("../../functions/osint-agent/lib/exact-boolean-repair.ts", import.meta.url));
  assertFalse(/REVEAL_BREACH_DATA\s*[=!]/.test(repair.replace(/\/\/.*$/gm, "")), "the repair module never reads or sets the reveal policy");
});
