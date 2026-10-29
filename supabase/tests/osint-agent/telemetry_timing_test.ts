// Tests for the timing half of telemetry.ts (PR 2 of 2; columns from
// supabase/migrations/20261029210000_orchestrator_timing_columns.sql).
//
// WHY THIS EXISTS: duration_ms minus SUM(step_wall_ms) was 891 s unaccounted over 70
// forced-finalize runs (2026-10-29), 73% of it in 10 runs consistent with the report-
// salvage backstop — a second model call outside the step meter that nothing recorded.
// These tests pin the recorder that makes every invocation reconcilable into a timeline,
// and the privacy / rollback contracts around it.
//
// `import * as T` (not named imports) so a missing export fails ONE test with a TypeError,
// not the whole file at link time.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as T from "../../functions/osint-agent/telemetry.ts";
import type { TelemetryDb } from "../../functions/osint-agent/telemetry.ts";

type Written = { table: string; row: Record<string, unknown> };

function fakeDb(rows: Written[]): TelemetryDb {
  const known = new Set<string>();
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown> | Record<string, unknown>[]) {
          const batch = Array.isArray(row) ? row : [row];
          if (table === "orchestrator_invocations") for (const r of batch) known.add(String(r.id));
          if (table === "orchestrator_step_metrics") {
            for (const r of batch) {
              if (!known.has(String(r.invocation_id))) return Promise.resolve({ error: { message: "fk" } });
            }
          }
          for (const r of batch) rows.push({ table, row: r });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** A clock the test owns: wall and monotonic advance together, so durations are exact. */
function fakeClock() {
  let t = 0;
  const WALL0 = 1_700_000_000_000;
  const MONO0 = 5_000;
  return {
    clock: { now: () => WALL0 + t, mono: () => MONO0 + t },
    advance(ms: number) {
      t += ms;
    },
    wall0: WALL0,
  };
}

function withEnv<R>(name: string, value: string | null, fn: () => R): R {
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

function recorder(rows: Written[], c: ReturnType<typeof fakeClock>) {
  return T.createInvocationTelemetry({
    db: fakeDb(rows),
    threadId: "thread-1",
    userId: "user-1",
    provider: "deepseek",
    modelId: "glm-5.2",
    startedAt: c.clock.now(),
    initialContextChars: 40_000,
    clock: c.clock,
  } as Parameters<typeof T.createInvocationTelemetry>[0]);
}

const finishInput = (c: ReturnType<typeof fakeClock>, over: Record<string, unknown> = {}) => ({
  finishedAt: c.clock.now(),
  finalContextChars: 41_000,
  finalizeStarted: true,
  hadStreamError: false,
  creditsMicroUsd: null,
  errorMessage: null,
  ...over,
});

const NEW_INVOCATION_KEYS = [
  "first_step_offset_ms",
  "loop_end_offset_ms",
  "persist_ms",
  "salvage_ms",
  "cluster_ms",
  "unfinished_steps",
  "salvage_outcome",
];
const NEW_STEP_KEYS = ["started_offset_ms", "prepare_ms"];

/** The scenario every reconciliation test shares: two steps, a salvage, clustering. */
async function runSalvageScenario(rows: Written[], c: ReturnType<typeof fakeClock>) {
  const rec = recorder(rows, c);
  // step 0: prepareStep 40 ms, then the step runs 8 000 ms
  const prep0 = T.withPrepareTiming(async (_a: { stepNumber: number }) => {
    c.advance(40);
  }, rec);
  await prep0({ stepNumber: 0 });
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(8_000);
  rec.recordStepFinish({ stepNumber: 0, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "tool-calls", toolCalls: [{ toolName: "breach_check" }] });
  // 200 ms of untracked work, then step 1's prepareStep takes 300 ms
  c.advance(200);
  const prep1 = T.withPrepareTiming(async (_a: { stepNumber: number }) => {
    c.advance(300);
  }, rec);
  await prep1({ stepNumber: 1 });
  rec.onStepStart({ stepNumber: 1, messages: [] });
  c.advance(12_000);
  rec.recordStepFinish({ stepNumber: 1, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop", toolCalls: [] });
  c.advance(60);
  rec.markLoopEnd();
  c.advance(400);
  rec.markPersistStart();
  const salvageStart = rec.mono();
  c.advance(30_000);
  rec.recordSalvage(salvageStart, "ok");
  const clusterStart = rec.mono();
  c.advance(2_000);
  rec.recordCluster(clusterStart);
  c.advance(100);
  rec.finish(finishInput(c));
  await settle();
  return rec;
}

// ---- the timeline itself -----------------------------------------------------------

Deno.test("timing: a salvage run records offsets, persist, salvage and cluster durations", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await runSalvageScenario(rows, c);

  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.first_step_offset_ms, 40);
  assertEquals(inv.loop_end_offset_ms, 20_600);
  assertEquals(inv.persist_ms, 32_100);
  assertEquals(inv.salvage_ms, 30_000);
  assertEquals(inv.cluster_ms, 2_000);
  assertEquals(inv.unfinished_steps, 0);
  assertEquals(inv.salvage_outcome, "ok");
  assertEquals(inv.duration_ms, 53_100);

  const steps = rows.filter((w) => w.table === "orchestrator_step_metrics").map((w) => w.row);
  assertEquals(steps.map((s) => s.started_offset_ms), [40, 8_540]);
  assertEquals(steps.map((s) => s.prepare_ms), [40, 300]);
  assertEquals(steps.map((s) => s.step_wall_ms), [8_000, 12_000]);
});

Deno.test("timing: reconcileTimeline accounts for every millisecond of duration_ms", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await runSalvageScenario(rows, c);
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  const steps = rows.filter((w) => w.table === "orchestrator_step_metrics").map((w) => w.row);

  const t = T.reconcileTimeline(inv, steps)!;
  assert(t, "a timed invocation must reconcile");
  assertEquals(t.durationMs, 53_100);
  assertEquals(t.preFirstStepMs, 40);
  assertEquals(t.stepsWallMs, 20_000);
  assertEquals(t.betweenStepsMs, 500);
  assertEquals(t.afterLastStepMs, 460);
  assertEquals(t.persistMs, 32_100);
  assertEquals(t.prepareMs, 340);
  assertEquals(t.salvageMs, 30_000);
  assertEquals(t.unattributedMs, 0);
});

Deno.test("timing: reconcileTimeline returns null for a legacy (untimed) invocation, never a fabricated timeline", () => {
  const legacy = { id: "i", duration_ms: 90_000, step_count: 4 };
  assertEquals(T.reconcileTimeline(legacy, []), null);
});

Deno.test("timing: a run with no salvage records outcome 'none' and a NULL salvage_ms", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(5_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "stop", toolCalls: [] });
  rec.markLoopEnd();
  rec.markPersistStart();
  c.advance(300);
  rec.finish(finishInput(c, { finalizeStarted: false }));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.salvage_outcome, "none");
  assertEquals(inv.salvage_ms, null);
  assertEquals(inv.cluster_ms, null);
  assertEquals(inv.persist_ms, 300);
});

