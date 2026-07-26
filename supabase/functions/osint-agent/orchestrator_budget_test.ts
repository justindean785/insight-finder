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
} from "./orchestrator-budget.ts";
// The finalize open time is (ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS); import the
// reserve so the guard below is coupled to the real constant, not a hardcoded copy of it.
import { FINALIZE_RESERVE_MS } from "./orchestrator-finalize.ts";

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

Deno.test("wall-clock deadline is the measured 180s platform ceiling; forced-finalize opens inside the isolate", () => {
  // RESOLVED 2026-07-25 against live prod (docs/ops/kill-window-measurement.sql), per
  // generation (last_heartbeat_at - run_started_at), separated by outcome/resume and with
  // the max rows inspected: HARD CEILING 180s (recovered p99 178s, max 180.0, zero >=200s);
  // killed runs die across 30-180s with p50 ~108-113s, modal 90-135s. So "180s" and
  // "~90-135s" were the MAX and the MODE of ONE distribution — not a contradiction; the
  // 90-135s-as-ceiling reading is retracted. The 240s the branch briefly set is refuted:
  // it opened forced-finalize at 240-90=150s (past the median death → never fired for most
  // kills) and its 240s clean-stop is past the 180s ceiling (never fired at all).
  assertEquals(ORCHESTRATOR_WALL_CLOCK_MS, 3 * 60_000);

  // Couple the guard to the CONSTANT, not a hardcoded 90_000: if FINALIZE_RESERVE_MS is
  // ever re-widened (it already went 45s -> 90s), this recomputes instead of silently
  // passing. Forced-finalize opens at (budget - reserve) = 90s here — below the ~108s
  // median death (so it catches the later half of kills) and above the ~60s median
  // completion of healthy runs (so it rarely hijacks a run that would self-conclude).
  const forcedFinalizeOpensMs = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
  assert(
    forcedFinalizeOpensMs < 180_000,
    `forced-finalize must open BEFORE the measured 180s isolate ceiling, else it never fires (opens at ${forcedFinalizeOpensMs}ms)`,
  );
  // MATCHED PAIR — this assertion and orchestrator_finalize_test.ts ("shouldForceFinalize
  // opens exactly at the wall-clock reserve window") pin the open time into a narrow
  // corridor, with the current value near its lower edge. Widening FINALIZE_RESERVE_MS
  // past ~90s pushes the open time back toward the modal kill window, so change the
  // budget and the reserve together and re-check against the telemetry above.
  assertEquals(forcedFinalizeOpensMs, 90_000, "current calibration opens forced-finalize at 90s");

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
