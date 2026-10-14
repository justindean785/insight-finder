// tool_call_input_shape_wiring_test.ts — the input-shape repair is on the path every
// model call takes, and /health carries its proof key. Source-level on purpose.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
const SANITIZE = await Deno.readTextFile(new URL("./message-sanitize.ts", import.meta.url));

Deno.test("input shape: both sanitize call sites (initial prompt + every prepareStep) run the default, env-gated pass", () => {
  const sites = INDEX.match(/sanitizeModelMessages\(/g) ?? [];
  assert(sites.length >= 2, `expected the initial + prepareStep call sites, found ${sites.length}`);
  // No call site opts out: the kill switch is the only way to disable the pass.
  assert(!/sanitizeModelMessages\([^)]*inputShape:\s*false/s.test(INDEX), "no call site hard-codes inputShape:false");
});

Deno.test("input shape: the pass runs BEFORE id collection so a dropped call's result is an orphan", () => {
  const pass0 = SANITIZE.indexOf("Pass 0 — tool-call INPUT shape");
  const pass1 = SANITIZE.indexOf("Pass 1 — collect every toolCallId");
  assert(pass0 > 0 && pass1 > pass0, "pass 0 precedes pass 1");
  assertStringIncludes(SANITIZE, "!droppedCalls.has(p)) callIds.add(p.toolCallId)");
});

Deno.test("input shape: /health carries checks.tool_call_input_shape with the kill switch read at call time", () => {
  assertStringIncludes(HEALTH, "r.checks.tool_call_input_shape = toolCallInputShapeSelfTest(toolCallInputShapeDisabled())");
});

Deno.test("input shape: the repair log carries counts only, never the input text", () => {
  const i = SANITIZE.indexOf('event: "sanitize_tool_call_input_shape"');
  assert(i > 0);
  const line = SANITIZE.slice(i, i + 160);
  assert(!/input\b|rawInput|text:/.test(line.replace(/event: "sanitize_tool_call_input_shape"/, "")), "no input content in the log line");
});