Deno.test("timing: every salvage outcome is recorded verbatim, including the skipped and failed ones", async () => {
  for (const outcome of ["ok", "empty", "skipped_budget", "skipped_reviews", "error"] as const) {
    const rows: Written[] = [];
    const c = fakeClock();
    const rec = recorder(rows, c);
    rec.markPersistStart();
    const s = rec.mono();
    c.advance(1_000);
    rec.recordSalvage(s, outcome);
    rec.finish(finishInput(c));
    await settle();
    const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
    assertEquals(inv.salvage_outcome, outcome);
    assertEquals(inv.salvage_ms, 1_000);
  }
});

// ---- the cases the old instrument could not see ------------------------------------

Deno.test("timing: a step that STARTS and never finishes is counted, and writes no step row", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(4_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "tool-calls", toolCalls: [] });
  rec.onStepStart({ stepNumber: 1, messages: [] }); // the model call hangs / is cut off
  c.advance(90_000);
  rec.finish(finishInput(c, { hadStreamError: true, errorMessage: "terminated" }));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.unfinished_steps, 1);
  assertEquals(rows.filter((w) => w.table === "orchestrator_step_metrics").length, 1);
});

Deno.test("timing: the stream-error path still carries timing, with persist_ms NULL when persistence never ran", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(2_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "error", toolCalls: [] });
  rec.finish(finishInput(c, { hadStreamError: true }));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.first_step_offset_ms, 0);
  assertEquals(inv.persist_ms, null);
  assertEquals(inv.loop_end_offset_ms, null);
  assertEquals(inv.stop_reason, "stream_error");
});

