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
  reportBudgetCeiling,
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
  // 2026-09-22: this used to assert the reference names `memory_recall` as "the
  // retrieval path". It is not a retrieval path — memory_recall reads only
  // agent_memory, and no tool reads tool_call_cache — so the assertion was
  // pinning a promise the system cannot keep. Pin its ABSENCE instead.
  assert(
    !s.includes("memory_recall"),
    "pass-1 reference must NOT promise a memory_recall retrieval that does not exist",
  );
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

Deno.test("elidedToolResultRef: names tool and size, and promises NO retrieval", () => {
  const ref = elidedToolResultRef("gemini_deep_dork", "y".repeat(1234));
  assertStringIncludes(ref, "gemini_deep_dork");
  assertStringIncludes(ref, "1234");
  // NEGATIVE CONTROL for the 2026-09-22 fix. This assertion was
  // `assertStringIncludes(ref, "memory_recall")`. That named a retrieval path
  // the product does not have: memory_recall queries only `agent_memory`
  // (tool-registry.ts) and nothing in the registry reads `tool_call_cache`, so
  // the model was told to fetch data it can never reach. Fails on any build
  // that re-adds the promise.
  assert(
    !ref.includes("memory_recall"),
    "must not advertise memory_recall — it cannot return a raw tool result",
  );
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

// ── The hard ceiling (2026-09-19) ───────────────────────────────────────────────
// The defect these pin, in one line: `keepRecent` was an EXEMPTION, so once the
// protected tail alone exceeded the budget, capTotalToBudget ran out of elidable
// messages and returned over budget reporting nothing. Measured in production:
// 68 of 779 steps (8.7%) over, peaking at 290,961 against a 220,000 budget.
// Every case below drives capTotalToBudget itself and asserts on what it returns.

/** Count tool-call ids and tool-result ids so pairing can be checked structurally. */
function pairing(msgs: ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p?.type === "tool-call" && typeof p.toolCallId === "string") calls.push(p.toolCallId);
      if (p?.type === "tool-result" && typeof p.toolCallId === "string") results.push(p.toolCallId);
    }
  }
  return { calls, results };
}

Deno.test("capTotalToBudget: a protected tail that alone exceeds the budget is still brought under it", () => {
  // Eight recent messages of ~40k each = ~320k, with RECENT_WINDOW=8 every one of
  // them is inside the protected tail. Nothing outside it to elide.
  const msgs = Array.from({ length: RECENT_WINDOW }, (_, i) => bigToolMessage(i, 40_000));
  assert(
    approxMsgChars(msgs) > TOTAL_PROMPT_CHAR_BUDGET,
    "fixture must start over budget or it proves nothing",
  );
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
  assert(
    approxMsgChars(out) <= TOTAL_PROMPT_CHAR_BUDGET,
    `budget must be a ceiling, got ${approxMsgChars(out)} > ${TOTAL_PROMPT_CHAR_BUDGET}`,
  );
});

Deno.test("capTotalToBudget: one message larger than the entire budget is still bounded", () => {
  // The real shape: thread a8643383 carried a single persisted assistant message of
  // 99,887 chars. This is the pathological version of it.
  const msgs = [bigToolMessage(0, TOTAL_PROMPT_CHAR_BUDGET * 2)];
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
  assert(
    approxMsgChars(out) <= TOTAL_PROMPT_CHAR_BUDGET,
    `single oversized message must be elided, got ${approxMsgChars(out)}`,
  );
  assertEquals(out.length, 1, "a message is never dropped — that would sever tool pairing");
});

Deno.test("capTotalToBudget: eliding into the recent window preserves every part and the output discriminator", () => {
  const msgs: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool-call", toolCallId: "call_0", toolName: "tool_0", input: { q: "x" } },
      ],
    } as unknown as ModelMessage,
    bigToolMessage(0, 150_000),
    bigToolMessage(1, 150_000),
  ];
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
  assert(approxMsgChars(out) <= TOTAL_PROMPT_CHAR_BUDGET, "must be under budget");
  assertEquals(out.length, msgs.length, "no message dropped");

  const before = pairing(msgs);
  const after = pairing(out);
  assertEquals(after.calls, before.calls, "every tool-call survives");
  assertEquals(after.results, before.results, "every tool-result survives — pairing intact");

  // The AI SDK validates output against a typed union; a bare { value } aborts the run.
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (p?.type !== "tool-result") continue;
      const output = p.output as Record<string, unknown>;
      assertEquals(output.type, "json", "the output discriminator must survive elision");
      assert("value" in output, "the output must still carry a value");
    }
  }
  // And the elision is the documented reference, not a silent truncation.
  const elided = out.find((m) =>
    Array.isArray(m.content) &&
    (m.content as Array<Record<string, unknown>>).some((p) =>
      p?.type === "tool-result" &&
      typeof ((p.output as Record<string, unknown>)?.value) === "string"
    )
  );
  assert(elided, "at least one tool-result was elided to a reference");
});

