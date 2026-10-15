// anthropic_fallback_test.ts — E2b: Anthropic is the BACKUP orchestrator behind GLM.
//
// Operator decision (JD, 2026-10-15): GLM-5.2 in the deepseek slot stays PRIMARY; Anthropic
// takes an invocation GLM cannot START. Measured: 2 GLM runs on 2026-10-13 died at step 0 on
// "Insufficient balance or no resource package" (Z.AI), with no working backup behind them.
//
// What is pinned here, driving the SHIPPED code rather than re-describing it:
//   1. selection: GLM primary + Anthropic key -> Anthropic is the fallback; no key or the
//      kill switch -> today's chain; never behind MiniMax / a pinned Anthropic;
//   2. the preflight pivot decision for an Anthropic target;
//   3. the start-failure classifier and decision for every failure class;
//   4. the wrapper through REAL providers (createOpenAICompatible for GLM, createAnthropic)
//      with fake fetches: a start failure moves the request, a mid-run failure never does;
//   5. each Anthropic request-shape hazard (a-d) through the real createAnthropic wire body;
//   6. the /health proof key.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { APICallError, generateText, jsonSchema, type ModelMessage, stepCountIs, streamText, tool } from "npm:ai@6";
import { createAnthropic } from "npm:@ai-sdk/anthropic@3";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";
import { anthropicFallbackEligible, selectOrchestratorProvider } from "./orchestrator_select.ts";
import {
  preflightCanPivot,
  preflightPolicyHealthDetailE2b,
  shouldRunDeepseekPreflight,
  preflightPolicyHealthDetail,
  resolveFallbackProvider,
  shouldPivotOnPreflight,
  shouldRunPreflight,
} from "./lib/preflight-pivot.ts";
import {
  ANTHROPIC_FALLBACK_DISABLED_ENV,
  anthropicBoundModel,
  anthropicFallbackDisabled,
  classifyStartFailure,
  createStartFallbackModel,
  decideStartFallback,
  fallbackModelLabel,
  orchestratorFallbackHealth,
  preflightFallbackReason,
  type StartFailure,
  startFallbackReason,
} from "./lib/orchestrator-fallback.ts";
import { repairAnthropicPrompt, sanitizeModelMessages } from "./message-sanitize.ts";
import { anthropicOrchestratorHealth } from "./anthropic-orchestrator.ts";
import { createInvocationTelemetry } from "./telemetry.ts";
import { handleHealthProbe } from "./health-handler.ts";