Deno.test("timing: markLoopEnd and markPersistStart are first-wins (a second caller cannot move them)", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  c.advance(1_000);
  rec.markLoopEnd();
  c.advance(5_000);
  rec.markLoopEnd();
  rec.markPersistStart();
  c.advance(700);
  rec.markPersistStart();
  rec.finish(finishInput(c));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.loop_end_offset_ms, 1_000);
  assertEquals(inv.persist_ms, 700);
});

// ---- withPrepareTiming must be behaviourally invisible -----------------------------

Deno.test("withPrepareTiming: returns the wrapped value unchanged", async () => {
  const c = fakeClock();
  const rec = recorder([], c);
  const wrapped = T.withPrepareTiming(async (a: { stepNumber: number }) => ({ echoed: a.stepNumber, keep: "same" }), rec);
  assertEquals(await wrapped({ stepNumber: 3 }), { echoed: 3, keep: "same" });
});

Deno.test("withPrepareTiming: rethrows the SAME error (the analyst-stop AbortError must still abort the run) and still records", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  const boom = new DOMException("Investigation stopped by analyst", "AbortError");
  const wrapped = T.withPrepareTiming(async (_a: { stepNumber: number }) => {
    c.advance(25);
    throw boom;
  }, rec);
  let caught: unknown = null;
  try {
    await wrapped({ stepNumber: 0 });
  } catch (e) {
    caught = e;
  }
  assert(caught === boom, "must rethrow the identical error object");
  rec.onStepStart({ stepNumber: 0, messages: [] });
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "stop", toolCalls: [] });
  rec.finish(finishInput(c));
  await settle();
  const step = rows.find((w) => w.table === "orchestrator_step_metrics")!.row;
  assertEquals(step.prepare_ms, 25);
});

Deno.test("withPrepareTiming: under the kill switch it returns the ORIGINAL function, untouched", () => {
  const c = fakeClock();
  const rec = recorder([], c);
  const original = async (_a: { stepNumber: number }) => "x";
  withEnv("TIMING_TELEMETRY_DISABLED", "true", () => {
    assert(T.withPrepareTiming(original, rec) === original);
  });
});

// ---- rollback: the kill switch restores the OLD row shape byte-for-byte ------------

Deno.test("kill switch: TIMING_TELEMETRY_DISABLED=true writes rows with exactly the legacy keys", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await withEnv("TIMING_TELEMETRY_DISABLED", "true", async () => {
    await runSalvageScenario(rows, c);
  });
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  const step = rows.find((w) => w.table === "orchestrator_step_metrics")!.row;
  for (const k of NEW_INVOCATION_KEYS) assert(!(k in inv), `invocation row must not carry ${k} under the switch`);
  for (const k of NEW_STEP_KEYS) assert(!(k in step), `step row must not carry ${k} under the switch`);
  // and the legacy fields are all still there
  for (const k of ["id", "thread_id", "user_id", "started_at", "finished_at", "duration_ms", "step_count", "stop_reason"]) {
    assert(k in inv, `legacy key ${k} missing`);
  }
});

Deno.test("kill switch: unset means ON (the new columns are written)", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await withEnv("TIMING_TELEMETRY_DISABLED", null, async () => {
    await runSalvageScenario(rows, c);
  });
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  for (const k of NEW_INVOCATION_KEYS) assert(k in inv, `${k} missing`);
});

// ---- privacy: integers and one fixed enum, nothing else ----------------------------

