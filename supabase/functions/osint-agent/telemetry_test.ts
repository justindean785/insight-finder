// Tests for telemetry.ts — orchestrator invocation/step telemetry.
// Covers the pure helpers directly (context sizing, tool-name extraction, stop-
// reason derivation, row builders) plus the impure recorder against a fake
// TelemetryDb (mirrors cache-sweep.ts's CacheDb fake pattern).
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInvocationRow,
  buildStepMetricRow,
  contextCharsFromMessages,
  createInvocationTelemetry,
  deriveStopReason,
  toolCallCountOf,
  uniqueToolNames,
  type TelemetryDb,
  MAX_BUFFERED_STEP_ROWS,
} from "./telemetry.ts";

// ---- contextCharsFromMessages ---------------------------------------------------

Deno.test("contextCharsFromMessages: sizes a real messages array", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  const chars = contextCharsFromMessages(messages);
  assert(chars > 0, "expected a positive char count");
});

Deno.test("contextCharsFromMessages: non-array input sizes to 0, never throws", () => {
  assertEquals(contextCharsFromMessages(null), 0);
  assertEquals(contextCharsFromMessages(undefined), 0);
  assertEquals(contextCharsFromMessages("not an array"), 0);
  assertEquals(contextCharsFromMessages({ weird: "shape" }), 0);
});

Deno.test("contextCharsFromMessages: grows with more/larger messages", () => {
  const small = contextCharsFromMessages([{ role: "user", content: "hi" }]);
  const big = contextCharsFromMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "x".repeat(5000) },
  ]);
  assert(big > small, "a larger transcript must size larger");
});

// ---- uniqueToolNames / toolCallCountOf ------------------------------------------

Deno.test("uniqueToolNames: dedupes and caps at 40", () => {
  const calls = [
    { toolName: "minimax_correlate" },
    { toolName: "minimax_correlate" },
    { toolName: "socialfetch_web_read" },
  ];
  assertEquals(uniqueToolNames(calls), ["minimax_correlate", "socialfetch_web_read"]);
});

Deno.test("uniqueToolNames: tolerates malformed entries and non-array input", () => {
  assertEquals(uniqueToolNames(null), []);
  assertEquals(uniqueToolNames([{ toolName: 123 }, {}, null, { toolName: "" }]), []);
});

Deno.test("uniqueToolNames: caps the RETURNED set at 40 distinct names", () => {
  const calls = Array.from({ length: 60 }, (_, i) => ({ toolName: `tool_${i}` }));
  assertEquals(uniqueToolNames(calls).length, 40);
});

Deno.test("toolCallCountOf: counts array length, 0 for non-array", () => {
  assertEquals(toolCallCountOf([1, 2, 3]), 3);
  assertEquals(toolCallCountOf(null), 0);
  assertEquals(toolCallCountOf(undefined), 0);
});

// ---- deriveStopReason -----------------------------------------------------------

Deno.test("deriveStopReason: stream error always wins", () => {
  assertEquals(
    deriveStopReason({ hadStreamError: true, finalizeStarted: true, lastFinishReason: "stop" }),
    "stream_error",
  );
});

Deno.test("deriveStopReason: finalize_forced when the finalize path engaged", () => {
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: true, lastFinishReason: "tool-calls" }),
    "finalize_forced",
  );
});

Deno.test("deriveStopReason: natural_stop on a clean text-only finish", () => {
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: false, lastFinishReason: "stop" }),
    "natural_stop",
  );
});

Deno.test("deriveStopReason: 'tool-calls' alone is UNKNOWN, never an invented budget cause", () => {
  // The SDK reports finishReason "tool-calls" on the last step of every
  // tool-using run, including runs that finalize normally. Mapping it to
  // budget_exhausted put a cause in the column that nothing measured.
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: false, lastFinishReason: "tool-calls" }),
    "unknown",
  );
});

Deno.test("deriveStopReason: budget_exhausted ONLY when the caller observed a ceiling fire", () => {
  assertEquals(
    deriveStopReason({
      hadStreamError: false,
      finalizeStarted: false,
      lastFinishReason: "tool-calls",
      budgetExhausted: true,
    }),
    "budget_exhausted",
  );
});

Deno.test("deriveStopReason: length_limit passthrough", () => {
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: false, lastFinishReason: "length" }),
    "length_limit",
  );
});

Deno.test("deriveStopReason: unknown for an unrecognized/missing finish reason", () => {
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: false, lastFinishReason: null }),
    "unknown",
  );
  assertEquals(
    deriveStopReason({ hadStreamError: false, finalizeStarted: false, lastFinishReason: "content-filter" }),
    "unknown",
  );
});