Deno.test("capTotalToBudget: an array already under budget is returned unchanged", () => {
  const msgs = [bigToolMessage(0, 100), bigToolMessage(1, 100)];
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW);
  assertEquals(
    JSON.stringify(out),
    JSON.stringify(msgs),
    "the common path must be byte-identical — this fix changes nothing for a normal run",
  );
});

Deno.test("capTotalToBudget: the kill switch restores the old tail-exempt behaviour", () => {
  const msgs = Array.from({ length: RECENT_WINDOW }, (_, i) => bigToolMessage(i, 40_000));
  const off = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, false);
  assert(
    approxMsgChars(off) > TOTAL_PROMPT_CHAR_BUDGET,
    "with the ceiling disabled the protected tail is exempt again, exactly as before the fix",
  );
  const on = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, true);
  assert(approxMsgChars(on) <= TOTAL_PROMPT_CHAR_BUDGET, "and ON it is a ceiling");
});

Deno.test("reportBudgetCeiling: reports the overage rather than letting it pass silently", () => {
  const under = [bigToolMessage(0, 100)];
  assertEquals(reportBudgetCeiling(under, TOTAL_PROMPT_CHAR_BUDGET, "test"), 0);

  // Elision cannot shrink message SCAFFOLDING: enough already-minimal messages still
  // exceed any budget. That is the honest limit of the ceiling, and it must be said
  // out loud rather than returned quietly over budget.
  const many = Array.from({ length: 400 }, (_, i) => bigToolMessage(i, 10));
  const tiny = 1_000;
  const out = capTotalToBudget(many, tiny, RECENT_WINDOW);
  const over = reportBudgetCeiling(out, tiny, "test");
  assert(over > 0, "an unmeetable ceiling is reported, not hidden");
});

// ---- 2026-09-22: pass 2 must not destroy UNCONSUMED evidence ----------------
//
// #604 made the char budget a hard ceiling by letting elision continue into the
// protected recent window. That window's last message, in `prepareStep`, is the
// tool result of the call that JUST completed — the model has not read it yet.
// Replacing it with a bare reference destroyed evidence the run still needed,
// and the reference named a `memory_recall` retrieval path that does not exist,
// so nothing was recoverable. Pass 2 now SUMMARIZES, preserving pivot selectors.
//
// Every test below is a negative control: each one fails against the pass-2
// implementation that shipped in #604.

/** A fresh tool result carrying pivot selectors inside a large payload. */
function freshResultMessage(id: string, selectors: string[], padChars: number): ModelMessage {
  return {
    role: "tool",
    content: selectors.map((sel, i) => ({
      type: "tool-result",
      toolCallId: `${id}_${i}`,
      toolName: "breach_check",
      output: {
        type: "json",
        value: { hit: sel, note: "z".repeat(padChars), source: `https://example-${i}.test/report` },
      },
    })),
  } as unknown as ModelMessage;
}

/**
 * An assistant tool-CALL message. Its `input` is NON-ELIDABLE — neither pass
 * touches `tool-call` parts, and nothing else in the pipeline trims them — so a
 * long enough run of these is a hard floor under the prompt size. This is the
 * real production trigger for pass 2, not an exotic fan-out.
 */
function toolCallMessage(i: number, inputChars: number): ModelMessage {
  return {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: `call_${i}`,
      toolName: "username_sweep",
      input: { query: "q".repeat(inputChars) },
    }],
  } as unknown as ModelMessage;
}

