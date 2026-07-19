// orchestrator_budget_test.ts — Phase A (context + step reduction) coverage.
// Verifies the rolling context budget bounds a long run, forwards prior tool
// results BY REFERENCE (not raw, not dropped), and that the step-cap + wall-clock
// deadline knobs are live and biting.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import type { ModelMessage } from "npm:ai@6";
import {
  TOTAL_PROMPT_CHAR_BUDGET,
  RECENT_WINDOW,
  MAX_ORCHESTRATOR_STEPS,
  ORCHESTRATOR_WALL_CLOCK_MS,
  approxMsgChars,
  capUserTextToBudget,
  capTotalToBudget,
  elidedToolResultRef,
  deadlineReached,
  orchestratorStepToolChoice,
  buildIntermediateStepPlan,
  FORCE_TOOL_CALL_UNTIL_FINALIZE,
} from "./orchestrator-budget.ts";

// Build a `tool` message carrying one tool-result with a big JSON payload.
function bigToolMessage(i: number, valueChars: number): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call_${i}`,
        toolName: `tool_${i}`,
        output: { type: "json", value: { blob: "x".repeat(valueChars), i } },
      },
    ],
  } as unknown as ModelMessage;
}

Deno.test("premature-stop fix: non-finalize steps force a tool call; finalize stays auto", () => {
  // The "stops mid-investigation" bug: with toolChoice "auto", the model can end a
  // step with narration and no tool call ("Now let me run minimax_correlate…"), and
  // AI SDK v6 terminates the loop — leaving planned NEXT STEPS unrun. Non-finalize
  // steps must force a tool call so the loop can only exit via the finalize branch
  // or a budget/deadline StopCondition.
  assert(FORCE_TOOL_CALL_UNTIL_FINALIZE, "kill-switch must be ON for the fix to apply");
  assertEquals(orchestratorStepToolChoice(false), "required", "non-finalize step must force a tool call");
  // The finalize step writes the closing report (text-only) — forcing a tool call
  // there would block the report, so it must stay auto.
  assertEquals(orchestratorStepToolChoice(true), "auto", "finalize step must allow a text-only report");
});

Deno.test("capTotalToBudget: long run stays under the ceiling", () => {
  const msgs: ModelMessage[] = Array.from({ length: 40 }, (_, i) => bigToolMessage(i, 5000));
  const before = approxMsgChars(msgs);
  const budget = 80_000;
  const capped = capTotalToBudget(msgs, budget, 10);
  assert(before > budget, "fixture must start over budget to exercise elision");
  assert(
    approxMsgChars(capped) <= budget,
    `capped run must fit the budget (was ${approxMsgChars(capped)} > ${budget})`,
  );
});

Deno.test("capTotalToBudget: never drops a message (pairing preserved)", () => {
  const msgs: ModelMessage[] = Array.from({ length: 40 }, (_, i) => bigToolMessage(i, 5000));
  const capped = capTotalToBudget(msgs, 80_000, 10);
  assertEquals(capped.length, msgs.length, "message count must be unchanged");
});

Deno.test("capTotalToBudget: old tool results are forwarded BY REFERENCE, not raw", () => {
  const msgs: ModelMessage[] = Array.from({ length: 40 }, (_, i) => bigToolMessage(i, 5000));
  const capped = capTotalToBudget(msgs, 80_000, 10);
  // The oldest message's payload must be a reference+summary, not the raw blob.
  const oldest = capped[0] as unknown as { content: Array<{ output: { type: string; value: unknown } }> };
  const val = oldest.content[0].output.value;
  assertEquals(typeof val, "string", "elided output value should be a reference string");
  const s = String(val);
  assertStringIncludes(s, "tool_0", "reference must name the source tool");
  assertStringIncludes(s, "memory_recall", "reference must point at the retrieval path");
  assert(!s.includes("xxxxxxxxxx"), "raw payload must NOT survive in an elided result");
  // Discriminator preserved so the AI SDK schema still validates.
  assertEquals(oldest.content[0].output.type, "json");
});

Deno.test("capTotalToBudget: recent window is kept VERBATIM", () => {
  const msgs: ModelMessage[] = Array.from({ length: 40 }, (_, i) => bigToolMessage(i, 5000));
  const capped = capTotalToBudget(msgs, 80_000, RECENT_WINDOW);
  // The last message (well inside the recent window) must retain its raw payload.
  const recent = capped[capped.length - 1] as unknown as {
    content: Array<{ output: { value: { blob?: string } } }>
  };
  const blob = recent.content[0].output.value.blob;
  assert(typeof blob === "string" && blob.length === 5000, "recent payload must be untouched");
});

Deno.test("capTotalToBudget: no-op when already under budget", () => {
  const msgs: ModelMessage[] = [bigToolMessage(0, 100), bigToolMessage(1, 100)];
  const capped = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
  assertEquals(capped, msgs, "under-budget input must be returned unchanged (same reference)");
});

Deno.test("capUserTextToBudget: caps huge pasted user JSON", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "{" + "x".repeat(80_000) + "}" }] }] as unknown as ModelMessage[];
  const capped = capUserTextToBudget(msgs, 12_000) as unknown as Array<{ content: Array<{ text: string }> }>;
  assert(capped[0].content[0].text.length < 13_000, "huge user paste must be bounded");
  assertStringIncludes(capped[0].content[0].text, "user input truncated");
});

Deno.test("capTotalToBudget: also caps huge latest user paste", () => {
  const msgs = [
    bigToolMessage(0, 100),
    { role: "user", content: [{ type: "text", text: "[" + "x".repeat(80_000) + "]" }] },
  ] as unknown as ModelMessage[];
  const capped = capTotalToBudget(msgs, 30_000, RECENT_WINDOW);
  assert(approxMsgChars(capped) <= 30_000, "user paste must not bypass the total budget");
});

Deno.test("elidedToolResultRef: names tool, size and retrieval path", () => {
  const ref = elidedToolResultRef("gemini_deep_dork", "y".repeat(1234));
  assertStringIncludes(ref, "gemini_deep_dork");
  assertStringIncludes(ref, "1234");
  assertStringIncludes(ref, "memory_recall");
  // A missing/blank tool name degrades to a generic label, never throws.
  assertStringIncludes(elidedToolResultRef(undefined, { a: 1 }), "tool");
});

// ---- A2: step cap + wall-clock deadline are live and named ------------------
Deno.test("step cap is the named ~22 ceiling", () => {
  assertEquals(MAX_ORCHESTRATOR_STEPS, 22);
});

Deno.test("wall-clock deadline is 4 minutes and trips cleanly on elapse", () => {
  assertEquals(ORCHESTRATOR_WALL_CLOCK_MS, 4 * 60_000);
  const start = 1_000_000;
  assertEquals(deadlineReached(start, start, ORCHESTRATOR_WALL_CLOCK_MS), false);
  assertEquals(
    deadlineReached(start + ORCHESTRATOR_WALL_CLOCK_MS, start, ORCHESTRATOR_WALL_CLOCK_MS),
    false,
    "exactly at the deadline is not yet past it (strict >)",
  );
  assertEquals(
    deadlineReached(start + ORCHESTRATOR_WALL_CLOCK_MS + 1, start, ORCHESTRATOR_WALL_CLOCK_MS),
    true,
    "one ms past the deadline trips the StopCondition",
  );
});

// ---- prepareStep plan contract -----------------------------------------------
// The first cut of the premature-stop fix set toolChoice on the NORMAL
// intermediate return but missed the persistence-nudge return — i.e. the one
// branch whose entire purpose is to force `record_artifacts` could still let the
// model narrate "let me record the artifacts…" and end the run with zero evidence
// persisted (observed live: 38 tool calls, 0 record_artifacts). These tests cover
// the decision that actually reaches the SDK, not just the pure helper.

Deno.test("intermediate plan: persistence nudge restricts tools AND forces a call", () => {
  const plan = buildIntermediateStepPlan({
    nudgePersistence: true,
    normalActiveTools: ["exa_search", "jina_reader_scrape", "record_artifacts"],
  });
  assertEquals(plan.activeTools, ["record_artifacts"]);
  assertEquals(plan.toolChoice, FORCE_TOOL_CALL_UNTIL_FINALIZE ? "required" : "auto");
});

Deno.test("intermediate plan: normal step keeps its tools AND forces a call", () => {
  const tools = ["exa_search", "record_artifacts"];
  const plan = buildIntermediateStepPlan({ nudgePersistence: false, normalActiveTools: tools });
  assertEquals(plan.activeTools, tools);
  assertEquals(plan.toolChoice, FORCE_TOOL_CALL_UNTIL_FINALIZE ? "required" : "auto");
  // must be a copy — the caller's array is reused across steps
  assert(plan.activeTools !== tools);
});

/** Return-object literals in `src`, matched by brace depth. */
function returnObjectBodies(src: string): string[] {
  const out: string[] = [];
  const re = /return \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

Deno.test("CONTRACT: every prepareStep plan sets toolChoice (no narration-only exit)", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  // Every plan handed back to the AI SDK carries `messages: stepMessagesOut`.
  const plans = returnObjectBodies(src).filter((b) => /messages:\s*stepMessagesOut/.test(b));
  // finalize + persistence-nudge + normal intermediate
  assert(plans.length >= 3, `expected >=3 prepareStep plans, found ${plans.length}`);
  for (const plan of plans) {
    assert(
      /toolChoice/.test(plan) || /buildIntermediateStepPlan\(/.test(plan),
      "a prepareStep plan omits toolChoice, so it defaults to \"auto\" — the narration-only " +
        `stop bug. Route it through buildIntermediateStepPlan(). Offending plan:\n${plan.slice(0, 240)}`,
    );
  }
});