function withEnv<T>(name: string, value: string | null, fn: () => T): T {
  const prev = Deno.env.get(name);
  if (value === null) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prev);
  }
}
async function withEnvAsync<T>(name: string, value: string | null, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get(name);
  if (value === null) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prev);
  }
}
/** Swallow the structured warn lines the code under test emits; return them for assertions. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = warn;
  }
}

// ---------------------------------------------------------------------------
// 1. Selection
// ---------------------------------------------------------------------------

const eligible = (o: Partial<Parameters<typeof anthropicFallbackEligible>[0]> = {}) =>
  anthropicFallbackEligible({
    primary: "deepseek", anthropicKey: true, modelAcceptsForcedToolChoice: true, disabled: false, ...o,
  });

Deno.test("selection: GLM stays PRIMARY even with an Anthropic key configured", () => {
  const pinned = selectOrchestratorProvider({ pin: "deepseek", deepseek: true, minimax: true, grok: false, anthropic: true });
  assertEquals(pinned, { provider: "deepseek", reason: "pinned" });
  const unpinned = selectOrchestratorProvider({ pin: "", deepseek: true, minimax: false, grok: false, anthropic: true });
  assertEquals(unpinned.provider, "deepseek", "Anthropic is never a default");
});

Deno.test("selection: GLM primary + Anthropic key -> Anthropic is the first fallback", () => {
  assertEquals(eligible(), true);
  assertEquals(
    resolveFallbackProvider({
      orchestratorProvider: "deepseek", hasLovableGateway: true, hasGeminiDirect: true,
      allowLovableFallback: true, anthropicFallback: eligible(),
    }),
    "anthropic",
    "Anthropic outranks gemini-direct and the Lovable gateway behind GLM",
  );
});

Deno.test("selection: no Anthropic key -> today's chain (gemini-direct, then opt-in Lovable)", () => {
  const off = eligible({ anthropicKey: false });
  assertEquals(off, false);
  const base = { orchestratorProvider: "deepseek", hasLovableGateway: false, hasGeminiDirect: true, allowLovableFallback: false };
  assertEquals(resolveFallbackProvider({ ...base, anthropicFallback: off }), "gemini-direct");
  assertEquals(resolveFallbackProvider({ ...base, hasGeminiDirect: false, anthropicFallback: off }), null);
  assertEquals(
    resolveFallbackProvider({ ...base, hasGeminiDirect: false, hasLovableGateway: true, allowLovableFallback: true, anthropicFallback: off }),
    "lovable-gateway",
  );
});

Deno.test("selection: ANTHROPIC_FALLBACK_DISABLED=true restores today's chain, read at call time", () => {
  withEnv(ANTHROPIC_FALLBACK_DISABLED_ENV, "true", () => {
    assertEquals(anthropicFallbackDisabled(), true);
    assertEquals(eligible({ disabled: anthropicFallbackDisabled() }), false);
  });
  withEnv(ANTHROPIC_FALLBACK_DISABLED_ENV, " TRUE ", () => assertEquals(anthropicFallbackDisabled(), true));
  withEnv(ANTHROPIC_FALLBACK_DISABLED_ENV, "false", () => assertEquals(anthropicFallbackDisabled(), false));
  withEnv(ANTHROPIC_FALLBACK_DISABLED_ENV, null, () => assertEquals(anthropicFallbackDisabled(), false));
  assertEquals(
    resolveFallbackProvider({
      orchestratorProvider: "deepseek", hasLovableGateway: false, hasGeminiDirect: true,
      allowLovableFallback: false, anthropicFallback: eligible({ disabled: true }),
    }),
    "gemini-direct",
  );
});

Deno.test("selection: Anthropic is never a fallback behind MiniMax, Grok, itself, or a forced-tool-choice-rejecting model", () => {
  assertEquals(eligible({ primary: "minimax" }), false);
  assertEquals(eligible({ primary: "grok" }), false);
  assertEquals(eligible({ primary: "anthropic" }), false);
  assertEquals(eligible({ modelAcceptsForcedToolChoice: false }), false);
  // A pinned Lovable gateway still owns the run.
  assertEquals(
    resolveFallbackProvider({
      orchestratorProvider: "lovable", hasLovableGateway: true, hasGeminiDirect: true,
      allowLovableFallback: false, anthropicFallback: true,
    }),
    "lovable-gateway",
  );
});

// ---------------------------------------------------------------------------
// 2. Preflight pivot with an Anthropic target
// ---------------------------------------------------------------------------

Deno.test("preflight: an explicit GLM failure pivots to Anthropic; a timeout or success never does", () => {
  const target = { provider: "anthropic" };
  for (const status of [400, 401, 402, 403, 429, 500, 503]) {
    assertEquals(shouldPivotOnPreflight({ ok: false, status }, target, false), true, `HTTP ${status}`);
  }
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 0 }, target, false), false, "a timeout is ambiguous");
  assertEquals(shouldPivotOnPreflight({ ok: true, status: 200 }, target, false), false);
  // The gemini-direct switch does not gate Anthropic: WHEN the probe runs, it can pivot there.
  assertEquals(preflightCanPivot(target, false), true);
});

Deno.test("preflight: Anthropic armed does NOT by itself turn the preflight on (identical to pre-E2b)", () => {
  const GEMINI = { provider: "gemini-direct" };
  const ANTHROPIC = { provider: "anthropic" };
  // Every (legacy target, gemini switch, ALWAYS) combination: the run decision is exactly
  // what shouldRunPreflight decided before this branch, over the pre-E2b target.
  for (const legacy of [null, GEMINI, { provider: "lovable-gateway" }]) {
    for (const gem of [false, true]) {
      for (const always of [false, true]) {
        assertEquals(
          shouldRunDeepseekPreflight(legacy, gem, always),
          shouldRunPreflight(legacy, gem, always),
          `${legacy?.provider ?? "none"}/${gem}/${always}`,
        );
      }
    }
  }
  // Production today: GLM primary, gemini key, gemini pivot OFF, no ALWAYS -> skipped.
  assertEquals(shouldRunDeepseekPreflight(GEMINI, false, false), false, "anthropic armed adds no 24.5s probe");
  assertEquals(shouldRunDeepseekPreflight(null, false, false), false);
  // Forced on by the existing switch: it runs, and a failure may then pivot to Anthropic.
  assertEquals(shouldRunDeepseekPreflight(GEMINI, false, true), true);
  assertEquals(shouldPivotOnPreflight({ ok: false, status: 429 }, ANTHROPIC, false), true);

  const skipped = preflightPolicyHealthDetailE2b(ANTHROPIC, GEMINI, false, false);
  assertStringIncludes(skipped, "preflight skipped");
  assertStringIncludes(skipped, "failover happens on the first request, not the preflight");
  const forced = preflightPolicyHealthDetailE2b(ANTHROPIC, GEMINI, true, false);
  assertStringIncludes(forced, "preflight runs on every request");
  assertStringIncludes(forced, "a preflight failure pivots to anthropic");
  // Kill switch on (routing target = legacy): the detail is exactly the pre-E2b text.
  assertEquals(preflightPolicyHealthDetailE2b(GEMINI, GEMINI, false, false), preflightPolicyHealthDetail(GEMINI, false, false));
});

Deno.test("wiring: index.ts decides the preflight run on the LEGACY target, never the Anthropic one", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = src.indexOf("const runDeepseekPreflight =");
  assert(at > 0);
  const decl = src.slice(at, at + 400);
  assertStringIncludes(decl, "shouldRunDeepseekPreflight(");
  assertStringIncludes(decl, "legacyFallbackProvider");
  assertEquals(decl.includes("shouldRunPreflight(fallbackTarget"), false);
  const legacy = src.slice(src.indexOf("const legacyFallbackProvider = resolveFallbackProvider({"), at);
  assertEquals(legacy.includes("anthropicFallback"), false, "the legacy target never includes Anthropic");
});

Deno.test("preflight: the recorded reason names the failure", () => {
  assertEquals(preflightFallbackReason(429), "fallback:glm_preflight_http_429");
  assertEquals(preflightFallbackReason(402), "fallback:glm_preflight_insufficient_balance");
  assertEquals(preflightFallbackReason(401), "fallback:glm_preflight_auth");
  assertEquals(
    fallbackModelLabel("claude-sonnet-5", "fallback:glm_insufficient_balance"),
    "claude-sonnet-5 (Anthropic fallback:glm_insufficient_balance)",
  );
});

// ---------------------------------------------------------------------------
// 3. Start-failure classification and the decision, per class
// ---------------------------------------------------------------------------

const apiError = (statusCode: number | undefined, message: string, isRetryable?: boolean) =>
  new APICallError({
    message, url: "https://api.z.ai/api/paas/v4/chat/completions", requestBodyValues: {},
    statusCode, responseBody: "{}", isRetryable,
  });

Deno.test("classify: the measured Z.AI balance failure (HTTP 429 + message) is insufficient_balance", () => {
  const f = classifyStartFailure(apiError(429, "Insufficient balance or no resource package. Please recharge."));
  assertEquals(f.cls, "insufficient_balance");
  assertEquals(startFallbackReason(f), "fallback:glm_insufficient_balance");
  assertEquals(classifyStartFailure(apiError(402, "Payment Required")).cls, "insufficient_balance");
  // The SDK's RetryError wrapper is unwrapped to its last error.
  const retryWrapped = { name: "AI_RetryError", message: "Failed after 3 attempts.", lastError: apiError(429, "Insufficient balance or no resource package") };
  assertEquals(classifyStartFailure(retryWrapped).cls, "insufficient_balance");
});

Deno.test("classify: auth, rate limit, 5xx, connection, and what is NOT a start failure", () => {
  assertEquals(classifyStartFailure(apiError(401, "Unauthorized")).cls, "auth");
  assertEquals(classifyStartFailure(apiError(403, "Forbidden")).cls, "auth");
  assertEquals(classifyStartFailure(apiError(429, "Too Many Requests")).cls, "rate_limited");
  assertEquals(classifyStartFailure(apiError(503, "Service Unavailable")).cls, "server_error");
  assertEquals(classifyStartFailure(apiError(undefined, "Cannot connect to API: fetch failed", true)).cls, "connection");
  assertEquals(classifyStartFailure(new TypeError("error sending request")).cls, "connection");
  assertEquals(classifyStartFailure(apiError(400, "Bad Request")).cls, "other", "a request-shape 400 would fail on any provider");
  assertEquals(classifyStartFailure(new DOMException("Investigation stopped by analyst", "AbortError")).cls, "other");
});

const decide = (failure: StartFailure, o: Partial<Parameters<typeof decideStartFallback>[0]> = {}) =>
  decideStartFallback({ failure, attempt: 1, maxAttempts: 3, primaryAccepted: 0, toolsAdmitted: 0, disabled: false, ...o });

Deno.test("decide: balance and auth move NOW; transient classes only after the SDK's retries", () => {
  const f = (cls: StartFailure["cls"], retryable: boolean | null = true): StartFailure => ({ cls, status: null, retryable });
  assertEquals(decide(f("insufficient_balance")), { fallback: true, why: "switch_now" });
  assertEquals(decide(f("auth", false)), { fallback: true, why: "switch_now" });
  for (const cls of ["rate_limited", "server_error", "connection"] as const) {
    assertEquals(decide(f(cls), { attempt: 1 }), { fallback: false, why: "retry_primary" }, `${cls} attempt 1`);
    assertEquals(decide(f(cls), { attempt: 2 }), { fallback: false, why: "retry_primary" }, `${cls} attempt 2`);
    assertEquals(decide(f(cls), { attempt: 3 }), { fallback: true, why: "retries_exhausted" }, `${cls} attempt 3`);
    assertEquals(decide(f(cls, false), { attempt: 1 }), { fallback: true, why: "not_retryable" }, `${cls} the SDK will not retry`);
  }
  assertEquals(decide(f("other"), { attempt: 3 }), { fallback: false, why: "not_a_start_failure" });
});

Deno.test("decide: NEVER after a tool was admitted, after GLM accepted a request, or with the kill switch", () => {
  const bal: StartFailure = { cls: "insufficient_balance", status: 429, retryable: true };
  assertEquals(decide(bal, { toolsAdmitted: 1 }), { fallback: false, why: "tool_admitted" });
  assertEquals(decide(bal, { primaryAccepted: 1 }), { fallback: false, why: "mid_run" });
  assertEquals(decide(bal, { disabled: true }), { fallback: false, why: "kill_switch" });
});

// ---------------------------------------------------------------------------
// 4. The wrapper through REAL providers with fake fetches
// ---------------------------------------------------------------------------

const ZAI_BALANCE = { error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } };

function sse(events: Array<Record<string, unknown> | string>, named = false): Response {
  const body = events.map((e) => {
    if (typeof e === "string") return `data: ${e}\n\n`;
    return named ? `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`;
  }).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ANTHROPIC_TEXT_STREAM = (text: string) => [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const glmChunk = (delta: Record<string, unknown>, finish: string | null, usage = false) => ({
  id: "c1", object: "chat.completion.chunk", created: 1, model: "glm-5.2",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}),
});

/** A GLM (OpenAI-compatible) provider whose responses come from `respond`, recording bodies. */
function fakeGlm(respond: (n: number) => Response) {
  const bodies: Array<Record<string, unknown>> = [];
  const f = ((_u: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(respond(bodies.length));
  }) as typeof fetch;
  const gw = createOpenAICompatible({ name: "deepseek", baseURL: "https://api.z.ai/api/paas/v4", apiKey: "glm-test", fetch: f });
  return { model: gw.chatModel("glm-5.2"), bodies };
}
function fakeAnthropic(text = "ok from claude") {
  const bodies: Array<Record<string, unknown>> = [];
  const f = ((_u: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(sse(ANTHROPIC_TEXT_STREAM(text), true));
  }) as typeof fetch;
  const a = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: f });
  return { model: anthropicBoundModel(a("claude-sonnet-5")), bodies };
}
const errorResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });

