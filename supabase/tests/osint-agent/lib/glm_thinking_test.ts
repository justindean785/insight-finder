import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  describeThinking,
  modelForcesThinking,
  parseReasoningEffort,
  resolveDeepseekThinking,
} from "../../../functions/osint-agent/lib/glm-thinking.ts";

// --- which model ids force thinking -----------------------------------------
Deno.test("the GLM-5.3 family forces thinking", () => {
  for (const m of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.3-flashx-legal", "GLM-5.3-Flash"]) {
    assert(modelForcesThinking(m), `${m} should force thinking`);
  }
});

Deno.test("pre-5.3 models and non-GLM models do not force thinking", () => {
  for (const m of ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "deepseek-v4-pro", "", "   "]) {
    assertFalse(modelForcesThinking(m), `${m} should not force thinking`);
  }
  assertFalse(modelForcesThinking(null));
  assertFalse(modelForcesThinking(undefined));
});

Deno.test("a longer numeric tail does not inherit the 5.3 rule", () => {
  // Guards the anchored regex: a future glm-5.31 must not be silently assumed to
  // force thinking. The operator override exists for exactly that case.
  assertFalse(modelForcesThinking("glm-5.31"));
});

// --- the resolution matrix ----------------------------------------------------
Deno.test("a 5.3 model gets thinking enabled with a low default effort", () => {
  const r = resolveDeepseekThinking({ modelId: "glm-5.3-flash" });
  assertEquals(r.options.thinking.type, "enabled");
  assertEquals(r.options.reasoning_effort, "low");
  assertEquals(r.source, "model-forced");
  assert(r.forcedByModel);
});

Deno.test("glm-5.2 keeps today's shape: thinking disabled, no reasoning_effort", () => {
  const r = resolveDeepseekThinking({ modelId: "glm-5.2" });
  assertEquals(r.options.thinking.type, "disabled");
  // Sending reasoning_effort alongside a disabled thinking block is meaningless and
  // risks a 400 on a vendor that validates the pair.
  assertEquals(r.options.reasoning_effort, undefined);
  assertEquals(r.source, "default");
});

Deno.test("the override pins the mode in BOTH directions", () => {
  const forcedOff = resolveDeepseekThinking({ modelId: "glm-5.3", modeOverride: "disabled" });
  assertEquals(forcedOff.options.thinking.type, "disabled");
  assertEquals(forcedOff.source, "override");
  // forcedByModel still reports the truth, so /health can flag the invalid pairing.
  assert(forcedOff.forcedByModel);

  const forcedOn = resolveDeepseekThinking({ modelId: "some-future-model", modeOverride: "enabled" });
  assertEquals(forcedOn.options.thinking.type, "enabled");
  assertEquals(forcedOn.options.reasoning_effort, "low");
  assertEquals(forcedOn.source, "override");
  assertFalse(forcedOn.forcedByModel);
});

Deno.test("a blank or unrecognised override falls through to the model id", () => {
  for (const o of ["", "   ", "auto", "AUTO", "nonsense"]) {
    assertEquals(resolveDeepseekThinking({ modelId: "glm-5.3", modeOverride: o }).source, "model-forced");
    assertEquals(resolveDeepseekThinking({ modelId: "glm-5.2", modeOverride: o }).source, "default");
  }
});

Deno.test("reasoning effort parses the three documented values and defaults to low", () => {
  assertEquals(parseReasoningEffort("high"), "high");
  assertEquals(parseReasoningEffort("MAX"), "max");
  assertEquals(parseReasoningEffort(" low "), "low");
  // Anything else must not reach the vendor verbatim.
  for (const bad of ["", "medium", "ultra", null, undefined]) {
    assertEquals(parseReasoningEffort(bad as string | null), "low");
  }
});

Deno.test("the override can raise effort when an operator accepts the wall-clock cost", () => {
  const r = resolveDeepseekThinking({ modelId: "glm-5.3-flashx", effort: "high" });
  assertEquals(r.options.reasoning_effort, "high");
});

// --- the thing that must never be sent ---------------------------------------
Deno.test("clear_thinking is never emitted, so reasoning_content is never round-tripped", () => {
  // The STANDARD api.z.ai endpoint defaults Preserved Thinking OFF. Emitting
  // clear_thinking:false would oblige the client to echo reasoning_content back
  // through multi-round STREAMED tool calls — unproven in @ai-sdk/openai-compatible
  // and the original reason thinking was disabled at all.
  for (const m of ["glm-5.3", "glm-5.3-flash", "glm-5.2"]) {
    const keys = Object.keys(resolveDeepseekThinking({ modelId: m }).options);
    assertFalse(keys.includes("clear_thinking"), `${m} must not emit clear_thinking`);
  }
});

Deno.test("describeThinking names the mode without leaking a key", () => {
  const r = resolveDeepseekThinking({ modelId: "glm-5.3-flash" });
  assertEquals(describeThinking(r, "glm-5.3-flash"), "glm-5.3-flash: thinking=enabled, reasoning_effort=low (model-forced)");
  const d = resolveDeepseekThinking({ modelId: "glm-5.2" });
  assertEquals(describeThinking(d, "glm-5.2"), "glm-5.2: thinking=disabled (default)");
});