// ---- buildStepMetricRow ----------------------------------------------------------

Deno.test("buildStepMetricRow: builds a well-formed row from good input", () => {
  const row = buildStepMetricRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    stepNumber: 3,
    stepWallMs: 1234,
    contextChars: 5000,
    inputTokens: 100,
    outputTokens: 200,
    toolCallCount: 2,
    toolNames: ["minimax_correlate", "exa_search"],
    finishReason: "tool-calls",
  });
  assertEquals(row, {
    invocation_id: "inv-1",
    thread_id: "thread-1",
    user_id: "user-1",
    step_number: 3,
    step_wall_ms: 1234,
    context_chars: 5000,
    input_tokens: 100,
    output_tokens: 200,
    tool_call_count: 2,
    tool_names: ["minimax_correlate", "exa_search"],
    finish_reason: "tool-calls",
  });
});

Deno.test("buildStepMetricRow: degrades bad numeric input to null/0, never throws", () => {
  const row = buildStepMetricRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    stepNumber: -5,
    stepWallMs: null,
    contextChars: NaN,
    inputTokens: null,
    outputTokens: undefined as unknown as null,
    toolCallCount: -3,
    toolNames: [],
    finishReason: null,
  });
  assertEquals(row.step_number, 0);
  assertEquals(row.step_wall_ms, null);
  assertEquals(row.context_chars, null);
  assertEquals(row.input_tokens, null);
  assertEquals(row.output_tokens, null);
  assertEquals(row.tool_call_count, 0);
  assertEquals(row.finish_reason, null);
});

Deno.test("buildStepMetricRow: caps tool_names at 40 even if the caller forgot to", () => {
  const names = Array.from({ length: 100 }, (_, i) => `tool_${i}`);
  const row = buildStepMetricRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    stepNumber: 0,
    stepWallMs: 10,
    contextChars: 10,
    inputTokens: 1,
    outputTokens: 1,
    toolCallCount: 100,
    toolNames: names,
    finishReason: "stop",
  });
  assertEquals((row.tool_names as string[]).length, 40);
});

// ---- buildInvocationRow -----------------------------------------------------------

Deno.test("buildInvocationRow: builds a well-formed row and computes duration_ms", () => {
  const startedAt = 1_000_000;
  const finishedAt = 1_090_500;
  const row = buildInvocationRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt,
    finishedAt,
    stepCount: 7,
    toolCallCount: 12,
    finishReason: "stop",
    stopReason: "natural_stop",
    finalizeStarted: false,
    initialContextChars: 42_000,
    finalContextChars: 51_000,
    creditsMicroUsd: 75_350,
    errorMessage: null,
  });
  assertEquals(row.id, "inv-1");
  assertEquals(row.provider, "deepseek");
  assertEquals(row.model_id, "glm-5.2");
  assertEquals(row.duration_ms, 90_500);
  assertEquals(row.step_count, 7);
  assertEquals(row.tool_call_count, 12);
  assertEquals(row.stop_reason, "natural_stop");
  assertEquals(row.finalize_started, false);
  assertEquals(row.initial_context_chars, 42_000);
  assertEquals(row.final_context_chars, 51_000);
  assertEquals(row.credits_micro_usd, 75_350);
  assertEquals(row.error_message, null);
});

Deno.test("buildInvocationRow: redacts secrets in error_message and caps length", () => {
  const row = buildInvocationRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: 0,
    finishedAt: 100,
    stepCount: 1,
    toolCallCount: 0,
    finishReason: null,
    stopReason: "stream_error",
    finalizeStarted: false,
    initialContextChars: null,
    finalContextChars: null,
    creditsMicroUsd: null,
    errorMessage: `upstream rejected Bearer sk-abcdefghijklmnop and ${"x".repeat(600)}`,
  });
  const msg = String(row.error_message);
  assert(!msg.includes("sk-abcdefghijklmnop"), "raw secret must not survive redaction");
  assert(msg.includes("[REDACTED]"), "redaction marker must be present");
  assert(msg.length <= 500, `error_message must be capped at 500 chars, got ${msg.length}`);
});

Deno.test("buildInvocationRow: never produces a negative duration_ms", () => {
  const row = buildInvocationRow({
    invocationId: "inv-1",
    threadId: "thread-1",
    userId: "user-1",
    provider: null,
    modelId: null,
    startedAt: 1000,
    finishedAt: 500, // clock skew / bad input
    stepCount: 0,
    toolCallCount: 0,
    finishReason: null,
    stopReason: "unknown",
    finalizeStarted: false,
    initialContextChars: null,
    finalContextChars: null,
    creditsMicroUsd: null,
    errorMessage: null,
  });
  assertEquals(row.duration_ms, 0);
});