const ANTHROPIC_OPTS = { anthropic: { disableParallelToolUse: true, thinking: { type: "disabled" } } };

function wrap(glm: ReturnType<typeof fakeGlm>, claude: ReturnType<typeof fakeAnthropic>, toolsAdmitted = () => 0) {
  const switches: Array<{ reason: string; why: string; attempt: number }> = [];
  const w = createStartFallbackModel({
    primary: glm.model,
    fallback: claude.model,
    fallbackParams: (p) => ({ ...p, providerOptions: { ...(p?.providerOptions ?? {}), ...ANTHROPIC_OPTS } }),
    toolsAdmitted,
    disabled: () => anthropicFallbackDisabled(),
    onSwitch: (ev) => switches.push({ reason: ev.reason, why: ev.why, attempt: ev.attempt }),
  });
  return { ...w, switches };
}

Deno.test("start fallback: the measured Z.AI balance failure moves step 0 to Anthropic at once", async () => {
  const glm = fakeGlm(() => errorResponse(429, ZAI_BALANCE));
  const claude = fakeAnthropic();
  const w = wrap(glm, claude);
  const { value: text, lines } = await captureWarn(async () => {
    const r = streamText({
      model: w.model, prompt: "investigate probe@example.invalid",
      providerOptions: { deepseek: { parallel_tool_calls: false, thinking: { type: "disabled" } } },
    });
    return await r.text;
  });
  assertEquals(text, "ok from claude");
  assertEquals(glm.bodies.length, 1, "no point retrying an empty balance");
  assertEquals(claude.bodies.length, 1);
  assertEquals(w.state.switched, true);
  assertEquals(w.switches, [{ reason: "fallback:glm_insufficient_balance", why: "switch_now", attempt: 1 }]);
  // The GLM request is unchanged by the fallback options; Anthropic gets its own.
  assertEquals(JSON.stringify(glm.bodies[0]).includes("disable_parallel_tool_use"), false);
  assertEquals((claude.bodies[0] as { thinking?: unknown }).thinking, { type: "disabled" });
  assertEquals(lines.some((l) => l.includes("deepseek")), false, "nothing leaks the GLM providerOptions into a warning");
});