/** Collect every tool-result value in a message as a string. */
function resultValues(m: ModelMessage): string[] {
  const parts = (m as unknown as { content: Array<{ type: string; output?: { value: unknown } }> }).content;
  return parts
    .filter((p) => p.type === "tool-result")
    .map((p) => (typeof p.output?.value === "string" ? p.output.value : JSON.stringify(p.output?.value)));
}

Deno.test("pass 2: the newest unconsumed result keeps its pivot selectors", () => {
  // Production-shaped: a long run whose tool-call INPUTS alone blow the budget,
  // then a just-completed fan-out the model has not read.
  const selectors = ["victim@example.com", "https://leak.example.test/dump", "203.0.113.42"];
  const msgs: ModelMessage[] = [
    ...Array.from({ length: 130 }, (_, i) => toolCallMessage(i, 2000)),
    freshResultMessage("fresh", selectors, 12_000),
  ];
  const out = capTotalToBudget(msgs, 220_000, 10);

  const newest = resultValues(out[out.length - 1]).join("\n");
  for (const sel of selectors) {
    assertStringIncludes(
      newest, sel,
      `pass 2 destroyed pivot selector ${sel} from a result the model had not read`,
    );
  }
  // And this IS compaction, not a no-op. Note the summary deliberately keeps a
  // HEAD SNIPPET of the raw payload, so asserting the absence of padding would
  // be wrong; assert the size drop instead. 3 parts x ~12k originally.
  assert(
    newest.length < 6000,
    `tail should be compacted, not passed through (got ${newest.length} chars)`,
  );
});

Deno.test("pass 2: does not promise a retrieval path that does not exist", () => {
  const msgs: ModelMessage[] = [
    ...Array.from({ length: 130 }, (_, i) => toolCallMessage(i, 2000)),
    freshResultMessage("fresh", ["someone@example.com"], 12_000),
  ];
  const out = capTotalToBudget(msgs, 220_000, 10);
  const newest = resultValues(out[out.length - 1]).join("\n");
  assert(
    !newest.includes("memory_recall"),
    "compacted tail must not tell the model to retrieve via memory_recall",
  );
});

Deno.test("pass 2: one oversized result does not take its fan-out siblings with it", () => {
  // Eight sibling results in ONE message. Compacting a couple is enough to get
  // under budget, so the rest must survive verbatim. The shipped #604 pass 2
  // wiped every part of a message in a single call, with the budget checked only
  // once per MESSAGE — so all eight were collateral.
  const msgs: ModelMessage[] = [
    ...Array.from({ length: 40 }, (_, i) => toolCallMessage(i, 2000)),
    freshResultMessage("fan", Array.from({ length: 8 }, (_, i) => `hit${i}@example.com`), 9000),
  ];
  const out = capTotalToBudget(msgs, 120_000, 10);

  const vals = resultValues(out[out.length - 1]);
  const untouched = vals.filter((v) => v.includes("z".repeat(500))).length;
  assert(
    untouched > 0,
    `every sibling in the fan-out was compacted; at least one should survive verbatim (${vals.length} parts)`,
  );
  assert(approxMsgChars(out) <= 120_000, "and the array must still be under budget");
});

Deno.test("pass 1 still elides by reference — the two passes stay different", () => {
  // Guard against 'simplifying' the two passes back into one shared helper.
  const msgs: ModelMessage[] = Array.from({ length: 40 }, (_, i) => bigToolMessage(i, 5000));
  const out = capTotalToBudget(msgs, 80_000, 10);
  const oldest = resultValues(out[0]).join("");
  assertStringIncludes(oldest, "dropped from this transcript", "pass 1 must still use a bare reference");
});

Deno.test("capTotalToBudget: pass 2 does not mutate the caller's array", () => {
  // `out` holds SHALLOW message copies, so a naive in-place part edit would
  // reach back into the input the caller still holds.
  const msgs: ModelMessage[] = [
    ...Array.from({ length: 130 }, (_, i) => toolCallMessage(i, 2000)),
    freshResultMessage("fresh", ["keep@example.com"], 12_000),
  ];
  const before = JSON.stringify(msgs[msgs.length - 1]);
  capTotalToBudget(msgs, 220_000, 10);
  assertEquals(
    JSON.stringify(msgs[msgs.length - 1]), before,
    "input message must be unchanged after capTotalToBudget",
  );
});