Deno.test("describeThinking names the REAL vendor when a host is supplied", () => {
  // The slot is called "deepseek" for historical reasons but is served by api.z.ai.
  // /health must be able to answer "which vendor is this build talking to" on its own.
  const r = resolveDeepseekThinking({ modelId: "glm-5.2" });
  assertEquals(describeThinking(r, "glm-5.2", "api.z.ai"), "glm-5.2 @ api.z.ai: thinking=disabled (default)");
  const f = resolveDeepseekThinking({ modelId: "glm-5.3-flash" });
  assertEquals(
    describeThinking(f, "glm-5.3-flash", "api.z.ai"),
    "glm-5.3-flash @ api.z.ai: thinking=enabled, reasoning_effort=low (model-forced)",
  );
});

// --- the SDK shape: the defect Codex caught on #938 -------------------------
import {
  PROBE_MAX_TOKENS_PLAIN,
  PROBE_MAX_TOKENS_THINKING,
  probeMaxTokens,
  toSdkProviderOptions,
} from "../../../functions/osint-agent/lib/glm-thinking.ts";

/**
 * Reproduces how @ai-sdk/openai-compatible@1 actually builds the request body
 * (dist/index.mjs ~:369-377): spread every providerOptions key the schema does NOT
 * recognise, then assign `reasoning_effort` from the camelCase `reasoningEffort`.
 * Testing the resolver's return value alone cannot catch the overwrite — only the
 * serialized body can, which is the whole point of this helper.
 */
const SDK_SCHEMA_KEYS = ["user", "reasoningEffort", "textVerbosity"];
function serializeLikeSdk(providerOptions: Record<string, unknown>): Record<string, unknown> {
  const body = {
    model: "glm-5.3-flash",
    ...Object.fromEntries(Object.entries(providerOptions).filter(([k]) => !SDK_SCHEMA_KEYS.includes(k))),
    reasoning_effort: providerOptions["reasoningEffort"],
  };
  // JSON.stringify drops undefined values — exactly how the key vanishes on the wire.
  return JSON.parse(JSON.stringify(body));
}

Deno.test("SDK shape: the effort survives serialization as reasoning_effort", () => {
  const wire = resolveDeepseekThinking({ modelId: "glm-5.3-flash" }).options;
  const body = serializeLikeSdk(toSdkProviderOptions(wire) as unknown as Record<string, unknown>);
  assertEquals(body.reasoning_effort, "low");
  assertEquals((body.thinking as { type: string }).type, "enabled");
  // The camelCase key must not leak onto the wire; the SDK consumes it.
  assertFalse(Object.keys(body).includes("reasoningEffort"));
});

Deno.test("REGRESSION: passing the WIRE shape to the SDK loses the effort entirely", () => {
  // This is the bug as shipped in a1b44bc. snake_case is spread in, then overwritten
  // with undefined and dropped — the request silently runs at the vendor default
  // (`max` on GLM-5.3), the opposite of the wall-clock safeguard.
  const wire = resolveDeepseekThinking({ modelId: "glm-5.3-flash" }).options;
  const body = serializeLikeSdk(wire as unknown as Record<string, unknown>);
  assertFalse(Object.keys(body).includes("reasoning_effort"), "the wire shape must NOT survive the SDK");
  // Thinking has no key collision, so it rides through either way — which is why the
  // failure was silent: the model reasons, just at the wrong effort.
  assertEquals((body.thinking as { type: string }).type, "enabled");
});

Deno.test("SDK shape omits the effort when thinking is disabled", () => {
  const wire = resolveDeepseekThinking({ modelId: "glm-5.2" }).options;
  const sdk = toSdkProviderOptions(wire);
  assertEquals(sdk.thinking.type, "disabled");
  assertEquals(sdk.reasoningEffort, undefined);
  assertFalse(Object.keys(sdk).includes("reasoningEffort"));
});

Deno.test("probe token ceiling lifts only when thinking is on", () => {
  // Reasoning tokens are emitted before any content, so a 4-token cap can truncate a
  // thinking probe into a failure that reads as "the orchestrator is down".
  assertEquals(probeMaxTokens(resolveDeepseekThinking({ modelId: "glm-5.2" }).options), PROBE_MAX_TOKENS_PLAIN);
  assertEquals(probeMaxTokens(resolveDeepseekThinking({ modelId: "glm-5.3-flash" }).options), PROBE_MAX_TOKENS_THINKING);
  assert(PROBE_MAX_TOKENS_THINKING > PROBE_MAX_TOKENS_PLAIN);
});

// --- wiring: the right shape at the right call site --------------------------
Deno.test("wiring: SDK call sites use the SDK shape, raw-fetch probes use the wire shape", async () => {
  const idx = await Deno.readTextFile(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
  // streamText + generateText both take the translated shape.
  assertStringIncludes(idx, "const deepseekThinkingSdk = toSdkProviderOptions(deepseekThinking.options);");
  assertEquals(idx.split("...deepseekThinkingSdk").length - 1, 2, "both SDK call sites must use the SDK shape");
  // No SDK call site may spread the wire shape into providerOptions.
  assertFalse(
    idx.includes("deepseek: { parallel_tool_calls: false, ...deepseekThinking.options }"),
    "the main stream must not spread the wire shape",
  );

  const health = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  // Both raw-fetch canaries take the wire shape and the thinking-aware token ceiling.
  assertStringIncludes(health, "max_tokens: probeMaxTokens(canaryThinking)");
  assertStringIncludes(health, "max_tokens: probeMaxTokens(probeThinking)");
  assertFalse(health.includes('thinking: { type: "disabled" }'), "no canary may hardcode the mode");
});
