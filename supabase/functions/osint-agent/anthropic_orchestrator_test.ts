// Drives the REAL @ai-sdk/anthropic provider + AI SDK (ai@6) against a fake fetch, so the
// properties that protect the prepaid credit balance are proven on the wire, not
// re-described: where cache_control lands, how usage maps into billable buckets, that a
// credit-exhausted 400 is sent exactly once, and that a 429 retry is bounded.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { APICallError, generateText, tool } from "npm:ai@6";
import { createAnthropic } from "npm:@ai-sdk/anthropic@3";
import { z } from "npm:zod@3";
import {
  anthropicOrchestratorHealth, anthropicProviderOptions, classifyAnthropicError, extractAnthropicUsage,
  runBudgetExhausted, splitCachedSystem, stepCostMicroUsd,
} from "./anthropic-orchestrator.ts";

const OK_BODY = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 },
};

function fakeFetch(handler: (req: { url: string; body: Record<string, unknown> }, n: number) => Response) {
  let calls = 0;
  const seen: Array<Record<string, unknown>> = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(body);
    return Promise.resolve(handler({ url: String(input), body }, calls));
  }) as typeof fetch;
  return { f, calls: () => calls, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

Deno.test("cache breakpoint lands on the stable system block only; directive and tools ride the same request", async () => {
  const TOOL_BODY = {
    ...OK_BODY,
    content: [{ type: "tool_use", id: "toolu_1", name: "ping", input: {} }],
    stop_reason: "tool_use",
  };
  const net = fakeFetch(() => json(200, TOOL_BODY));
  const anthropic = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: net.f });
  const base = "BASE PROMPT ";
  const system = splitCachedSystem(base + "STEP DIRECTIVE", base);
  await generateText({
    model: anthropic("claude-sonnet-5"),
    system,
    messages: [{ role: "user", content: "hi" }],
    tools: { ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => ({}) }) },
    toolChoice: "required",
    providerOptions: anthropicProviderOptions({ thinking: "disabled", effort: null }),
  });
  const body = net.seen[0] as {
    system: Array<{ text: string; cache_control?: unknown }>;
    thinking?: { type: string };
    tool_choice?: { type: string; disable_parallel_tool_use?: boolean };
    tools?: unknown[];
  };
  assertEquals(body.system.length, 2);
  assertEquals(body.system[0].text, base);
  assertEquals(body.system[0].cache_control, { type: "ephemeral" });
  assertEquals(body.system[1].text, "STEP DIRECTIVE");
  assertEquals(body.system[1].cache_control, undefined, "the volatile directive must not carry a breakpoint");
  assertEquals(body.thinking?.type, "disabled");
  assertEquals(body.tool_choice?.type, "any", "forced tool choice is preserved (finalize invariants)");
  assertEquals(body.tool_choice?.disable_parallel_tool_use, true, "serial tool calls");
  assert(Array.isArray(body.tools) && body.tools.length === 1);
});

Deno.test("usage maps into four billable buckets; cache reads are not double-billed as input", async () => {
  const net = fakeFetch(() => json(200, OK_BODY));
  const anthropic = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: net.f });
  const r = await generateText({ model: anthropic("claude-sonnet-5"), prompt: "hi" });
  const u = extractAnthropicUsage(r.usage, r.providerMetadata);
  assertEquals(u, { input: 10, output: 5, cacheRead: 2000, cacheWrite: 100, totalInput: 2110 });
  // index.ts reads `usage` alone (onStepFinish's pinned signature has no providerMetadata), so the
  // SDK's own usage object must carry every bucket.
  assertEquals(extractAnthropicUsage(r.usage), u);
  // 10*2 + 5*10 + 2000*0.2 + 100*2.5 = 20 + 50 + 400 + 250 = 720
  assertEquals(stepCostMicroUsd("claude-sonnet-5", u), 720);
  // Had the SDK total (2110) been billed as input on top of the cache buckets it would be 4,720.
  assert(stepCostMicroUsd("claude-sonnet-5", u) < 1000);
});

