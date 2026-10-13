// history_label_test.ts — earlier assistant turns are labeled HISTORICAL MODEL OUTPUT.
//
// MITIGATION of authority escalation, not a report-integrity fix. Verifies the label
// (a) lands only on text of completed prior assistant turns, (b) never touches tool
// parts, the current turn or tool-call/result pairing, and (c) SURVIVES the real prompt
// trimming: the real `truncateStr` at every cap index.ts applies, the real
// `capTotalToBudget`, and the real `sanitizeModelMessages`. Synthetic values only.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { convertToModelMessages, type ModelMessage } from "npm:ai@6";
import { HISTORICAL_OUTPUT_LABEL, labelHistoricalAssistantText } from "./lib/history-label.ts";
import { RECENT_WINDOW, TOTAL_PROMPT_CHAR_BUDGET, capTotalToBudget, elideAssistantText, truncateStr } from "./orchestrator-budget.ts";
import { sanitizeModelMessages } from "./message-sanitize.ts";

const SWITCH = "MEMORY_AUTHORITY_WORDING_DISABLED";
async function withSwitch<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(SWITCH);
  if (value === undefined) Deno.env.delete(SWITCH); else Deno.env.set(SWITCH, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(SWITCH); else Deno.env.set(SWITCH, prev);
  }
}

const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] }) as ModelMessage;
const assistant = (text: string, callId?: string): ModelMessage => ({
  role: "assistant",
  content: [
    { type: "text", text },
    ...(callId ? [{ type: "tool-call", toolCallId: callId, toolName: "whois_lookup", input: { domain: "example.test" } }] : []),
  ],
}) as ModelMessage;
const toolResult = (callId: string, size = 200): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: callId, toolName: "whois_lookup", output: { type: "json", value: { blob: "x".repeat(size) } } }],
}) as ModelMessage;

const textsOf = (m: ModelMessage): string[] =>
  Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text ?? "") : [];

function pairing(msgs: ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = []; const results: string[] = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p.type === "tool-call" && p.toolCallId) calls.push(p.toolCallId);
      if (p.type === "tool-result" && p.toolCallId) results.push(p.toolCallId);
    }
  }
  return { calls: calls.sort(), results: results.sort() };
}

Deno.test("labels text of completed prior assistant turns only; everything else is the same object", async () => {
  await withSwitch(undefined, () => {
    const u1 = user("seed one"); const a1 = assistant("report one", "c1"); const t1 = toolResult("c1");
    const a2 = assistant("report two"); const u2 = user("follow up");
    const input = [u1, a1, t1, a2, u2];
    const before = JSON.stringify(input);
    const out = labelHistoricalAssistantText(input);

    assertEquals(JSON.stringify(input), before, "input must not be mutated");
    assertEquals(textsOf(out[1])[0], HISTORICAL_OUTPUT_LABEL + "report one");
    assertEquals(textsOf(out[3])[0], HISTORICAL_OUTPUT_LABEL + "report two");
    assert(out[0] === u1 && out[2] === t1 && out[4] === u2, "user and tool messages are untouched (same objects)");
    // The tool-call part inside the labeled assistant message is byte-identical.
    const callPart = (out[1].content as Array<Record<string, unknown>>)[1];
    assertEquals(callPart, (a1.content as Array<Record<string, unknown>>)[1]);
    assertEquals(pairing(out), pairing(input));
  });
});

Deno.test("the CURRENT turn is never labeled (an assistant message after the last user message)", async () => {
  await withSwitch(undefined, () => {
    const input = [user("one"), assistant("done"), user("two"), assistant("in progress", "c9")];
    const out = labelHistoricalAssistantText(input);
    assertEquals(textsOf(out[1])[0], HISTORICAL_OUTPUT_LABEL + "done");
    assert(out[3] === input[3], "assistant content after the last user message is the current turn");
  });
});

