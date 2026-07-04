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
  capTotalToBudget,
  elidedToolResultRef,
  deadlineReached,
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