Deno.test("start fallback: 401 auth moves at once; plain 429 / 503 only after the SDK's 3 attempts", async () => {
  {
    const glm = fakeGlm(() => errorResponse(401, { error: { message: "Unauthorized" } }));
    const claude = fakeAnthropic();
    const w = wrap(glm, claude);
    const text = await (await captureWarn(async () => await streamText({ model: w.model, prompt: "go" }).text)).value;
    assertEquals(text, "ok from claude");
    assertEquals(glm.bodies.length, 1);
    assertEquals(w.switches[0].reason, "fallback:glm_auth");
  }
  for (const [status, cls] of [[429, "rate_limited"], [503, "server_error"]] as const) {
    const glm = fakeGlm(() => errorResponse(status, { error: { message: "busy" } }));
    const claude = fakeAnthropic();
    const w = wrap(glm, claude);
    const text = await (await captureWarn(async () => await streamText({ model: w.model, prompt: "go" }).text)).value;
    assertEquals(text, "ok from claude", `${status}`);
    assertEquals(glm.bodies.length, 3, `${status}: the SDK's retries are spent on GLM first`);
    assertEquals(w.switches[0], { reason: `fallback:glm_${cls}`, why: "retries_exhausted", attempt: 3 });
  }
});

Deno.test("start fallback: a transient GLM error that recovers keeps the run on GLM", async () => {
  const glm = fakeGlm((n) =>
    n === 1
      ? errorResponse(503, { error: { message: "busy" } })
      : sse([glmChunk({ role: "assistant", content: "glm answer" }, null), glmChunk({}, "stop", true), "[DONE]"])
  );
  const claude = fakeAnthropic();
  const w = wrap(glm, claude);
  const text = await streamText({ model: w.model, prompt: "go" }).text;
  assertEquals(text, "glm answer");
  assertEquals(claude.bodies.length, 0);
  assertEquals(w.state.switched, false);
});