// ---- createInvocationTelemetry (impure recorder, fake DB) ------------------------

/**
 * Fake DB that ENFORCES orchestrator_step_metrics' foreign key to
 * orchestrator_invocations, exactly as Postgres does.
 *
 * The previous fake returned `{error: null}` unconditionally, so it modelled a
 * database with no constraints — which is why the suite stayed green while every
 * real step insert was being rejected for referencing a parent row that finish()
 * had not written yet. A fake that cannot fail cannot catch an ordering bug, so
 * this one rejects a child whose parent is absent, and accepts both single-row
 * and bulk-array inserts (the flush writes children in one call).
 */
function fakeDb(
  rows: { table: string; row: Record<string, unknown> }[],
  opts: { failInvocationInsert?: boolean } = {},
): TelemetryDb {
  const knownInvocationIds = new Set<string>();
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown> | Record<string, unknown>[]) {
          const batch = Array.isArray(row) ? row : [row];
          if (table === "orchestrator_invocations") {
            if (opts.failInvocationInsert) {
              return Promise.resolve({ error: { message: "simulated parent insert failure" } });
            }
            for (const r of batch) knownInvocationIds.add(String(r.id));
          }
          if (table === "orchestrator_step_metrics") {
            for (const r of batch) {
              if (!knownInvocationIds.has(String(r.invocation_id))) {
                return Promise.resolve({
                  error: {
                    message:
                      'insert or update on table "orchestrator_step_metrics" violates foreign key constraint',
                  },
                });
              }
            }
          }
          for (const r of batch) rows.push({ table, row: r });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

async function flush() {
  // registerBackground falls back to fire-and-forget when EdgeRuntime is
  // unavailable (true under `deno test`), so give the queued microtasks a turn.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

Deno.test("createInvocationTelemetry: records a step and finishes an invocation", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written),
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 40_000,
  });

  telemetry.onStepStart({ stepNumber: 0, messages: [{ role: "user", content: "seed" }] });
  telemetry.recordStepFinish({
    stepNumber: 0,
    usage: { inputTokens: 500, outputTokens: 20 },
    finishReason: "tool-calls",
    toolCalls: [{ toolName: "breach_check" }, { toolName: "oathnet_lookup" }],
  });
  await flush();

  assertEquals(telemetry.getStepCount(), 1);
  assertEquals(telemetry.getToolCallCount(), 2);
  assertEquals(telemetry.getLastFinishReason(), "tool-calls");

  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: 41_000,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: 3800,
    errorMessage: null,
  });
  await flush();

  const stepRows = written.filter((w) => w.table === "orchestrator_step_metrics");
  const invocationRows = written.filter((w) => w.table === "orchestrator_invocations");
  assertEquals(stepRows.length, 1);
  assertEquals(invocationRows.length, 1);
  assertEquals(stepRows[0].row.tool_call_count, 2);
  assertEquals(invocationRows[0].row.stop_reason, "unknown");
  assertEquals(invocationRows[0].row.step_count, 1);
  assertEquals(invocationRows[0].row.tool_call_count, 2);
});

Deno.test("createInvocationTelemetry: finish() is idempotent (second call is a no-op)", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written),
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 0,
  });
  const finishArgs = {
    finishedAt: Date.now(),
    finalContextChars: 0,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: 0,
    errorMessage: null,
  };
  telemetry.finish(finishArgs);
  telemetry.finish(finishArgs);
  await flush();
  const invocationRows = written.filter((w) => w.table === "orchestrator_invocations");
  assertEquals(invocationRows.length, 1, "a second finish() call must not write a second row");
});

Deno.test("createInvocationTelemetry: a DB insert failure is swallowed, never thrown", async () => {
  const throwingDb: TelemetryDb = {
    from() {
      return {
        insert() {
          return Promise.resolve({ error: { message: "insert failed" } });
        },
      };
    },
  };
  const telemetry = createInvocationTelemetry({
    db: throwingDb,
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 0,
  });
  // Must not throw synchronously nor reject unhandled.
  telemetry.recordStepFinish({ stepNumber: 0, toolCalls: [] });
  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: 0,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: 0,
    errorMessage: null,
  });
  await flush();
});

