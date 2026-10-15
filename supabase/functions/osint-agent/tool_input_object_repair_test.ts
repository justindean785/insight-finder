// tool_input_object_repair_test.ts — a replayed tool call must always carry an OBJECT input.
//
// Production, 2026-10-14 (orchestrator_invocations): the Anthropic orchestrator ran 19 clean
// runs, then 11 runs died on the provider's first request with
//   messages.51.content.1.tool_use.input: Input should be an object [HTTP 400 invalid_request_error]
//
// Root cause, driven below through the REAL SDK path rather than re-described:
//   1. A tool call whose input never parsed (e.g. a `record_artifacts` call whose JSON was cut
//      off at the output cap) becomes an `invalid` tool call. Persisted as a UI tool part it is
//      `state: "output-error"`, `input: undefined`, `rawInput: "<the raw text>"`.
//   2. On the next request `convertToModelMessages` rebuilds the assistant `tool-call` with
//      `input: part.input ?? part.rawInput` — the RAW STRING.
//   3. The AI SDK's ModelMessage schema types `input` as unknown, so nothing client-side objects,
//      and `@ai-sdk/anthropic` copies it verbatim into `tool_use.input`. Anthropic rejects the
//      whole request, every request, so the thread can never run again. OpenAI-compatible
//      providers (GLM at api.z.ai) re-serialize it into `arguments` and carry on, which is why
//      the old pins never hit it.
//
// The fix lives in sanitizeModelMessages, which runs before EVERY model call (the initial
// prompt and every prepareStep branch).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { convertToModelMessages, generateText, type ModelMessage, type UIMessage } from "npm:ai@6";
import { createAnthropic } from "npm:@ai-sdk/anthropic@3";
import {
  coerceToolCallInput,
  sanitizeModelMessages,
  toolInputObjectRepairDisabled,
  toolInputObjectRepairSelfTest,
} from "./message-sanitize.ts";
import { handleHealthProbe } from "./health-handler.ts";

const SWITCH = "TOOL_INPUT_OBJECT_REPAIR_DISABLED";

// A record_artifacts call cut off mid-JSON, the shape the measured runs carried (~9.8k chars).
const TRUNCATED_RAW = '{"artifacts":[{"kind":"email","value":"probe@example.invalid","confidence":60},' +
  '{"kind":"username","value":"probe_handle","conf';
const ERROR_TEXT = "Invalid input for tool record_artifacts: JSON parsing failed";

/** The UI-message history a prior invocation persists after an invalid tool call. */
function historyWithInvalidCall(): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "investigate probe@example.invalid" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Recording what I have." },
        {
          type: "tool-record_artifacts",
          toolCallId: "toolu_bad",
          state: "output-error",
          input: undefined,
          rawInput: TRUNCATED_RAW,
          errorText: ERROR_TEXT,
        },
      ],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "continue" }] },
  ] as unknown as UIMessage[];
}

type Part = { type?: string; input?: unknown; toolCallId?: string; output?: unknown };
const toolCallsOf = (msgs: ModelMessage[]): Part[] =>
  msgs.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? (m.content as Part[]) : []))
    .filter((p) => p.type === "tool-call");

const OK_BODY = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

/** Send `messages` through the real @ai-sdk/anthropic provider; return the wire body it built. */
async function anthropicWireBody(messages: ModelMessage[]) {
  const seen: Array<Record<string, unknown>> = [];
  const f = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(new Response(JSON.stringify(OK_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;
  const anthropic = createAnthropic({ apiKey: "sk-ant-test-key-0000000000000000", fetch: f });
  await generateText({ model: anthropic("claude-sonnet-5"), messages, maxRetries: 0 });
  assertEquals(seen.length, 1);
  const body = seen[0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const blocks = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  return {
    toolUses: blocks.filter((b) => b.type === "tool_use"),
    toolResults: blocks.filter((b) => b.type === "tool_result"),
  };
}

function withSwitch<T>(value: string | null, fn: () => T): T {
  const prev = Deno.env.get(SWITCH);
  if (value === null) Deno.env.delete(SWITCH);
  else Deno.env.set(SWITCH, value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete(SWITCH);
    else Deno.env.set(SWITCH, prev);
  }
}

// ---------------------------------------------------------------------------
// REPRODUCTION — the shape that 400s at Anthropic, through the real SDK path.
// ---------------------------------------------------------------------------

Deno.test("REPRO: an invalid tool call replays as a STRING input, and Anthropic's wire body carries it verbatim", async () => {
  const model = await convertToModelMessages(historyWithInvalidCall());
  const [call] = toolCallsOf(model);
  assertEquals(typeof call.input, "string", "convertToModelMessages rebuilds the call from rawInput");
  assertEquals(call.input, TRUNCATED_RAW);

  // What the provider sends without the repair: tool_use.input is a string. That is the
  // exact field Anthropic answers with `tool_use.input: Input should be an object` (400).
  const raw = await withSwitch("true", async () => await anthropicWireBody(sanitizeModelMessages(model)));
  assertEquals(raw.toolUses.length, 1);
  assertEquals(typeof raw.toolUses[0].input, "string", "kill switch on = the pre-fix wire shape");
});

Deno.test("FIX: the sanitized history puts an OBJECT in tool_use.input and keeps the failure result", async () => {
  const model = await convertToModelMessages(historyWithInvalidCall());
  const fixed = await withSwitch(null, async () => await anthropicWireBody(sanitizeModelMessages(model)));
  assertEquals(fixed.toolUses.length, 1);
  const input = fixed.toolUses[0].input;
  assert(input !== null && typeof input === "object" && !Array.isArray(input), "tool_use.input must be an object");
  assertEquals(input, { _unparsed_input_chars: TRUNCATED_RAW.length });
  assertEquals(JSON.stringify(input).includes("probe"), false, "no raw value is echoed into the marker");

  // The paired tool_result still says the call FAILED, with the original error text.
  assertEquals(fixed.toolResults.length, 1);
  assertEquals(fixed.toolResults[0].tool_use_id, "toolu_bad");
  assertEquals(fixed.toolResults[0].is_error, true);
  assert(JSON.stringify(fixed.toolResults[0].content).includes(ERROR_TEXT));
});

// ---------------------------------------------------------------------------
// Unit behaviour
// ---------------------------------------------------------------------------

const assistantCall = (input: unknown, id = "c1"): ModelMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "record_artifacts", input }] },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "record_artifacts", output: { type: "error-text", value: ERROR_TEXT } }],
  },
] as unknown as ModelMessage[];