Deno.test("start fallback: a healthy GLM run through the wrapper is identical to the unwrapped model", async () => {
  // @ai-sdk/openai-compatible@1 is a v2 model; the wrapper must adapt it exactly as streamText
  // does, or a GLM step's finish/usage shape changes (and its tools never run).
  const respond = () =>
    sse([
      glmChunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"probe"}' } }] }, null),
      glmChunk({}, "tool_calls", true),
      "[DONE]",
    ]);
  const run = async (wrapped: boolean) => {
    const glm = fakeGlm(respond);
    let ran = 0;
    const model = wrapped ? wrap(glm, fakeAnthropic()).model : glm.model;
    const r = streamText({
      model, prompt: "go", stopWhen: stepCountIs(1),
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: jsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
          execute: async () => { ran++; return { ok: true }; },
        }),
      },
    });
    const usage = await r.totalUsage;
    const finishReason = await r.finishReason;
    return { ran, usage, finishReason, body: glm.bodies[0] };
  };
  const direct = await captureWarn(async () => await run(false));
  const wrapped = await run(true);
  assertEquals(wrapped.ran, 1);
  assertEquals(wrapped.ran, direct.value.ran);
  assertEquals(wrapped.finishReason, direct.value.finishReason);
  assertEquals(wrapped.usage, direct.value.usage);
  assertEquals(wrapped.body, direct.value.body, "the GLM request body is unchanged by the wrapper");
});

Deno.test("start fallback: a 400 (request shape) is not a start failure and is NOT moved", async () => {
  const glm = fakeGlm(() => errorResponse(400, { error: { message: "Bad Request" } }));
  const claude = fakeAnthropic();
  const w = wrap(glm, claude);
  let failed = false;
  await captureWarn(async () => {
    try {
      await streamText({ model: w.model, prompt: "go", onError: () => {} }).text;
    } catch {
      failed = true;
    }
  });
  assertEquals(claude.bodies.length, 0);
  assertEquals(w.state.switched, false);
  assert(failed || !w.state.switched);
});

Deno.test("start fallback: NO mid-run switch once GLM ran a step and a tool was admitted", async () => {
  // Step 0: GLM answers with a tool call; the tool runs. Step 1: GLM is out of balance.
  const glm = fakeGlm((n) =>
    n === 1
      ? sse([
        glmChunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"probe"}' } }] }, null),
        glmChunk({}, "tool_calls", true),
        "[DONE]",
      ])
      : errorResponse(429, ZAI_BALANCE)
  );
  const claude = fakeAnthropic();
  let toolRuns = 0;
  const w = wrap(glm, claude, () => toolRuns);
  let streamError: unknown = null;
  await captureWarn(async () => {
    const r = streamText({
      model: w.model,
      prompt: "go",
      stopWhen: stepCountIs(3),
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: jsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
          execute: async () => {
            toolRuns++;
            return { ok: true };
          },
        }),
      },
      onError: ({ error }) => { streamError = error; },
    });
    await r.consumeStream();
  });
  assertEquals(toolRuns, 1, `the tool ran on GLM step 0 (glm calls=${glm.bodies.length}, err=${String(streamError)})`);
  assertEquals(claude.bodies.length, 0, "Anthropic is never called mid-run");
  assertEquals(w.state.switched, false);
  assert(streamError !== null, "the run ends on the error exactly as before");
});

Deno.test("start fallback: the toolsAdmitted guard alone forbids a switch", async () => {
  const glm = fakeGlm(() => errorResponse(429, ZAI_BALANCE));
  const claude = fakeAnthropic();
  const w = wrap(glm, claude, () => 1);
  await captureWarn(async () => {
    await streamText({ model: w.model, prompt: "go", onError: () => {} }).consumeStream();
  });
  assertEquals(claude.bodies.length, 0);
  assertEquals(w.state.switched, false);
});

Deno.test("start fallback: ANTHROPIC_FALLBACK_DISABLED=true disarms it on a running build", async () => {
  await withEnvAsync(ANTHROPIC_FALLBACK_DISABLED_ENV, "true", async () => {
    const glm = fakeGlm(() => errorResponse(429, ZAI_BALANCE));
    const claude = fakeAnthropic();
    const w = wrap(glm, claude);
    await captureWarn(async () => {
      await streamText({ model: w.model, prompt: "go", onError: () => {} }).consumeStream();
    });
    assertEquals(claude.bodies.length, 0);
    assertEquals(w.state.switched, false);
  });
});