Deno.test("privacy: every new column is an integer, null, or a member of the fixed enum — no free text", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await runSalvageScenario(rows, c);
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  for (const k of NEW_INVOCATION_KEYS) {
    const v = inv[k];
    if (k === "salvage_outcome") {
      assert(typeof v === "string" && (T.SALVAGE_OUTCOMES as readonly string[]).includes(v), `bad enum ${String(v)}`);
    } else {
      assert(v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0), `${k} must be a non-negative integer or null, got ${String(v)}`);
    }
  }
  for (const w of rows.filter((x) => x.table === "orchestrator_step_metrics")) {
    for (const k of NEW_STEP_KEYS) {
      const v = w.row[k];
      assert(v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0), `${k} must be a non-negative integer or null`);
    }
  }
});

Deno.test("privacy: the recorder's timing API accepts only numbers and the enum — there is no text parameter to leak into", () => {
  assertEquals(T.SALVAGE_OUTCOMES, ["none", "ok", "empty", "skipped_budget", "skipped_reviews", "error"]);
});

Deno.test("builders clamp negative or non-finite timings to null/0 — a clock fault must not break the insert", () => {
  const row = T.buildStepMetricRow({
    invocationId: "i", threadId: "t", userId: "u", stepNumber: 0, stepWallMs: 10, contextChars: 1,
    inputTokens: 1, outputTokens: 1, toolCallCount: 0, toolNames: [], finishReason: "stop",
    timing: { startedOffsetMs: -5, prepareMs: Number.NaN },
  } as Parameters<typeof T.buildStepMetricRow>[0]);
  assertEquals(row.started_offset_ms, 0);
  assertEquals(row.prepare_ms, null);
});

// ---- /health proof key and call-site wiring ----------------------------------------

Deno.test("health: timingTelemetrySelfTest passes ON and reports LEGACY under the switch", () => {
  const on = withEnv("TIMING_TELEMETRY_DISABLED", null, () => T.timingTelemetrySelfTest());
  assertEquals(on.ok, true, on.detail);
  const off = withEnv("TIMING_TELEMETRY_DISABLED", "true", () => T.timingTelemetrySelfTest());
  assertEquals(off.ok, true, off.detail);
  assert(/LEGACY/.test(off.detail), "the switch must be visible on /health");
});

Deno.test("wiring: health-handler registers checks.timing_telemetry", async () => {
  const h = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(h.includes("r.checks.timing_telemetry = timingTelemetrySelfTest();"));
});

Deno.test("wiring: index.ts feeds the recorder at every phase the old instrument could not see", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(src.includes("withPrepareTiming(prepareStep, invocationTelemetry)"), "prepareStep must be timed");
  // loop end is marked from BOTH streamText terminators
  assert(/onFinish:\s*\(\)\s*=>\s*\{[^}]*invocationTelemetry\.markLoopEnd\(\)/.test(src), "onFinish must mark the loop end");
  assert(/onAbort:\s*\(\)\s*=>\s*\{[^}]*invocationTelemetry\.markLoopEnd\(\)/.test(src), "onAbort must mark the loop end");
  assert(src.includes("invocationTelemetry.markPersistStart()"), "persistFinalMessages must mark its start");
  assert(src.includes("invocationTelemetry.recordSalvage("), "the salvage call must be timed");
  assert(src.includes("invocationTelemetry.recordCluster("), "clustering must be timed");
});

// ---- failure isolation: a telemetry fault must never touch the investigation ---------

/** A clock whose monotonic reading can be broken mid-run (wall time keeps working). */
function flakyClock(c: ReturnType<typeof fakeClock>) {
  let broken = false;
  return {
    clock: {
      now: () => c.clock.now(),
      mono: () => {
        if (broken) throw new Error("clock fault");
        return c.clock.mono();
      },
    },
    breakIt() {
      broken = true;
    },
  };
}

Deno.test("isolation: a monotonic-clock fault never throws out of any timing method", () => {
  const c = fakeClock();
  const f = flakyClock(c);
  const rec = T.createInvocationTelemetry({
    db: fakeDb([]), threadId: "t", userId: "u", provider: null, modelId: null,
    startedAt: c.clock.now(), initialContextChars: 0, clock: f.clock,
  });
  f.breakIt();
  // Every one of these is called from index.ts OUTSIDE its own try/catch at least once.
  rec.mono();
  rec.recordPrepare(0, 5);
  rec.markLoopEnd();
  rec.markPersistStart();
  rec.recordSalvage(0, "ok");
  rec.recordCluster(0);
});