Deno.test("valid object inputs are untouched (same object, no log)", () => {
  const input = { artifacts: [{ kind: "email", value: "x@example.invalid" }] };
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const out = withSwitch(null, () => sanitizeModelMessages(assistantCall(input)));
    const [call] = toolCallsOf(out);
    assert(call.input === input, "a valid object input must pass through by reference");
    assertEquals(warned, 0, "nothing repaired => nothing logged");
  } finally {
    console.warn = warn;
  }
});

Deno.test("a string that parses to an object is recovered as that object", () => {
  const out = withSwitch(null, () => sanitizeModelMessages(assistantCall('{"handle":"probe_handle"}')));
  assertEquals(toolCallsOf(out)[0].input, { handle: "probe_handle" });
});

Deno.test("every non-object input becomes a small value-free object", () => {
  const c = (v: unknown) => {
    const r = coerceToolCallInput(v);
    return { input: r.input, repaired: r.repaired };
  };
  assertEquals(c(undefined), { input: {}, repaired: true });
  assertEquals(c(null), { input: {}, repaired: true });
  assertEquals(c("   "), { input: {}, repaired: true });
  assertEquals(c("not json"), { input: { _unparsed_input_chars: 8 }, repaired: true });
  assertEquals(c('"a string"'), { input: { _unparsed_input_chars: 10 }, repaired: true });
  assertEquals(c("[1,2]"), { input: { _unparsed_input_chars: 5 }, repaired: true });
  assertEquals(c([1, 2]), { input: { _non_object_input: "array" }, repaired: true });
  assertEquals(c(42), { input: { _non_object_input: "number" }, repaired: true });
  const obj = { a: 1 };
  const r = coerceToolCallInput(obj);
  assert(r.input === obj && r.repaired === false);
});

Deno.test("the repair logs one value-free event per sanitize that changed something", () => {
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (s: unknown) => { lines.push(String(s)); };
  try {
    withSwitch(null, () => sanitizeModelMessages(assistantCall(TRUNCATED_RAW)));
  } finally {
    console.warn = warn;
  }
  const ev = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e?.event === "tool_input_object_repair");
  assert(ev, "tool_input_object_repair must be logged");
  assertEquals(ev.repaired_calls, 1);
  assertEquals(ev.kinds, { text: 1 });
  assertEquals(lines.join("").includes("probe"), false, "no input value in the log");
});

Deno.test("kill switch TOOL_INPUT_OBJECT_REPAIR_DISABLED=true restores the old pass-through, read at call time", () => {
  withSwitch("true", () => {
    assertEquals(toolInputObjectRepairDisabled(), true);
    assertEquals(toolCallsOf(sanitizeModelMessages(assistantCall(TRUNCATED_RAW)))[0].input, TRUNCATED_RAW);
  });
  withSwitch(null, () => {
    assertEquals(toolInputObjectRepairDisabled(), false);
    assertEquals(toolCallsOf(sanitizeModelMessages(assistantCall(TRUNCATED_RAW)))[0].input, {
      _unparsed_input_chars: TRUNCATED_RAW.length,
    });
  });
});

// ---------------------------------------------------------------------------
// /health checks.tool_input_object_repair
// ---------------------------------------------------------------------------

Deno.test("self-test passes on the deployed sanitizer and FAILS on one that does not repair", () => {
  const r = toolInputObjectRepairSelfTest();
  assertEquals(r.ok, true, r.detail);
  assertEquals(toolInputObjectRepairSelfTest((m) => m).ok, false, "identity must fail");
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    toolInputObjectRepairSelfTest();
    assertEquals(warned, 0, "a /health probe must never emit tool_input_object_repair");
  } finally {
    console.warn = warn;
  }
});

Deno.test("self-test reports the kill switch without failing the code check", () => {
  withSwitch("true", () => {
    const r = toolInputObjectRepairSelfTest();
    assertEquals(r.ok, true);
    assertEquals(r.enabled, false);
    assert(r.detail.includes(SWITCH), r.detail);
  });
});

Deno.test("wiring: /health reports checks.tool_input_object_repair", async () => {
  const res = await handleHealthProbe(new Request("https://edge.test/osint-agent?health=1", { method: "GET" }));
  const body = await res.json();
  assertEquals(typeof body.checks.tool_input_object_repair, "object");
  assertEquals(body.checks.tool_input_object_repair.ok, true, body.checks.tool_input_object_repair.detail);
});