Deno.test("start fallback: after a switch the report salvage (doGenerate) also goes to Anthropic; it never starts one", async () => {
  // Never switched: a generate call stays on the primary even when it fails.
  {
    const glm = fakeGlm(() => errorResponse(429, ZAI_BALANCE));
    const claude = fakeAnthropic();
    const w = wrap(glm, claude);
    let threw = false;
    try {
      await generateText({ model: w.model, prompt: "salvage", maxRetries: 0 });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(claude.bodies.length, 0);
  }
  // Switched by a stream: the salvage follows.
  {
    const glm = fakeGlm(() => errorResponse(429, ZAI_BALANCE));
    const okJson = {
      id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "salvaged" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const bodies: unknown[] = [];
    const f = ((_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(b);
      return Promise.resolve(
        b.stream ? sse(ANTHROPIC_TEXT_STREAM("ok"), true) : new Response(JSON.stringify(okJson), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as typeof fetch;
    const claudeModel = anthropicBoundModel(createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: f })("claude-sonnet-5"));
    const w = createStartFallbackModel({ primary: glm.model, fallback: claudeModel, toolsAdmitted: () => 0, disabled: () => false });
    await captureWarn(async () => await streamText({ model: w.model, prompt: "go" }).text);
    const s = await generateText({ model: w.model, prompt: "salvage", maxRetries: 0 });
    assertEquals(s.text, "salvaged");
    assertEquals(glm.bodies.length, 1, "GLM was not asked again");
    assertEquals(bodies.length, 2);
  }
});

Deno.test("telemetry: a switched invocation records provider=anthropic and the reason", () => {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    from: (_t: string) => ({
      insert: (row: Record<string, unknown>) => {
        rows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  const t = createInvocationTelemetry({
    db, threadId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
    provider: "deepseek", modelId: "glm-5.2 (api.z.ai)", startedAt: Date.now(), initialContextChars: 10,
  });
  t.setRoute({ provider: "anthropic", modelId: fallbackModelLabel("claude-sonnet-5", "fallback:glm_insufficient_balance") });
  t.finish({ finishedAt: Date.now(), finalContextChars: null, finalizeStarted: false, hadStreamError: false, creditsMicroUsd: 0, errorMessage: null });
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      const parent = rows.find((r) => "provider" in r);
      assert(parent, "the invocation row was written");
      assertEquals(parent!.provider, "anthropic");
      assertEquals(parent!.model_id, "claude-sonnet-5 (Anthropic fallback:glm_insufficient_balance)");
      resolve();
    }, 20)
  );
});

Deno.test("wiring: index.ts arms the start fallback only behind GLM, and records the reason", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(src, `const startFallback = deepseekIsPrimary && !useFallback && fallbackTarget?.provider === "anthropic"`);
  assertStringIncludes(src, "toolCallBudget.genuine + toolCallBudget.reserved + invocationTelemetry.getToolCallCount()");
  assertStringIncludes(src, "invocationTelemetry.setRoute({");
  assertStringIncludes(src, `event: "orchestrator_fallback"`);
  assertStringIncludes(src, "anthropicFallback: anthropicFallbackReady && !deepseekWouldOverflow");
  // Pinned Anthropic and the fallback both go through the Anthropic-bound prompt repair.
  assertStringIncludes(src, "anthropicBoundModel(anthropicGateway!(ANTHROPIC_MODEL_ID)), label:");
  assertStringIncludes(src, "makeModel: () => anthropicBoundModel(anthropicGateway!(ANTHROPIC_MODEL_ID))");
});

// ---------------------------------------------------------------------------
// 5. Request-shape hazards, through the REAL createAnthropic wire body
// ---------------------------------------------------------------------------

type WireBlock = Record<string, unknown> & { type: string };
type WireMsg = { role: string; content: string | WireBlock[] };

/** Anthropic's documented request rules for `messages`, checked on the body the provider built. */
function anthropicWireProblems(body: { messages: WireMsg[] }): string[] {
  const problems: string[] = [];
  const msgs = body.messages;
  const seen = new Set<string>();
  msgs.forEach((m, i) => {
    if (i > 0 && msgs[i - 1].role === m.role) problems.push(`messages.${i}: roles must alternate`);
    if (typeof m.content === "string") {
      if (m.content.trim() === "") problems.push(`messages.${i}: empty content`);
      return;
    }
    if (!Array.isArray(m.content) || m.content.length === 0) {
      problems.push(`messages.${i}: all messages must have non-empty content`);
      return;
    }
    let sawNonResult = false;
    for (const b of m.content) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() === "") {
        problems.push(`messages.${i}: text content blocks must contain non-whitespace text`);
      }
      if (b.type === "thinking" && typeof b.signature !== "string") problems.push(`messages.${i}: thinking without signature`);
      if (b.type === "tool_use") {
        const id = String(b.id);
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) problems.push(`messages.${i}: tool_use id pattern`);
        if (seen.has(id)) problems.push(`messages.${i}: tool_use ids must be unique (${id})`);
        seen.add(id);
      }
      if (m.role === "user") {
        if (b.type === "tool_result") {
          if (sawNonResult) problems.push(`messages.${i}: tool_result blocks must come first`);
          const prev = msgs[i - 1];
          const prevIds = prev && prev.role === "assistant" && Array.isArray(prev.content)
            ? prev.content.filter((x) => x.type === "tool_use").map((x) => String(x.id))
            : [];
          if (!prevIds.includes(String(b.tool_use_id))) {
            problems.push(`messages.${i}: unexpected tool_use_id found in tool_result blocks (${b.tool_use_id})`);
          }
        } else sawNonResult = true;
      }
    }
    if (m.role === "assistant") {
      const ids = m.content.filter((x) => x.type === "tool_use").map((x) => String(x.id));
      const next = msgs[i + 1];
      const answered = next && Array.isArray(next.content)
        ? next.content.filter((x) => x.type === "tool_result").map((x) => String(x.tool_use_id))
        : [];
      for (const id of ids) {
        if (!answered.includes(id)) problems.push(`messages.${i}: tool_use ${id} without tool_result immediately after`);
      }
    }
  });
  return problems;
}