Deno.test("isolation: a clock fault inside finish() still writes the invocation row (legacy fields intact)", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const f = flakyClock(c);
  const rec = T.createInvocationTelemetry({
    db: fakeDb(rows), threadId: "t", userId: "u", provider: "p", modelId: "m",
    startedAt: c.clock.now(), initialContextChars: 10, clock: f.clock,
  });
  rec.markPersistStart(); // so finish() must read mono() to compute persist_ms
  c.advance(500);
  f.breakIt();
  rec.finish(finishInput(c));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")?.row;
  assert(inv, "a timing fault must not cost the legacy invocation row");
  assertEquals(inv!.duration_ms, 500);
  assertEquals(inv!.thread_id, "t");
});

Deno.test("isolation: withPrepareTiming survives a broken recorder and still returns / rethrows the WRAPPED function's outcome", async () => {
  const broken = {
    mono: () => {
      throw new Error("mono fault");
    },
    recordPrepare: () => {
      throw new Error("record fault");
    },
  };
  const ok = T.withPrepareTiming(async (a: { stepNumber: number }) => ({ n: a.stepNumber }), broken);
  assertEquals(await ok({ stepNumber: 7 }), { n: 7 });
  const stop = new DOMException("Investigation stopped by analyst", "AbortError");
  const failing = T.withPrepareTiming(async (_a: { stepNumber: number }) => {
    throw stop;
  }, broken);
  let caught: unknown = null;
  try {
    await failing({ stepNumber: 0 });
  } catch (e) {
    caught = e;
  }
  assert(caught === stop, "the analyst-stop error must surface, not the telemetry fault");
});

Deno.test("isolation: when the schema lags (DB rejects the timing columns) finish() does not throw, and the kill switch lands the row", async () => {
  const rejectsTimingColumns = (rows: Written[]): TelemetryDb => ({
    from(table: string) {
      return {
        insert(row: Record<string, unknown> | Record<string, unknown>[]) {
          const batch = Array.isArray(row) ? row : [row];
          const unknown = batch.some((r) => [...NEW_INVOCATION_KEYS, ...NEW_STEP_KEYS].some((k) => k in r));
          if (unknown) return Promise.resolve({ error: { message: "column does not exist" } });
          for (const r of batch) rows.push({ table, row: r });
          return Promise.resolve({ error: null });
        },
      };
    },
  });
  const run = async (disabled: string | null) => {
    const rows: Written[] = [];
    const c = fakeClock();
    await withEnv("TIMING_TELEMETRY_DISABLED", disabled, async () => {
      const rec = T.createInvocationTelemetry({
        db: rejectsTimingColumns(rows), threadId: "t", userId: "u", provider: null, modelId: null,
        startedAt: c.clock.now(), initialContextChars: 0, clock: c.clock,
      });
      rec.onStepStart({ stepNumber: 0, messages: [] });
      c.advance(100);
      rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "stop", toolCalls: [] });
      rec.finish(finishInput(c)); // must not throw even though the insert is refused
      await settle();
    });
    return rows;
  };
  assertEquals((await run(null)).length, 0, "schema lag + timing ON loses the run's telemetry (this is why schema ships first)");
  assertEquals((await run("true")).length, 2, "the kill switch is the rollback: parent + step rows land");
});

// ---- interval accounting ----------------------------------------------------------------

Deno.test("accounting: persistence that begins BEFORE the last step ends shows up as a NEGATIVE residual, not a hidden clamp", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(1_000);
  rec.markPersistStart(); // premature persistence (the legacy client-cancel path), loop still running
  c.advance(4_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "stop", toolCalls: [] });
  rec.finish(finishInput(c));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  const steps = rows.filter((w) => w.table === "orchestrator_step_metrics").map((w) => w.row);
  const t = T.reconcileTimeline(inv, steps)!;
  assert(t.unattributedMs < 0, `overlap must be visible as a negative residual, got ${t.unattributedMs}`);
});