Deno.test("idempotent; string content handled; empty text and no-user inputs are left alone", async () => {
  await withSwitch(undefined, () => {
    const input = [user("a"), assistant("x"), user("b")];
    const once = labelHistoricalAssistantText(input);
    const twice = labelHistoricalAssistantText(once);
    assertEquals(JSON.stringify(twice), JSON.stringify(once));
    assert(twice[1] === once[1], "an already-labeled message is returned as-is");

    const str = labelHistoricalAssistantText([user("a"), { role: "assistant", content: "plain string" } as ModelMessage, user("b")]);
    assertEquals(str[1].content, HISTORICAL_OUTPUT_LABEL + "plain string");

    const empty = [user("a"), { role: "assistant", content: [{ type: "text", text: "" }] } as ModelMessage, user("b")];
    assert(labelHistoricalAssistantText(empty)[1] === empty[1]);

    const noUser = [assistant("lonely")];
    assert(labelHistoricalAssistantText(noUser)[0] === noUser[0]);
  });
});

Deno.test("kill switch: messages come back untouched", async () => {
  await withSwitch("true", () => {
    const input = [user("a"), assistant("x"), user("b")];
    const out = labelHistoricalAssistantText(input);
    assert(out[1] === input[1]);
    assertFalse(JSON.stringify(out).includes("HISTORICAL MODEL OUTPUT"));
  });
});

Deno.test("SURVIVES real trimming: the real truncateStr at every cap the orchestrator applies", async () => {
  await withSwitch(undefined, () => {
    const long = labelHistoricalAssistantText([user("a"), assistant("y".repeat(30_000)), user("b")]);
    const text = textsOf(long[1])[0];
    // 16000/4000 = initial history trim (recent/old); 12000/1500 = per-step trim (recent/old).
    for (const cap of [16_000, 4_000, 12_000, 1_500]) {
      const t = truncateStr(text, cap);
      assert(t.startsWith(HISTORICAL_OUTPUT_LABEL), `label lost at cap ${cap}`);
      assert(t.length < text.length);
    }
    assert(HISTORICAL_OUTPUT_LABEL.length < 300, "label must stay far below the smallest cap (1500)");
  });
});

Deno.test("SURVIVES real budget trimming + sanitizing; pairing and the current turn are unchanged", async () => {
  await withSwitch(undefined, () => {
    // 14 completed turns, each with a big tool result, so capTotalToBudget really has to elide.
    const history: ModelMessage[] = [];
    for (let i = 0; i < 14; i++) {
      history.push(user(`seed ${i}`), assistant(`narrative ${i}`, `c${i}`), toolResult(`c${i}`, 30_000));
    }
    const last = user("current question");
    history.push(last);
    const total = JSON.stringify(history).length;
    assert(total > TOTAL_PROMPT_CHAR_BUDGET, "fixture must exceed the real budget so elision actually happens");

    const labeled = labelHistoricalAssistantText(history);
    const capped = capTotalToBudget(labeled, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, true);
    const sanitized = sanitizeModelMessages(capped);

    assert(JSON.stringify(capped).length < total, "the real cap must have elided something");
    for (const out of [capped, sanitized]) {
      const assistants = out.filter((m) => m.role === "assistant");
      assertEquals(assistants.length, 14);
      for (const m of assistants) assert(textsOf(m)[0].startsWith(HISTORICAL_OUTPUT_LABEL), "label lost after real trimming");
      const p = pairing(out);
      assertEquals(p.calls, p.results, "tool-call / tool-result pairing must be intact");
      assertEquals(JSON.stringify(out[out.length - 1]), JSON.stringify(last), "the current turn must be unchanged");
    }
  });
});

Deno.test("elision is BYTE-IDENTICAL to the previous behaviour for text without the label", () => {
  assertEquals(elideAssistantText("a".repeat(500)), "a".repeat(200) + " …[elided]");
  assertEquals(elideAssistantText("a".repeat(201)), "a".repeat(200) + " …[elided]");
  assertEquals(elideAssistantText("a".repeat(200)), null);
  assertEquals(elideAssistantText(""), null);
});