const OK_BODY = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

/** The production path: sanitizeModelMessages (every model call) -> the Anthropic-bound model -> wire. */
async function wireFor(history: ModelMessage[], repair: boolean): Promise<{ messages: WireMsg[] }> {
  const seen: Array<{ messages: WireMsg[] }> = [];
  const f = ((_u: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const model = anthropicBoundModel(createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: f })("claude-sonnet-5"));
  await withEnvAsync("ANTHROPIC_PROMPT_REPAIR_DISABLED", repair ? null : "true", async () => {
    await captureWarn(async () => {
      await generateText({ model, messages: sanitizeModelMessages(history), maxRetries: 0 });
    });
  });
  assertEquals(seen.length, 1);
  return seen[0];
}

const call = (id: string, name = "lookup") => ({ type: "tool-call", toolCallId: id, toolName: name, input: { q: "probe" } });
const result = (id: string, value = "found", name = "lookup") => ({
  type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value },
});

async function assertHazardFixed(label: string, history: ModelMessage[], expect: RegExp) {
  const before = anthropicWireProblems(await wireFor(history, false));
  assert(before.some((p) => expect.test(p)), `${label}: REPRO must be invalid before the repair, got ${JSON.stringify(before)}`);
  const after = anthropicWireProblems(await wireFor(history, true));
  assertEquals(after, [], `${label}: the repaired wire body is valid`);
}

Deno.test("hazard (a): whitespace-only text parts survive sanitizeModelMessages and are dropped for Anthropic", async () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "investigate probe@example.invalid" }] },
    { role: "assistant", content: [{ type: "text", text: "  \n " }, call("call_1")] },
    { role: "tool", content: [result("call_1")] },
    { role: "assistant", content: [{ type: "text", text: "\n\n" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ] as unknown as ModelMessage[];
  await assertHazardFixed("whitespace", history, /non-whitespace text|non-empty content/);
});

Deno.test("hazard (b): a GLM reasoning-only assistant message is dropped instead of going out empty", async () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "investigate probe@example.invalid" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "GLM chain of thought", providerOptions: { deepseek: { reasoning_content: "x" } } }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ] as unknown as ModelMessage[];
  await assertHazardFixed("foreign reasoning", history, /non-empty content/);
  // An Anthropic-signed thinking block is KEPT.
  const signed = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "t", providerOptions: { anthropic: { signature: "sig" } } }, { type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
  ] as unknown as ModelMessage[];
  const wire = await wireFor(signed, true);
  assertEquals((wire.messages[1].content as WireBlock[])[0].type, "thinking");
});

Deno.test("hazard (c): a tool_use id duplicated by the overlap repair is made unique, with its result", async () => {
  // Two overlapping runs on one thread replayed the same call id (the 12.2% overlap wedge).
  const history = [
    { role: "user", content: [{ type: "text", text: "investigate probe@example.invalid" }] },
    { role: "assistant", content: [call("call_dup")] },
    { role: "tool", content: [result("call_dup", "first")] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [call("call_dup")] },
    { role: "tool", content: [result("call_dup", "second")] },
    { role: "user", content: [{ type: "text", text: "and?" }] },
  ] as unknown as ModelMessage[];
  await assertHazardFixed("duplicate id", history, /must be unique/);
  const wire = await wireFor(history, true);
  const uses = wire.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use");
  assertEquals(uses.map((u) => u.id), ["call_dup", "call_dup_dup2"]);
  // Each result stays with ITS call: the second call still answers "second".
  const res = wire.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
  assertEquals(res.map((r) => r.tool_use_id), ["call_dup", "call_dup_dup2"]);
  assertStringIncludes(JSON.stringify(res[1].content), "second");
});

