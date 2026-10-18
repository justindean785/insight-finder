// prompt_size_test.ts — the instrument that measures the instrument.
//
// These tests exist because the number this module replaces was wrong in a
// specific, load-bearing way: `approxPromptChars` omits the workflow addendum,
// the analyst-decisions block, the per-step directive and every tool schema, and
// that number is what production telemetry reports as `initial_context_chars`.
// A context target set against it is measured with a ruler missing several of its
// marks. So these assert the OMITTED terms are actually counted, not that the
// function adds numbers.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  measurePromptTerms,
  measureToolDescriptions,
  promptSizeEvent,
  UNMEASURED_TERMS,
} from "../../functions/osint-agent/prompt-size.ts";

Deno.test("counts the four terms approxPromptChars silently drops", () => {
  // Only the two terms the OLD formula knew about.
  const oldFormulaOnly = measurePromptTerms({
    systemStatic: 42_700,
    findingLabels: 1_150,
    messages: 130_000,
  });
  // The same step, with the terms that were always there but never counted.
  const honest = measurePromptTerms({
    systemStatic: 42_700,
    findingLabels: 1_150,
    workflowAddendum: 4_600,
    visionIntake: 0,
    analystDecisions: 30_000,
    stepDirective: 760,
    messages: 130_000,
    toolCount: 98,
    toolDescriptions: 45_250,
  });
  assertEquals(oldFormulaOnly.total_measured, 173_850);
  assertEquals(honest.total_measured, 254_460);
  // The whole point: the omission is worth ~80k chars on a realistic step, so the
  // old figure understates by nearly a third and no gate set against it is real.
  assert(
    honest.total_measured - oldFormulaOnly.total_measured > 80_000,
    "the dropped terms must be material, or this module is not worth its weight",
  );
});

Deno.test("toolCount is a count and is never summed into the char total", () => {
  const withoutCount = measurePromptTerms({ systemStatic: 100, messages: 50 });
  const withCount = measurePromptTerms({ systemStatic: 100, messages: 50, toolCount: 98 });
  assertEquals(withCount.total_measured, withoutCount.total_measured);
  assertEquals(withCount.terms.toolCount, 98);
});

Deno.test("system_total excludes messages so prompt growth is attributable", () => {
  const r = measurePromptTerms({
    systemStatic: 1_000,
    findingLabels: 100,
    workflowAddendum: 200,
    analystDecisions: 300,
    stepDirective: 50,
    toolDescriptions: 400,
    messages: 99_999,
  });
  assertEquals(r.system_total, 2_050);
  assertEquals(r.total_measured, 102_049);
});

Deno.test("a missing or malformed term degrades to 0, never NaN", () => {
  // A NaN total would silently destroy the instrument this module exists to fix,
  // which is precisely the failure mode being corrected.
  const r = measurePromptTerms({
    systemStatic: Number.NaN,
    findingLabels: undefined,
    workflowAddendum: -5,
    messages: Infinity,
  });
  assert(Number.isFinite(r.total_measured));
  assertEquals(r.total_measured, 0);
});

Deno.test("unmeasured terms are named, so the total is never read as the whole prompt", () => {
  const r = measurePromptTerms({ systemStatic: 10 });
  assert(r.unmeasured.includes("tool_input_schemas_serialized"));
  assertEquals(r.unmeasured.length, UNMEASURED_TERMS.length);
  // Mutating the returned array must not poison the module-level constant.
  r.unmeasured.push("bogus");
  assertEquals(measurePromptTerms({}).unmeasured.length, UNMEASURED_TERMS.length);
});

Deno.test("tool descriptions are counted exactly and tolerate any registry shape", () => {
  const measured = measureToolDescriptions({
    a: { description: "abcde" },
    b: { description: "xy" },
    c: { description: 42 },       // non-string contributes 0, does not throw
    d: {},                         // absent description
    e: null,
  } as unknown as Record<string, unknown>);
  assertEquals(measured.toolCount, 5);
  assertEquals(measured.toolDescriptions, 7);
});

Deno.test("measureToolDescriptions survives a null registry", () => {
  assertEquals(measureToolDescriptions(null), { toolCount: 0, toolDescriptions: 0 });
  assertEquals(measureToolDescriptions(undefined), { toolCount: 0, toolDescriptions: 0 });
});

Deno.test("the log line carries the breakdown and the caveat together", () => {
  const r = measurePromptTerms({
    systemStatic: 10,
    analystDecisions: 20,
    messages: 30,
    toolCount: 2,
    toolDescriptions: 5,
  });
  const parsed = JSON.parse(promptSizeEvent("prompt_size_step", "thread-1", r, { step_number: 4 }));
  assertEquals(parsed.event, "prompt_size_step");
  assertEquals(parsed.thread_id, "thread-1");
  assertEquals(parsed.total_measured_chars, 65);
  assertEquals(parsed.message_chars, 30);
  assertEquals(parsed.system_chars, 35);
  assertEquals(parsed.analystDecisions, 20);
  assertEquals(parsed.step_number, 4);
  // The caveat must ride with the number, not live in a comment somewhere else.
  assert(Array.isArray(parsed.unmeasured) && parsed.unmeasured.length > 0);
});