Deno.test("elision keeps the label INTACT and still keeps 200 chars of narrative", () => {
  const body = "n".repeat(500);
  const cut = elideAssistantText(HISTORICAL_OUTPUT_LABEL + body)!;
  assertEquals(cut, HISTORICAL_OUTPUT_LABEL + "n".repeat(200) + " …[elided]");
  assertEquals(elideAssistantText(HISTORICAL_OUTPUT_LABEL + "n".repeat(200)), null, "a labeled text with <=200 chars of narrative needs no elision");
});

Deno.test("SURVIVES pass 2 (the protected recent window is compacted too): label intact where text is cut", async () => {
  await withSwitch(undefined, () => {
    // Five fat recent turns: pass 1 cannot get under budget alone, so pass 2 summarizes the window.
    const history: ModelMessage[] = [];
    for (let i = 0; i < 5; i++) history.push(user(`seed ${i}`), assistant(`narrative ${i} ` + "z".repeat(3000), `p${i}`), toolResult(`p${i}`, 120_000));
    const last = user("current");
    history.push(last);
    const labeled = labelHistoricalAssistantText(history);
    const capped = capTotalToBudget(labeled, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, true);
    const assistants = capped.filter((m) => m.role === "assistant");
    assertEquals(assistants.length, 5);
    let cutSeen = 0;
    for (const m of assistants) {
      const t = textsOf(m)[0];
      assert(t.startsWith(HISTORICAL_OUTPUT_LABEL), "label lost during compaction");
      if (t.endsWith(" …[elided]")) cutSeen++;
    }
    assert(cutSeen > 0, "fixture must actually exercise the text-cut path");
    const p = pairing(capped);
    assertEquals(p.calls, p.results);
    assertEquals(JSON.stringify(capped[capped.length - 1]), JSON.stringify(last));
  });
});

Deno.test("real convertToModelMessages → label: a UI history with a tool part keeps its call/result pair", async () => {
  await withSwitch(undefined, async () => {
    const ui = [
      { id: "1", role: "user", parts: [{ type: "text", text: "example.test" }] },
      {
        id: "2", role: "assistant",
        parts: [
          { type: "text", text: "Findings: synthetic." },
          { type: "tool-whois_lookup", toolCallId: "call-1", state: "output-available", input: { domain: "example.test" }, output: { ok: true } },
        ],
      },
      { id: "3", role: "user", parts: [{ type: "text", text: "continue" }] },
    ];
    const converted = await convertToModelMessages(ui as never);
    const out = labelHistoricalAssistantText(converted);
    const asst = out.find((m) => m.role === "assistant")!;
    assert(textsOf(asst)[0].startsWith(HISTORICAL_OUTPUT_LABEL));
    const p = pairing(out);
    assertEquals(p.calls, ["call-1"]);
    assertEquals(p.results, ["call-1"]);
    assertEquals(JSON.stringify(out[out.length - 1]), JSON.stringify(converted[converted.length - 1]));
  });
});

Deno.test("WIRING (source assertion): the label is applied right after conversion, BEFORE the trim, and index.ts uses the shared head-preserving truncateStr", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const labelAt = src.indexOf("labelHistoricalAssistantText(await convertToModelMessages(messages))");
  const trimAt = src.indexOf("let trimmedMessages: ModelMessage[] =");
  assert(labelAt > 0 && trimAt > labelAt, "label must precede the trim map");
  assertFalse(/const truncateStr = /.test(src), "index.ts must not keep a private copy of truncateStr");
  assertStringIncludes(src, "truncateStr(part.text, isRecent ? 16000 : 4000)");
  assertStringIncludes(src, "truncateStr(part.text, isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS)");
  // The helper keeps the HEAD (this is what lets a head label survive).
  assertEquals(truncateStr("abcdef", 3).startsWith("abc"), true);
});
