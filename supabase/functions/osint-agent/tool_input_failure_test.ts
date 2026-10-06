// tool_input_failure_test.ts — a tool call the SDK rejected on its INPUT SCHEMA is a failed tool
// call and must leave a tool_usage_log row.
//
// Measured on a live case (2026-10-06, 26 model tool calls): 3 were rejected by input validation
// (`socialfetch_lookup` sent `{query, platform}` where the schema wants `handle`; `serus_darkweb_scan`
// and `memory_save` sent wrong field names). The SDK never calls `execute` for those, so the cache
// wrapper's `logUsage` never ran: no row. The Activity tab read "23 tools · Failed 0 of 23".
//
// These tests drive the REAL AI SDK (`generateText` + a mock model) against the REAL tool schema
// behind the REAL cache wrapper, then feed the step the SDK actually produced to the logger — not a
// hand-built imitation of it. Synthetic values only (CLAUDE.md forbids real investigation PII).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateText, stepCountIs } from "npm:ai@6";
import { MockLanguageModelV3 } from "npm:ai@6/test";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { classifyToolOutcome } from "./tool-outcome.ts";
import { buildDeadTargets } from "./lib/dead-target.ts";
import {
  buildInputFailureRow,
  collectToolInputFailures,
  inputFailureMessage,
  inputFailureRowsForStep,
  toolInputFailureSelfTest,
} from "./lib/tool-input-failure.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const SWITCH = "TOOL_INPUT_FAILURE_LOG_DISABLED";
async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