Deno.test("createInvocationTelemetry: step start/finish pairs by stepNumber, not call order", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written),
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 0,
  });
  telemetry.onStepStart({ stepNumber: 0, messages: [{ role: "user", content: "a" }] });
  telemetry.onStepStart({ stepNumber: 1, messages: [{ role: "user", content: "a".repeat(1000) }] });
  telemetry.recordStepFinish({ stepNumber: 1, toolCalls: [] });
  telemetry.recordStepFinish({ stepNumber: 0, toolCalls: [] });
  // Step rows are buffered until finish() writes the parent invocation — the FK
  // requires that order — so the run must be finished before they are readable.
  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: null,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: null,
    errorMessage: null,
  });
  await flush();
  const stepRows = written.filter((w) => w.table === "orchestrator_step_metrics");
  const step0 = stepRows.find((r) => r.row.step_number === 0)!;
  const step1 = stepRows.find((r) => r.row.step_number === 1)!;
  assert(
    (step1.row.context_chars as number) > (step0.row.context_chars as number),
    "step 1's larger message array must be measured against ITS OWN start context, not step 0's",
  );
});

// ---- FK ordering: the defect this file's fake DB previously could not see -------
// orchestrator_step_metrics.invocation_id references orchestrator_invocations(id).
// The recorder used to insert each step row the moment the step finished — before
// finish() had written the parent — so Postgres rejected every child on the FK and
// the recorder's catch turned each rejection into a console.warn. The table would
// have been permanently empty in production while orchestrator_invocations filled
// normally. These tests drive the real recorder against a fake that enforces the
// constraint, so the ordering is what is asserted, not a restatement of it.

Deno.test("FK ordering: step rows land, and only AFTER the parent invocation row", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written),
    threadId: "thread-fk",
    userId: "user-fk",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 1_000,
  });

  telemetry.onStepStart({ stepNumber: 0, messages: [{ role: "user", content: "seed" }] });
  telemetry.recordStepFinish({ stepNumber: 0, toolCalls: [{ toolName: "breach_check" }] });
  telemetry.onStepStart({ stepNumber: 1, messages: [{ role: "user", content: "more" }] });
  telemetry.recordStepFinish({ stepNumber: 1, toolCalls: [] });
  await flush();

  // Nothing may be written mid-run: the parent does not exist yet.
  assertEquals(
    written.length,
    0,
    "no telemetry row may be written before finish() — a child written here is an FK rejection",
  );

  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: 2_000,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: 100,
    errorMessage: null,
  });
  await flush();

  const parentIdx = written.findIndex((w) => w.table === "orchestrator_invocations");
  const stepRows = written.filter((w) => w.table === "orchestrator_step_metrics");

  assert(parentIdx >= 0, "the parent invocation row must be written");
  assertEquals(stepRows.length, 2, "both buffered step rows must land once the parent exists");
  for (const [i, w] of written.entries()) {
    if (w.table === "orchestrator_step_metrics") {
      assert(i > parentIdx, "every step row must be written after the parent invocation row");
    }
  }
  // All children point at the parent that was actually written.
  const parentId = written[parentIdx].row.id;
  for (const s of stepRows) assertEquals(s.row.invocation_id, parentId);
});

Deno.test("FK ordering: a failed parent insert drops the children instead of orphan-inserting", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written, { failInvocationInsert: true }),
    threadId: "thread-fk2",
    userId: "user-fk2",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 0,
  });

  telemetry.onStepStart({ stepNumber: 0, messages: [{ role: "user", content: "seed" }] });
  telemetry.recordStepFinish({ stepNumber: 0, toolCalls: [] });
  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: null,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: null,
    errorMessage: null,
  });
  await flush();

  assertEquals(written.length, 0, "no orphaned child insert may be attempted after the parent fails");
});

Deno.test("FK ordering: the step buffer is bounded and reports what it dropped", async () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  const telemetry = createInvocationTelemetry({
    db: fakeDb(written),
    threadId: "thread-cap",
    userId: "user-cap",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: Date.now(),
    initialContextChars: 0,
  });

  for (let i = 0; i < MAX_BUFFERED_STEP_ROWS + 25; i++) {
    telemetry.onStepStart({ stepNumber: i, messages: [] });
    telemetry.recordStepFinish({ stepNumber: i, toolCalls: [] });
  }
  telemetry.finish({
    finishedAt: Date.now(),
    finalContextChars: null,
    finalizeStarted: false,
    hadStreamError: false,
    creditsMicroUsd: null,
    errorMessage: null,
  });
  await flush();

  const stepRows = written.filter((w) => w.table === "orchestrator_step_metrics");
  assertEquals(stepRows.length, MAX_BUFFERED_STEP_ROWS, "the buffer must not grow without bound");
});