Deno.test("accounting: an interrupted stream (persistence ran, loop never ended, one step hung) is fully described", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const rec = recorder(rows, c);
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(3_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "tool-calls", toolCalls: [] });
  rec.onStepStart({ stepNumber: 1, messages: [] }); // never finishes
  c.advance(50_000);
  rec.markPersistStart();
  c.advance(800);
  rec.finish(finishInput(c, { hadStreamError: true }));
  await settle();
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.loop_end_offset_ms, null);
  assertEquals(inv.unfinished_steps, 1);
  assertEquals(inv.persist_ms, 800);
  assertEquals(inv.salvage_outcome, "none");
});

// ---- the kill switch really is a byte-for-byte rollback ----------------------------------

Deno.test("kill switch: the legacy rows have EXACTLY the pre-PR keys (hard-coded, not derived)", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  await withEnv("TIMING_TELEMETRY_DISABLED", "true", async () => {
    await runSalvageScenario(rows, c);
  });
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  const step = rows.find((w) => w.table === "orchestrator_step_metrics")!.row;
  assertEquals(Object.keys(inv).sort(), [
    "credits_micro_usd", "duration_ms", "error_message", "final_context_chars", "finalize_started",
    "finish_reason", "finished_at", "id", "initial_context_chars", "model_id", "provider", "started_at",
    "step_count", "stop_reason", "thread_id", "tool_call_count", "user_id",
  ]);
  assertEquals(Object.keys(step).sort(), [
    "context_chars", "finish_reason", "input_tokens", "invocation_id", "output_tokens", "step_number",
    "step_wall_ms", "thread_id", "tool_call_count", "tool_names", "user_id",
  ]);
});

Deno.test("no extra DB round trips: the same inserts in the same order with timing ON as OFF", async () => {
  const trace = async (disabled: string | null) => {
    const calls: string[] = [];
    const c = fakeClock();
    await withEnv("TIMING_TELEMETRY_DISABLED", disabled, async () => {
      const db: TelemetryDb = {
        from(table: string) {
          return {
            insert(row: Record<string, unknown> | Record<string, unknown>[]) {
              calls.push(`${table}:${Array.isArray(row) ? row.length : 1}`);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      const rec = T.createInvocationTelemetry({
        db, threadId: "t", userId: "u", provider: null, modelId: null,
        startedAt: c.clock.now(), initialContextChars: 0, clock: c.clock,
      });
      for (let i = 0; i < 3; i++) {
        rec.onStepStart({ stepNumber: i, messages: [] });
        c.advance(10);
        rec.recordStepFinish({ stepNumber: i, usage: null, finishReason: "stop", toolCalls: [] });
      }
      rec.markLoopEnd();
      rec.markPersistStart();
      rec.recordSalvage(rec.mono(), "ok");
      rec.recordCluster(rec.mono());
      rec.finish(finishInput(c));
      await settle();
    });
    return calls;
  };
  assertEquals(await trace(null), await trace("true"));
  assertEquals(await trace(null), ["orchestrator_invocations:1", "orchestrator_step_metrics:3"]);
});

Deno.test("isolation: a monotonic clock that is broken FROM THE START cannot cost the legacy step_wall_ms or the recorder itself", async () => {
  const rows: Written[] = [];
  const c = fakeClock();
  const f = flakyClock(c);
  f.breakIt(); // broken before the recorder is even constructed
  const rec = T.createInvocationTelemetry({
    db: fakeDb(rows), threadId: "t", userId: "u", provider: null, modelId: null,
    startedAt: c.clock.now(), initialContextChars: 0, clock: f.clock,
  });
  rec.onStepStart({ stepNumber: 0, messages: [] });
  c.advance(7_000);
  rec.recordStepFinish({ stepNumber: 0, usage: null, finishReason: "stop", toolCalls: [] });
  rec.finish(finishInput(c));
  await settle();
  const step = rows.find((w) => w.table === "orchestrator_step_metrics")?.row;
  assert(step, "the step row must still land");
  assertEquals(step!.step_wall_ms, 7_000, "the legacy wall time must not depend on the monotonic clock");
  assertEquals(step!.started_offset_ms, null, "the unmeasurable offset degrades to NULL, never a bad number");
  const inv = rows.find((w) => w.table === "orchestrator_invocations")!.row;
  assertEquals(inv.first_step_offset_ms, null);
  assertEquals(inv.duration_ms, 7_000);
});