function makeDb() {
  const usage: Row[] = [];
  let table = "";
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain; q.in = chain; q.order = chain; q.limit = chain; q.update = chain; q.eq = chain;
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = (r: Row) => { if (table === "tool_usage_log") usage.push(r); return Promise.resolve({ error: null }); };
  q.upsert = () => Promise.resolve({ error: null });
  const db = {
    from: (t: string) => { table = t; return q; },
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { db, usage };
}

const USAGE = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** A mock model that makes ONE tool call, then answers. */
function modelCalling(toolName: string, input: unknown) {
  let n = 0;
  return new MockLanguageModelV3({
    doGenerate: () => {
      n++;
      return Promise.resolve(
        (n === 1
          ? {
            content: [{ type: "tool-call", toolCallId: "c1", toolName, input: typeof input === "string" ? input : JSON.stringify(input) }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: USAGE, warnings: [],
          }
          : {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: USAGE, warnings: [],
          }) as never,
      );
    },
  });
}

/** The REAL socialfetch_lookup schema behind the REAL cache wrapper; returns what the SDK emitted. */
async function runStep(thread: string, toolName: string, input: unknown) {
  circuit.clearThread(thread);
  clearRuntime(thread);
  const h = makeDb();
  const ctx = {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: thread,
    archiveEnabled: false, detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
  const real = buildTools(ctx).tools as Record<string, unknown>;
  const wrapped = wrapToolsWithCache(
    { socialfetch_lookup: real.socialfetch_lookup } as never,
    { investigationId: thread, userId: `u-${thread}`, supabase: h.db, supabaseAdmin: h.db },
  );
  // The SDK's StepResult is generic over the tool set; the test only reads its toolCalls.
  const steps: Array<{ stepNumber: number; toolCalls: unknown }> = [];
  await generateText({
    model: modelCalling(toolName, input),
    tools: wrapped as never,
    stopWhen: stepCountIs(3),
    prompt: "go",
    onStepFinish: (s) => { steps.push(s); },
  });
  await new Promise((r) => setTimeout(r, 40));
  return { steps, wrapperRows: h.usage };
}

// ── the measured shape, through the real SDK ───────────────────────────────────

Deno.test("a call the SDK rejects on input schema leaves NO wrapper row — the gap — and the logger fills it", async () => {
  const { steps, wrapperRows } = await runStep("tif-a", "socialfetch_lookup", { query: "someone@example.test", platform: "tiktok" });

  assertEquals(wrapperRows.length, 0, "the wrapper never ran: this is the invisible failure");

  const first = steps[0];
  const rows = inputFailureRowsForStep(first.toolCalls, { userId: "u", threadId: "tif-a", stepNumber: first.stepNumber });
  assertEquals(rows.length, 1);
  const row = rows[0] as { tool_name: string; outcome: string; ok: boolean; error_msg: string; input_json: { runtime: Record<string, unknown> } };
  assertEquals(row.tool_name, "socialfetch_lookup");
  assertEquals(row.outcome, "failed");
  assertEquals(row.ok, false);
  assert(row.error_msg.includes("handle (invalid_type)"), row.error_msg);
  assertEquals(row.input_json.runtime.rejection_source, "sdk_input_validation");
  assertEquals(row.input_json.runtime.sent_keys, ["query", "platform"]);
});

Deno.test("the row never carries an input VALUE, and carries no `input` for dead-target memory to read", async () => {
  const { steps } = await runStep("tif-b", "socialfetch_lookup", { query: "someone@example.test", platform: "tiktok" });
  const rows = inputFailureRowsForStep(steps[0].toolCalls, { userId: "u", threadId: "tif-b", stepNumber: 0 });
  const blob = JSON.stringify(rows);
  assert(!blob.includes("someone@example.test"), "the analyst's selector must not be stored");
  assert(!blob.includes("tiktok"), "no input value of any kind is stored — key NAMES only");
  assert(!("input" in (rows[0].input_json as Record<string, unknown>)), "no `input`");

  // A malformed call says nothing about whether a TARGET is reachable: it must not count toward one.
  const dead = buildDeadTargets(
    [rows[0], { ...rows[0] }] as never,
    (i) => String((i as Record<string, unknown>).handle ?? (i as Record<string, unknown>).query ?? ""),
  );
  assertEquals([...dead.values()].reduce((a, b) => a + b, 0), 0);
});

Deno.test("a VALID call is not logged by the logger (the wrapper owns it) and the wrapper does log it", async () => {
  const { steps, wrapperRows } = await runStep("tif-c", "socialfetch_lookup", { platform: "tiktok", handle: "samplehandle" });
  assertEquals(inputFailureRowsForStep(steps[0].toolCalls, { userId: "u", threadId: "tif-c" }).length, 0);
  assert(wrapperRows.length >= 1, "control: a valid call does reach the wrapper and is logged there");
});

Deno.test("an unknown tool name is logged as unknown_tool, not as an input fault", async () => {
  const { steps } = await runStep("tif-d", "socialfetch_lookup_v2", { handle: "x" });
  const f = collectToolInputFailures(steps[0].toolCalls);
  assertEquals(f.length, 1);
  assertEquals(f[0].reason, "unknown_tool");
  assertEquals(inputFailureMessage(f[0]), "tool does not exist: socialfetch_lookup_v2");
});

Deno.test("unparsable JSON input is logged as unparsable/invalid with no values", async () => {
  const { steps } = await runStep("tif-e", "socialfetch_lookup", "{not json SECRET-VALUE");
  const rows = inputFailureRowsForStep(steps[0].toolCalls, { userId: "u", threadId: "tif-e" });
  assertEquals(rows.length, 1);
  assert(!JSON.stringify(rows).includes("SECRET-VALUE"));
});

// ── pure behaviour ─────────────────────────────────────────────────────────────

Deno.test("the error message classifies as a FAILURE (no skip/empty words) so a reclassification can't hide it", () => {
  for (const reason of ["invalid_input", "unknown_tool", "unparsable_input"] as const) {
    const msg = inputFailureMessage({ toolName: "t", reason, invalidFields: ["handle (invalid_type)"], sentKeys: [] });
    assertEquals(classifyToolOutcome(msg, null), "failed", msg);
  }
});

Deno.test("issues are bounded and field names are made log-safe", () => {
  const issues = Array.from({ length: 20 }, (_, i) => ({ code: "invalid_type", path: [`f${i}`, 0] }));
  const calls = [{
    toolName: "x".repeat(200) + "<script>", invalid: true, input: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v"])),
    error: { name: "AI_InvalidToolInputError", cause: { name: "AI_TypeValidationError", cause: { issues } } },
  }];
  const [f] = collectToolInputFailures(calls);
  assertEquals(f.invalidFields.length, 6);
  assertEquals(f.sentKeys.length, 12);
  assert(f.toolName.length <= 64 && !f.toolName.includes("<"), f.toolName);
  assert(f.invalidFields[0].startsWith("f0.0 (invalid_type)"), f.invalidFields[0]);
});

Deno.test("unrecognised keys report the invented FIELD NAMES, never values", () => {
  const [f] = collectToolInputFailures([{
    toolName: "t", invalid: true, input: { handle: "secret" },
    error: { name: "AI_InvalidToolInputError", cause: { cause: { issues: [{ code: "unrecognized_keys", keys: ["query", "platform"], path: [] }] } } },
  }]);
  assertEquals(f.invalidFields, ["unrecognized: query|platform (unrecognized_keys)"]);
});

Deno.test("garbage in never throws: non-array, null parts, parts without an error", () => {
  assertEquals(collectToolInputFailures(undefined), []);
  assertEquals(collectToolInputFailures("nope"), []);
  assertEquals(collectToolInputFailures([null, 7, {}, { invalid: true }])[0]?.toolName, "(unknown)");
});

Deno.test("a free, instant row: zero cost, zero charge, zero duration, not cached", () => {
  const row = buildInputFailureRow({ toolName: "t", reason: "invalid_input", invalidFields: [], sentKeys: [] }, { userId: "u", threadId: "th", stepNumber: 3 });
  assertEquals([row.cost_micro_usd, row.charged_micro_usd, row.duration_ms, row.cached, row.status_code], [0, 0, 0, false, null]);
  assertEquals((row.input_json as { runtime: { step: number } }).runtime.step, 3);
});

// ── kill switch, /health, wiring ───────────────────────────────────────────────

Deno.test("NEGATIVE CONTROL — kill switch: no rows are produced (the legacy, invisible behaviour)", async () => {
  const { steps } = await runStep("tif-f", "socialfetch_lookup", { query: "x", platform: "tiktok" });
  await withEnv(SWITCH, "true", () => {
    assertEquals(inputFailureRowsForStep(steps[0].toolCalls, { userId: "u", threadId: "tif-f" }), []);
    assertEquals(toolInputFailureSelfTest().detail, "LEGACY via TOOL_INPUT_FAILURE_LOG_DISABLED");
  });
  assertEquals(inputFailureRowsForStep(steps[0].toolCalls, { userId: "u", threadId: "tif-f" }).length, 1, "and back on");
});

Deno.test("/health: checks.tool_input_failure_log is wired, passes, and the self-test would catch a value leak", async () => {
  const st = toolInputFailureSelfTest();
  assertEquals(st.ok, true, st.detail);
  assert(st.detail.includes("no values"), st.detail);
  const health = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.tool_input_failure_log = toolInputFailureSelfTest()"), "health must report the proof-of-deploy key");
});

Deno.test("wiring: onStepFinish logs SDK-rejected calls, detached and best-effort, before the finalize branch", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const stepFinish = src.indexOf("onStepFinish: ({ stepNumber, usage, finishReason, toolCalls, toolResults })");
  assert(stepFinish > 0, "onStepFinish signature changed — re-point this test");
  const finalizeBranch = src.indexOf("if (finalizeStarted) {", stepFinish);
  const call = src.indexOf("inputFailureRowsForStep(toolCalls", stepFinish);
  assert(call > stepFinish && call < finalizeBranch, "the logger must run inside onStepFinish, before the finalize branch");
  const body = src.slice(call, finalizeBranch);
  assert(body.includes('from("tool_usage_log").insert('), "it must write tool_usage_log");
  assert(body.includes("waitUntil"), "it must be detached (EdgeRuntime.waitUntil), never awaited in the step");
  assert(/catch \(e\)/.test(body), "it must be wrapped so a logging fault can never fail the step");
  assert(!/\bawait\b/.test(body), "no await: it must not be able to stall the step or the finalize window");
});