Deno.test("hazard (d): a tool_result that is not right after its tool_use is never sent there", async () => {
  // A result replayed AFTER a user turn (e.g. a late write from an overlapping run).
  const stray = [
    { role: "user", content: [{ type: "text", text: "investigate probe@example.invalid" }] },
    { role: "assistant", content: [call("call_1")] },
    { role: "tool", content: [result("call_1", "real")] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "tool", content: [result("call_1", "late duplicate")] },
  ] as unknown as ModelMessage[];
  await assertHazardFixed("stray result after a user turn", stray, /unexpected tool_use_id|must come first/);

  // A result for an EARLIER call answered inside a LATER assistant's tool block.
  const misplaced = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [call("call_a")] },
    { role: "tool", content: [result("call_a", "a")] },
    { role: "assistant", content: [call("call_b")] },
    { role: "tool", content: [result("call_b", "b"), result("call_a", "a again")] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ] as unknown as ModelMessage[];
  await assertHazardFixed("result in the wrong block", misplaced, /unexpected tool_use_id/);
});

Deno.test("repair: a valid prompt comes back as the SAME array (no change for a clean history)", () => {
  const clean = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "on it" }, call("call_1")] },
    { role: "tool", content: [result("call_1")] },
  ];
  const r = repairAnthropicPrompt(clean);
  assertEquals(r.changed, false);
  assert(r.prompt === clean);
});

Deno.test("repair: an id Anthropic's pattern rejects is rewritten consistently, and a missing result is synthesized", () => {
  const p = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [call("call:1.x"), call("call_2")] },
    { role: "tool", content: [result("call:1.x")] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
  const r = repairAnthropicPrompt(p);
  assertEquals(r.repairs.invalid_tool_id, 1);
  assertEquals(r.repairs.synthesized_result, 1);
  const a = r.prompt[1] as { content: Array<{ toolCallId: string }> };
  const t = r.prompt[2] as { role: string; content: Array<{ toolCallId: string; output: { value: string } }> };
  assertEquals(a.content.map((c) => c.toolCallId), ["call_1_x", "call_2"]);
  assertEquals(t.role, "tool");
  assertEquals(t.content.map((c) => c.toolCallId), ["call_1_x", "call_2"]);
  assertEquals(JSON.stringify(t.content[1].output).includes("probe"), false, "the placeholder carries no value");
});

// ---------------------------------------------------------------------------
// 6. /health proof key
// ---------------------------------------------------------------------------

Deno.test("health: checks.orchestrator_fallback reports Anthropic as GLM's fallback", () => {
  const h = orchestratorFallbackHealth({
    primary: "deepseek", anthropicKey: true, modelAcceptsForcedToolChoice: true, disabled: false, target: "anthropic",
  });
  assertEquals(h.ok, true);
  assertEquals(h.anthropic_role, "fallback");
  assertEquals(h.fallback, "anthropic");
  assertStringIncludes(h.detail, "never mid-run");

  const off = orchestratorFallbackHealth({
    primary: "deepseek", anthropicKey: true, modelAcceptsForcedToolChoice: true, disabled: true, target: "gemini-direct",
  });
  assertEquals(off.anthropic_role, "inactive");
  assertStringIncludes(off.detail, ANTHROPIC_FALLBACK_DISABLED_ENV);
  assertStringIncludes(off.detail, "fallback=gemini-direct");

  const noKey = orchestratorFallbackHealth({
    primary: "deepseek", anthropicKey: false, modelAcceptsForcedToolChoice: true, disabled: false, target: null,
  });
  assertEquals(noKey.anthropic_role, "inactive");
  assertEquals(noKey.ok, true, "no key = the operator has not asked for a backup");

  const broken = orchestratorFallbackHealth({
    primary: "deepseek", anthropicKey: true, modelAcceptsForcedToolChoice: false, disabled: false, target: null,
  });
  assertEquals(broken.ok, false, "a key is set behind GLM but the backup cannot arm");
});

Deno.test("health: checks.orchestrator_anthropic says role=fallback behind GLM, active when pinned", () => {
  const base = {
    keyPresent: true, pin: "deepseek", selectedProvider: "deepseek", modelId: "claude-sonnet-5",
    modelSource: "default" as const, thinking: "disabled" as const, effort: null,
    limits: { maxInputTokens: 1_500_000, maxCostMicroUsd: 2_000_000 },
  };
  const fb = anthropicOrchestratorHealth({ ...base, fallback: true });
  assertEquals(fb.role, "fallback");
  assertStringIncludes(fb.detail, "fallback");
  assertEquals(anthropicOrchestratorHealth({ ...base, fallback: false }).role, undefined);
  assertEquals(anthropicOrchestratorHealth({ ...base, pin: "anthropic", selectedProvider: "anthropic" }).role, "active");
});

Deno.test("health: the live probe carries checks.orchestrator_fallback (proof of deploy)", async () => {
  const res = await handleHealthProbe(new Request("https://edge.test/osint-agent?health=1", { method: "GET" }));
  const body = await res.json();
  assertEquals(typeof body.checks.orchestrator_fallback, "object");
  assertEquals(typeof body.checks.orchestrator_fallback.detail, "string");
  // No keys in the test environment: Anthropic plays no part, so it carries no role.
  assertEquals(body.checks.orchestrator_anthropic.role, undefined);
});