Deno.test("credit-exhausted 400 is terminal: sent exactly once, never retried, classified", async () => {
  const net = fakeFetch(() =>
    json(400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
    })
  );
  const anthropic = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: net.f });
  let caught: unknown;
  try {
    await generateText({ model: anthropic("claude-sonnet-5"), prompt: "hi" }); // SDK default maxRetries = 2
  } catch (e) {
    caught = e;
  }
  assert(APICallError.isInstance(caught), "surfaces as an APICallError");
  assertEquals(net.calls(), 1, "a 400 credit failure must not be retried");
  const f = classifyAnthropicError(caught);
  assertEquals(f.kind, "credit_exhausted");
  assertEquals(f.retryable, false);
  assertEquals(f.operatorActionRequired, true);
  assertStringIncludes(f.message, "not retried or moved to another provider");
  assert(!f.message.includes("sk-ant"), "message is fixed text, never a body echo");
});

Deno.test("429 is retried a BOUNDED number of times (honouring retry-after) then surfaces as rate_limited", async () => {
  const net = fakeFetch(() =>
    json(429, { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }, { "retry-after-ms": "1" })
  );
  const anthropic = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: net.f });
  let caught: unknown;
  try {
    await generateText({ model: anthropic("claude-sonnet-5"), prompt: "hi" });
  } catch (e) {
    caught = e;
  }
  assertEquals(net.calls(), 3, "1 attempt + the SDK's 2 bounded retries");
  assertEquals(classifyAnthropicError(caught).kind, "rate_limited");
  assertEquals(classifyAnthropicError(caught).retryable, true);
});

Deno.test("classifyAnthropicError maps the documented status classes", () => {
  const mk = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
  assertEquals(classifyAnthropicError(mk(401, "invalid x-api-key")).kind, "auth_failed");
  assertEquals(classifyAnthropicError(mk(403, "permission_error")).kind, "permission_denied");
  assertEquals(classifyAnthropicError(mk(402, "payment required")).kind, "credit_exhausted");
  assertEquals(classifyAnthropicError(mk(429, "slow down")).kind, "rate_limited");
  assertEquals(classifyAnthropicError(mk(529, "Overloaded")).kind, "overloaded");
  assertEquals(classifyAnthropicError(mk(503, "unavailable")).kind, "server_error");
  assertEquals(classifyAnthropicError(mk(400, "prompt is too long: 1200000 tokens")).kind, "context_overflow");
  assertEquals(classifyAnthropicError(mk(400, "tool_choice: type \"tool\" and \"any\" are not supported for this model.")).kind, "invalid_request");
  // Credit text wins over the generic-400 branch even though Anthropic sends it as a 400.
  assertEquals(classifyAnthropicError(mk(400, "Your credit balance is too low")).kind, "credit_exhausted");
  assertEquals(classifyAnthropicError(new Error("boom")).kind, "unknown");
});

Deno.test("hard per-run budget trips on input tokens or cost, and not before", () => {
  const limits = { maxInputTokens: 1000, maxCostMicroUsd: 500 };
  assertEquals(runBudgetExhausted({ inputTokens: 999, costMicroUsd: 499 }, limits).exhausted, false);
  assertEquals(runBudgetExhausted({ inputTokens: 1000, costMicroUsd: 0 }, limits), { exhausted: true, reason: "input_tokens" });
  assertEquals(runBudgetExhausted({ inputTokens: 1, costMicroUsd: 500 }, limits), { exhausted: true, reason: "cost" });
});

Deno.test("/health check reports config + model, and can never leak the key", () => {
  const key = "sk-ant-api03-SECRETSECRETSECRETSECRET";
  const h = anthropicOrchestratorHealth({
    keyPresent: true, pin: "anthropic", selectedProvider: "anthropic",
    modelId: "claude-sonnet-5", modelSource: "default", thinking: "disabled", effort: null,
    limits: { maxInputTokens: 1_500_000, maxCostMicroUsd: 2_000_000 },
  });
  const out = JSON.stringify(h);
  assert(!out.includes(key) && !out.includes("sk-ant"));
  assertEquals(h.ok, true);
  assertEquals(h.selected, true);
  assertEquals(h.model_id, "claude-sonnet-5");
});

Deno.test("wiring: the Anthropic path can never fail over, and the budget feeds the finalize machine", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // useFallback has no Anthropic arm: the chain ends in `: false`, so no preflight/pivot applies.
  assert(/deepseekIsPrimary\s*\n\s*\? \(!DEEPSEEK_API_KEY \|\| deepseekWouldOverflow\)\s*\n\s*: false;/.test(src));
  assertStringIncludes(src, "const anthropicActive = anthropicIsPrimary && !useFallback;");
  assertStringIncludes(src, "|| stepCapDue || anthropicBudget.exhausted");
  assertStringIncludes(src, "anthropicBudgetStatus().exhausted");
});
