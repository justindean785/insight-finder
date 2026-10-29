/**
 * telemetry.ts — per-invocation and per-step orchestrator timing/context telemetry.
 *
 * WHY (2026-09-08 performance audit): production forensics showed ~45-55% of every
 * orchestrator cycle is spent with ZERO tool activity (model planning + the 45-64s
 * final-synthesis tail), and that number was derived by hand from tool_usage_log
 * timestamp GAPS across five sampled runs — there is no first-class signal for
 * "how long did the model spend thinking on step N" or "how big was the prompt this
 * step". Without it, the single largest measured latency bucket in the system
 * cannot be attributed to prompt growth, tool-schema size, or raw provider latency
 * on any future run. This module is the fix: one row per orchestrator invocation
 * (a single streamText call — a multi-turn thread has one per user message) and one
 * row per model step within it.
 *
 * PRIVACY / SIZE — deliberately NO prompt or tool-result content is ever recorded.
 * Every field is a count, a duration, a byte-length, or a short enum/name string
 * (provider id, model id, tool name, finish reason). `approxMsgChars` (already used
 * by orchestrator-budget.ts's context trimmer) is reused for context sizing so this
 * module measures the SAME number the trimmer bounds, not a second, divergent one.
 *
 * NON-BLOCKING BY CONSTRUCTION — every DB write here goes through
 * `registerBackground` (incremental-persist.ts's EdgeRuntime.waitUntil helper) so a
 * slow or failed telemetry insert can never add latency to the investigation itself
 * or mask a real failure as a stream error. Telemetry is instrumentation, not a
 * dependency of the run.
 *
 * PURE vs IMPURE — the row builders and `deriveStopReason` are pure (string/number
 * in, plain object/enum out) and unit-tested directly. `createInvocationTelemetry`
 * is the only impure surface (it calls Date.now() and performs DB writes); its DB
 * dependency is the narrow structural `TelemetryDb` interface (mirrors cache-sweep.ts's
 * `CacheDb` pattern) so tests can pass a fake without a real Supabase client.
 */

import { redactErrorMessage } from "./lib/redact-error.ts";
import type { ModelMessage } from "npm:ai@6";
import { approxMsgChars } from "./orchestrator-budget.ts";
import { registerBackground } from "./incremental-persist.ts";

// ---- bounds (defense in depth; the migration's CHECK constraints are the hard floor) --
const MAX_TOOL_NAMES = 40;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 500;
const MAX_ID_CHARS = 128;

function capId(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.slice(0, MAX_ID_CHARS);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

// ---- timing (telemetry PR 2 of 2) -------------------------------------------------
//
// WHY: duration_ms minus SUM(step_wall_ms) was 891 s unaccounted over 70 forced-finalize runs
// (2026-10-29): median 3.7 s but p90 50.7 s, and 73% of it in the 10 runs whose final no-tool
// step was thin — consistent with the report-salvage backstop in index.ts persistFinalMessages
// (a second model call outside the step meter). step_wall_ms alone cannot show that: it runs from
// onStepStart to recordStepFinish, so prepareStep work, time between steps, steps that start and
// never finish, and everything after the loop all fall outside it. These fields make every
// invocation reconcilable into a timeline (reconcileTimeline) and record whether salvage ran.
//
// SCHEMA FIRST: the columns come from 20261029210000_orchestrator_timing_columns.sql. PostgREST
// rejects an insert naming an unknown column, which would drop EVERY telemetry row for the run.
// Apply and verify that migration before this ships; the kill switch below is the rollback.
//
// KILL SWITCH, read at CALL TIME: TIMING_TELEMETRY_DISABLED=true  (rows carry no timing columns,
// exactly the pre-PR shape; withPrepareTiming returns the original function). /health proof key:
// checks.timing_telemetry.
//
// PRIVACY: integers (ms / counts) and one fixed enum. No text parameter exists to leak into.
export function timingTelemetryDisabled(): boolean {
  return (Deno.env.get("TIMING_TELEMETRY_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export const SALVAGE_OUTCOMES = ["none", "ok", "empty", "skipped_budget", "skipped_reviews", "error"] as const;
export type SalvageOutcome = typeof SALVAGE_OUTCOMES[number];

/** The recorder's two clocks. `now` is wall time (rows' started_at / step_wall_ms, as before);
 *  `mono` is monotonic ms (offsets), immune to wall-clock steps. Injectable so tests own time. */
export interface TelemetryClock {
  now(): number;
  mono(): number;
}
const REAL_CLOCK: TelemetryClock = { now: () => Date.now(), mono: () => performance.now() };

/** A timing value: a non-negative whole number of ms, or null. A clock fault degrades to
 *  0/null — it must never reach the insert as a value the migration's CHECK would reject. */
function nonNegIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

export interface StepTiming {
  startedOffsetMs: number | null;
  prepareMs: number | null;
}

export interface InvocationTiming {
  firstStepOffsetMs: number | null;
  loopEndOffsetMs: number | null;
  persistMs: number | null;
  salvageMs: number | null;
  clusterMs: number | null;
  unfinishedSteps: number | null;
  salvageOutcome: SalvageOutcome | null;
}

// ---- pure helpers ---------------------------------------------------------------

/** Serialized-char size of a step's message array, using the SAME metric the
 *  orchestrator's own context trimmer bounds (orchestrator-budget.ts). Never
 *  throws; an unexpected shape sizes to 0 rather than losing the run. */
export function contextCharsFromMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  try {
    return approxMsgChars(messages as ModelMessage[]);
  } catch {
    return 0;
  }
}

/** Deduplicated, bounded tool names from a step's toolCalls array. Tool names are
 *  registry identifiers (e.g. "minimax_correlate"), never selector/PII values. */
export function uniqueToolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names = new Set<string>();
  for (const call of toolCalls) {
    const name = (call as { toolName?: unknown } | null | undefined)?.toolName;
    if (typeof name === "string" && name) names.add(name.slice(0, MAX_TOOL_NAME_CHARS));
  }
  return [...names].slice(0, MAX_TOOL_NAMES);
}

/** Count of tool calls on a step, tolerant of a missing/malformed array. */
export function toolCallCountOf(toolCalls: unknown): number {
  return Array.isArray(toolCalls) ? toolCalls.length : 0;
}

export type StopReason =
  | "natural_stop"
  | "finalize_forced"
  | "length_limit"
  | "budget_exhausted"
  | "stream_error"
  | "unknown";

/**
 * Why the orchestrator invocation ended. Deliberately coarser than the internal
 * stopWhen machinery (orchestrator-budget.ts / orchestrator-finalize.ts): rather
 * than reaching into that state machine's internals (and risking this module
 * drifting out of sync with it — the exact failure mode CLAUDE.md's termination
 * section warns about), this reads only the two externally-observable signals
 * every caller already has: whether the forced-finalize path engaged, and the
 * last step's own `finishReason`. `hadStreamError` always wins — a terminal
 * stream error means neither of the other two ever got to run to completion.
 */
export function deriveStopReason(input: {
  hadStreamError: boolean;
  finalizeStarted: boolean;
  lastFinishReason: string | null;
  /** True only when a budget ceiling demonstrably fired. Defaults to false —
   *  never inferred from finishReason. */
  budgetExhausted?: boolean;
}): StopReason {
  if (input.hadStreamError) return "stream_error";
  if (input.finalizeStarted) return "finalize_forced";
  switch (input.lastFinishReason) {
    case "stop":
      return "natural_stop";
    case "length":
      return "length_limit";
    case "tool-calls":
      // The model still wanted to call tools when the loop stopped. That is
      // consistent with a ceiling (step / wall-clock / tool cap) but does NOT
      // establish one: the SDK reports "tool-calls" for the last step of every
      // tool-using run, including runs that then finalize normally. Reporting
      // it as budget_exhausted would put a cause in the column that nothing
      // measured — the failure mode this repo keeps hitting, an instrument that
      // names something other than what it observed. The caller passes
      // budgetExhausted when a ceiling ACTUALLY fired; absent that, this is
      // honestly unknown.
      return input.budgetExhausted ? "budget_exhausted" : "unknown";
    default:
      return "unknown";
  }
}

export interface StepMetricRowInput {
  invocationId: string;
  threadId: string;
  userId: string;
  stepNumber: number;
  /** WALL-CLOCK for the whole step: model generation PLUS every tool execution
   *  the step dispatched. It is deliberately NOT "how long the model thought" —
   *  a step that fans out to a 30s indicia_person lookup reports ~30s here with
   *  the model responsible for a fraction of it. Subtract the step's tool time
   *  (tool_usage_log, same thread/window) to attribute model latency. Named
   *  step_wall_ms in the table so the column cannot be read as think-time. */
  stepWallMs: number | null;
  contextChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCallCount: number;
  toolNames: string[];
  finishReason: string | null;
  /** Present only when timing telemetry is ON. Absent => the row has exactly the pre-PR keys,
   *  which is what makes the kill switch a byte-for-byte rollback. */
  timing?: StepTiming | null;
}

/** Build the exact row shape inserted into orchestrator_step_metrics. Pure —
 *  performs no I/O and never throws; unknown/out-of-range input degrades to
 *  null/0, never to a thrown error that could interrupt the caller. */
export function buildStepMetricRow(input: StepMetricRowInput): Record<string, unknown> {
  return {
    invocation_id: input.invocationId,
    thread_id: input.threadId,
    user_id: input.userId,
    step_number: Math.max(0, Math.trunc(input.stepNumber) || 0),
    step_wall_ms: numberOrNull(input.stepWallMs),
    context_chars: numberOrNull(input.contextChars),
    input_tokens: numberOrNull(input.inputTokens),
    output_tokens: numberOrNull(input.outputTokens),
    tool_call_count: Math.max(0, Math.trunc(input.toolCallCount) || 0),
    tool_names: input.toolNames.slice(0, MAX_TOOL_NAMES),
    finish_reason: capId(input.finishReason),
    ...(input.timing
      ? {
        started_offset_ms: nonNegIntOrNull(input.timing.startedOffsetMs),
        prepare_ms: nonNegIntOrNull(input.timing.prepareMs),
      }
      : {}),
  };
}

export interface InvocationRowInput {
  invocationId: string;
  threadId: string;
  userId: string;
  provider: string | null;
  modelId: string | null;
  startedAt: number;
  finishedAt: number;
  stepCount: number;
  toolCallCount: number;
  finishReason: string | null;
  stopReason: StopReason;
  finalizeStarted: boolean;
  initialContextChars: number | null;
  finalContextChars: number | null;
  creditsMicroUsd: number | null;
  errorMessage: string | null;
  /** True only when a budget ceiling demonstrably refused a call during this
   *  invocation (index.ts's request-owned `budgetCeiling.fired`, set by
   *  wrapToolsWithCache from startCall's `budgetCeiling`). Optional so existing
   *  callers keep the honest default of "not observed". */
  budgetExhausted?: boolean;
  /** Present only when timing telemetry is ON (see StepMetricRowInput.timing). */
  timing?: InvocationTiming | null;
}

/** Build the exact row shape inserted into orchestrator_invocations. Pure, same
 *  fail-safe-to-null contract as buildStepMetricRow. */
export function buildInvocationRow(input: InvocationRowInput): Record<string, unknown> {
  const errorMessage = input.errorMessage
    ? redactErrorMessage(input.errorMessage).slice(0, MAX_ERROR_CHARS)
    : null;
  return {
    id: input.invocationId,
    thread_id: input.threadId,
    user_id: input.userId,
    provider: capId(input.provider),
    model_id: capId(input.modelId),
    started_at: new Date(input.startedAt).toISOString(),
    finished_at: new Date(input.finishedAt).toISOString(),
    duration_ms: Math.max(0, input.finishedAt - input.startedAt),
    step_count: Math.max(0, Math.trunc(input.stepCount) || 0),
    tool_call_count: Math.max(0, Math.trunc(input.toolCallCount) || 0),
    finish_reason: capId(input.finishReason),
    stop_reason: input.stopReason,
    finalize_started: input.finalizeStarted,
    initial_context_chars: numberOrNull(input.initialContextChars),
    final_context_chars: numberOrNull(input.finalContextChars),
    credits_micro_usd: numberOrNull(input.creditsMicroUsd),
    error_message: errorMessage,
    ...(input.timing
      ? {
        first_step_offset_ms: nonNegIntOrNull(input.timing.firstStepOffsetMs),
        loop_end_offset_ms: nonNegIntOrNull(input.timing.loopEndOffsetMs),
        persist_ms: nonNegIntOrNull(input.timing.persistMs),
        salvage_ms: nonNegIntOrNull(input.timing.salvageMs),
        cluster_ms: nonNegIntOrNull(input.timing.clusterMs),
        unfinished_steps: nonNegIntOrNull(input.timing.unfinishedSteps),
        salvage_outcome: input.timing.salvageOutcome &&
            (SALVAGE_OUTCOMES as readonly string[]).includes(input.timing.salvageOutcome)
          ? input.timing.salvageOutcome
          : null,
      }
      : {}),
  };
}

// ---- timeline reconciliation (pure) -----------------------------------------------

export interface TimelineBreakdown {
  durationMs: number;
  /** invocation start -> first step start */
  preFirstStepMs: number;
  /** SUM(step_wall_ms) */
  stepsWallMs: number;
  /** gaps between one step's end and the next step's start */
  betweenStepsMs: number;
  /** last step's end -> the point persistence began */
  afterLastStepMs: number;
  /** persistFinalMessages, start to the invocation row being written */
  persistMs: number;
  /** of the above, the parts we can name: prepareStep, salvage, clustering */
  prepareMs: number;
  salvageMs: number;
  clusterMs: number;
  /** durationMs minus every bucket above. ~0 when the timeline is internally consistent. */
  unattributedMs: number;
}

/**
 * Turn one timed invocation row plus its step rows into named buckets that sum to duration_ms.
 * Returns null for a legacy (untimed) row — a timeline is never fabricated from data that was
 * not measured. `unattributedMs` is the residual; it is the number to alarm on, and it should
 * be ~0 by construction. A clamped or overlapping clock shows up here instead of vanishing.
 */
export function reconcileTimeline(
  inv: Record<string, unknown>,
  steps: Record<string, unknown>[],
): TimelineBreakdown | null {
  if (!("persist_ms" in inv) && !("first_step_offset_ms" in inv)) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const durationMs = num(inv.duration_ms);
  const persistMs = num(inv.persist_ms);
  const loopMs = Math.max(0, durationMs - persistMs);
  const timed = steps
    .filter((s) => typeof s.started_offset_ms === "number" && typeof s.step_wall_ms === "number")
    .map((s) => ({ start: s.started_offset_ms as number, wall: s.step_wall_ms as number, prep: num(s.prepare_ms) }))
    .sort((a, b) => a.start - b.start);

  let preFirstStepMs = loopMs;
  let stepsWallMs = 0;
  let betweenStepsMs = 0;
  let afterLastStepMs = 0;
  let prepareMs = 0;
  if (timed.length > 0) {
    preFirstStepMs = timed[0].start;
    for (let i = 0; i < timed.length; i++) {
      stepsWallMs += timed[i].wall;
      prepareMs += timed[i].prep;
      if (i > 0) betweenStepsMs += Math.max(0, timed[i].start - (timed[i - 1].start + timed[i - 1].wall));
    }
    const last = timed[timed.length - 1];
    afterLastStepMs = Math.max(0, loopMs - (last.start + last.wall));
  }
  const unattributedMs = durationMs - (preFirstStepMs + stepsWallMs + betweenStepsMs + afterLastStepMs + persistMs);
  return {
    durationMs,
    preFirstStepMs,
    stepsWallMs,
    betweenStepsMs,
    afterLastStepMs,
    persistMs,
    prepareMs,
    salvageMs: num(inv.salvage_ms),
    clusterMs: num(inv.cluster_ms),
    unattributedMs,
  };
}

/** `prepareStep` wrapper that records how long it ran. Behaviourally invisible: same value,
 *  same thrown error object (the analyst-stop AbortError must still abort the run), and under
 *  the kill switch the ORIGINAL function is returned untouched. */
// deno-lint-ignore no-explicit-any -- the SDK's prepareStep takes a larger argument object than {stepNumber};
// `any` keeps F assignable under strictFunctionTypes, and the wrapper only ever reads stepNumber.
export function withPrepareTiming<F extends (arg: any) => unknown>(
  fn: F,
  rec: Pick<InvocationTelemetryRecorder, "mono" | "recordPrepare">,
): F {
  if (timingTelemetryDisabled()) return fn;
  return (async (arg: { stepNumber?: number }) => {
    // The recorder's faults are isolated from fn's outcome on BOTH sides: a throwing mono() must not
    // stop prepareStep from running, and a throwing recordPrepare in `finally` must not replace the
    // value fn returned or mask the error fn threw (the analyst-stop AbortError must surface).
    let t0 = Number.NaN;
    try {
      t0 = rec.mono();
    } catch { /* telemetry only */ }
    try {
      return await fn(arg);
    } finally {
      try {
        rec.recordPrepare(arg?.stepNumber, rec.mono() - t0);
      } catch { /* telemetry only */ }
    }
  }) as unknown as F;
}

/** `/health` -> checks.timing_telemetry. Pure: drives the real builders and reconcileTimeline on a
 *  synthetic timeline. Presence of the key proves this build is deployed; LEGACY shows the switch. */
export function timingTelemetrySelfTest(): { ok: boolean; detail: string; switch?: string } {
  if (timingTelemetryDisabled()) {
    return { ok: true, detail: "LEGACY via TIMING_TELEMETRY_DISABLED — rows carry no timing columns", switch: "TIMING_TELEMETRY_DISABLED=true" };
  }
  const wrong: string[] = [];
  const base = {
    invocationId: "self-test", threadId: "t", userId: "u", provider: null, modelId: null,
    startedAt: 0, finishedAt: 1_000, stepCount: 2, toolCallCount: 0, finishReason: "stop",
    stopReason: "natural_stop" as StopReason, finalizeStarted: false, initialContextChars: null,
    finalContextChars: null, creditsMicroUsd: null, errorMessage: null,
  };
  const legacy = Object.keys(buildInvocationRow(base));
  const timed = buildInvocationRow({
    ...base,
    timing: {
      firstStepOffsetMs: 10, loopEndOffsetMs: 600, persistMs: 400, salvageMs: 300, clusterMs: 50,
      unfinishedSteps: 0, salvageOutcome: "ok",
    },
  });
  const added = Object.keys(timed).filter((k) => !legacy.includes(k));
  if (added.length !== 7) wrong.push(`expected 7 added invocation columns, saw ${added.length}`);
  if (timed.salvage_outcome !== "ok") wrong.push("salvage outcome not carried");
  const stepBase = {
    invocationId: "self-test", threadId: "t", userId: "u", stepNumber: 0, stepWallMs: 500,
    contextChars: null, inputTokens: null, outputTokens: null, toolCallCount: 0, toolNames: [], finishReason: "stop",
  };
  const stepRow = buildStepMetricRow({ ...stepBase, timing: { startedOffsetMs: 10, prepareMs: 5 } });
  if (Object.keys(stepRow).length - Object.keys(buildStepMetricRow(stepBase)).length !== 2) wrong.push("step timing columns not added");
  const t = reconcileTimeline(timed, [stepRow]);
  if (!t) wrong.push("a timed invocation did not reconcile");
  else if (t.unattributedMs !== 0) wrong.push(`synthetic timeline left ${t.unattributedMs} ms unattributed`);
  if (reconcileTimeline({ duration_ms: 1_000 }, []) !== null) wrong.push("a legacy row was given a timeline");
  return {
    ok: wrong.length === 0,
    detail: wrong.length === 0
      ? "invocation + step timing columns, reconcileTimeline residual 0, salvage outcome enum (no text fields)"
      : wrong.join("; "),
    switch: "TIMING_TELEMETRY_DISABLED=false",
  };
}

// ---- impure recorder --------------------------------------------------------------

/** The narrow slice of PostgREST this module needs. Structural (mirrors
 *  cache-sweep.ts's CacheDb), so tests pass a fake without a real client. */
export interface TelemetryDb {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
}

export interface CreateInvocationTelemetryInput {
  db: TelemetryDb;
  threadId: string;
  userId: string;
  provider: string | null;
  modelId: string | null;
  /** epoch ms — the SAME runStartedAt index.ts already tracks for the wall-clock
   *  deadline, so this module introduces no second clock. */
  startedAt: number;
  initialContextChars: number;
  /** Test seam. Defaults to Date.now() / performance.now(), so production is unchanged. */
  clock?: TelemetryClock;
}

export interface StepStartEventLike {
  stepNumber?: number;
  messages?: unknown;
}

export interface StepFinishEventLike {
  stepNumber?: number;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
  finishReason?: string;
  toolCalls?: unknown;
}

export interface InvocationFinishInput {
  finishedAt: number;
  finalContextChars: number | null;
  finalizeStarted: boolean;
  hadStreamError: boolean;
  creditsMicroUsd: number | null;
  errorMessage: string | null;
  /** True only when a budget ceiling demonstrably refused a call during this
   *  invocation (index.ts's request-owned `budgetCeiling.fired`, set by
   *  wrapToolsWithCache from startCall's `budgetCeiling`). Optional so existing
   *  callers keep the honest default of "not observed". */
  budgetExhausted?: boolean;
}

export interface InvocationTelemetryRecorder {
  readonly invocationId: string;
  onStepStart(event: StepStartEventLike): void;
  recordStepFinish(event: StepFinishEventLike): void;
  getStepCount(): number;
  getToolCallCount(): number;
  getLastFinishReason(): string | null;
  /** Re-label the provider/model this invocation actually ran on (E2b: GLM's start
   *  failure moved it to Anthropic after the recorder was created). Ignored after finish. */
  setRoute(route: { provider: string | null; modelId: string | null }): void;
  finish(input: InvocationFinishInput): void;
  // ---- timing (all no-ops under TIMING_TELEMETRY_DISABLED) ----
  /** Monotonic ms. Callers capture it before a phase and hand it back to recordSalvage/recordCluster. */
  mono(): number;
  /** How long prepareStep ran before this step started. */
  recordPrepare(stepNumber: number | undefined, ms: number): void;
  /** The streamText loop ended (onFinish or onAbort). First call wins. */
  markLoopEnd(): void;
  /** persistFinalMessages began. First call wins; persist_ms runs from here to finish(). */
  markPersistStart(): void;
  /** The salvage backstop finished (or was skipped / failed). `startedMono` is mono() from its start. */
  recordSalvage(startedMono: number, outcome: SalvageOutcome): void;
  /** applyClusteringToThread finished. `startedMono` is mono() from its start. */
  recordCluster(startedMono: number): void;
}

/**
 * Create a per-invocation telemetry recorder. One instance per `streamText` call
 * (index.ts creates it right before that call and holds it for the lifetime of the
 * request). All writes are best-effort and non-blocking (`registerBackground`); a
 * DB or clock fault here can degrade observability but must never fail the run —
 * every catch below logs and swallows.
 */
/** Hard cap on buffered step rows. A run is bounded to tens of steps by the
 *  orchestrator's own ceilings; this only stops a pathological loop from growing
 *  the buffer without bound. Overflow is dropped and counted, never silently. */
export const MAX_BUFFERED_STEP_ROWS = 200;

export function createInvocationTelemetry(input: CreateInvocationTelemetryInput): InvocationTelemetryRecorder {
  const invocationId = crypto.randomUUID();
  const clock = input.clock ?? REAL_CLOCK;
  // Read once per recorder (one recorder per request), so the switch is honoured at call time
  // per request and every row of one invocation has the same shape.
  const timingOn = !timingTelemetryDisabled();
  // The ONLY place the monotonic clock is read. A fault degrades to NaN (-> a NULL column), and
  // never reaches the constructor, onStepStart or any legacy field: step_wall_ms and duration_ms
  // are computed from `clock.now()` alone and must not depend on this clock.
  const safeMono = (): number => {
    try {
      return clock.mono();
    } catch {
      return Number.NaN;
    }
  };
  const mono0 = safeMono();
  const stepStarts = new Map<number, { startedAt: number; mono: number; contextChars: number }>();
  const prepareByStep = new Map<number, number>();
  let firstStepOffsetMs: number | null = null;
  let loopEndOffsetMs: number | null = null;
  let persistStartMono: number | null = null;
  let salvage: { ms: number | null; outcome: SalvageOutcome } | null = null;
  let clusterMs: number | null = null;
  let stepCount = 0;
  let toolCallTotal = 0;
  let lastFinishReason: string | null = null;
  let finished = false;
  let route = { provider: input.provider, modelId: input.modelId };
  // ---- Why step rows are BUFFERED rather than inserted as they finish --------
  // orchestrator_step_metrics.invocation_id is a FOREIGN KEY to
  // orchestrator_invocations(id), and the parent row is only written in finish(),
  // once the run's duration/stop_reason are known. Inserting a step row the
  // moment its step completed therefore referenced a parent that did not exist
  // yet: Postgres rejected EVERY step insert on the FK, and insertBestEffort's
  // catch turned each rejection into a console.warn on a log with sub-30-minute
  // retention. The table would have stayed permanently empty while
  // orchestrator_invocations filled normally — an instrument reporting nothing
  // while looking healthy, which is the exact failure this repo keeps hitting.
  // Buffering and flushing AFTER the parent insert resolves is what makes the
  // child rows land. Steps are telemetry, so deferring them to end-of-run costs
  // nothing; a run that dies before finish() loses them, which is strictly
  // better than today, where every run loses them.
  const pendingStepRows: Record<string, unknown>[] = [];
  let droppedStepRows = 0;

  /** The timing block for the invocation row, built in isolation: if reading the clock faults,
   *  the row falls back to the legacy shape and STILL lands — a timing fault must never cost the
   *  invocation row the pre-existing instrument writes. */
  const buildTiming = (): InvocationTiming | null => {
    try {
      return {
        firstStepOffsetMs,
        loopEndOffsetMs,
        persistMs: persistStartMono === null ? null : safeMono() - persistStartMono,
        salvageMs: salvage ? salvage.ms : null,
        clusterMs,
        // Steps that fired onStepStart and never reached recordStepFinish. Today they
        // vanish silently; a model call that hangs or is cut off is exactly one of these.
        unfinishedSteps: stepStarts.size,
        salvageOutcome: salvage ? salvage.outcome : "none",
      };
    } catch (e) {
      console.warn("[telemetry] timing block failed (non-fatal), writing the legacy row shape:", e);
      return null;
    }
  };

  /** Insert the parent, then the buffered children — in that order, awaited, so
   *  the FK is satisfied. Both legs stay best-effort and non-blocking. */
  const flushParentThenSteps = (parentRow: Record<string, unknown>) => {
    const task = Promise.resolve()
      .then(() => input.db.from("orchestrator_invocations").insert(parentRow))
      .then(({ error }) => {
        if (error) {
          const msg = (error as { message?: string } | null)?.message ?? String(error);
          // The parent failed, so every buffered child would fail its FK too.
          // Say so once, with the count, instead of emitting N identical warns.
          console.warn(
            `[telemetry] orchestrator_invocations insert failed: ${msg} — dropping ${pendingStepRows.length} step row(s)`,
          );
          return;
        }
        if (pendingStepRows.length === 0) return;
        return input.db.from("orchestrator_step_metrics").insert(pendingStepRows).then(
          ({ error: stepError }: { error: { message?: string } | null }) => {
            if (stepError) {
              console.warn(
                `[telemetry] orchestrator_step_metrics bulk insert failed:`,
                stepError?.message ?? String(stepError),
              );
            }
          },
        );
      })
      .catch((e) => console.warn("[telemetry] telemetry flush threw:", e))
      .finally(() => {
        if (droppedStepRows > 0) {
          console.warn(`[telemetry] ${droppedStepRows} step row(s) dropped: buffer cap reached`);
        }
        pendingStepRows.length = 0;
      });
    registerBackground(task);
    return task;
  };

  return {
    invocationId,

    onStepStart(event: StepStartEventLike) {
      const stepNumber = typeof event?.stepNumber === "number" ? event.stepNumber : stepCount;
      try {
        const mono = safeMono();
        stepStarts.set(stepNumber, {
          startedAt: clock.now(),
          mono,
          contextChars: contextCharsFromMessages(event?.messages),
        });
        if (firstStepOffsetMs === null) firstStepOffsetMs = nonNegIntOrNull(mono - mono0);
      } catch (e) {
        console.warn("[telemetry] onStepStart failed (non-fatal):", e);
      }
    },

    recordStepFinish(event: StepFinishEventLike) {
      try {
        const stepNumber = typeof event?.stepNumber === "number" ? event.stepNumber : stepCount;
        const start = stepStarts.get(stepNumber);
        stepStarts.delete(stepNumber);
        const stepWallMs = start ? clock.now() - start.startedAt : null;
        const stepPrepareMs = prepareByStep.get(stepNumber) ?? null;
        prepareByStep.delete(stepNumber);
        const toolNames = uniqueToolNames(event?.toolCalls);
        const toolCallCount = toolCallCountOf(event?.toolCalls);
        stepCount = Math.max(stepCount, stepNumber + 1);
        toolCallTotal += toolCallCount;
        if (typeof event?.finishReason === "string") lastFinishReason = event.finishReason;

        // Buffered, not inserted — see flushParentThenSteps for why (FK ordering).
        if (pendingStepRows.length >= MAX_BUFFERED_STEP_ROWS) {
          droppedStepRows += 1;
          return;
        }
        pendingStepRows.push(
          buildStepMetricRow({
            invocationId,
            threadId: input.threadId,
            userId: input.userId,
            stepNumber,
            stepWallMs,
            contextChars: start?.contextChars ?? null,
            inputTokens: numberOrNull(event?.usage?.inputTokens),
            outputTokens: numberOrNull(event?.usage?.outputTokens),
            toolCallCount,
            toolNames,
            finishReason: lastFinishReason,
            timing: timingOn
              ? { startedOffsetMs: start ? start.mono - mono0 : null, prepareMs: stepPrepareMs }
              : null,
          }),
        );
      } catch (e) {
        console.warn("[telemetry] recordStepFinish failed (non-fatal):", e);
      }
    },

    // Every method below is called from index.ts on the investigation's own path (some outside any
    // try/catch of theirs), so each one swallows its own faults like the pre-existing methods do:
    // a telemetry fault may cost a measurement, never the run. mono() degrades to NaN, which
    // nonNegIntOrNull turns into a NULL column instead of a bad number.
    mono() {
      return safeMono();
    },
    recordPrepare(stepNumber: number | undefined, ms: number) {
      try {
        if (!timingOn || typeof stepNumber !== "number") return;
        const v = nonNegIntOrNull(ms);
        if (v !== null) prepareByStep.set(stepNumber, v);
      } catch (e) {
        console.warn("[telemetry] recordPrepare failed (non-fatal):", e);
      }
    },
    markLoopEnd() {
      try {
        if (!timingOn || finished || loopEndOffsetMs !== null) return;
        loopEndOffsetMs = nonNegIntOrNull(safeMono() - mono0);
      } catch (e) {
        console.warn("[telemetry] markLoopEnd failed (non-fatal):", e);
      }
    },
    markPersistStart() {
      try {
        if (!timingOn || finished || persistStartMono !== null) return;
        const m = safeMono();
        if (Number.isFinite(m)) persistStartMono = m;
      } catch (e) {
        console.warn("[telemetry] markPersistStart failed (non-fatal):", e);
      }
    },
    recordSalvage(startedMono: number, outcome: SalvageOutcome) {
      try {
        if (!timingOn || finished) return;
        salvage = { ms: nonNegIntOrNull(safeMono() - startedMono), outcome };
      } catch (e) {
        console.warn("[telemetry] recordSalvage failed (non-fatal):", e);
      }
    },
    recordCluster(startedMono: number) {
      try {
        if (!timingOn || finished) return;
        clusterMs = nonNegIntOrNull(safeMono() - startedMono);
      } catch (e) {
        console.warn("[telemetry] recordCluster failed (non-fatal):", e);
      }
    },

    getStepCount() {
      return stepCount;
    },
    getToolCallCount() {
      return toolCallTotal;
    },
    getLastFinishReason() {
      return lastFinishReason;
    },
    setRoute(next: { provider: string | null; modelId: string | null }) {
      if (finished) return;
      route = { provider: next?.provider ?? null, modelId: next?.modelId ?? null };
    },

    finish(finishInput: InvocationFinishInput) {
      if (finished) return;
      finished = true;
      try {
        const stopReason = deriveStopReason({
          hadStreamError: finishInput.hadStreamError,
          finalizeStarted: finishInput.finalizeStarted,
          lastFinishReason,
          budgetExhausted: finishInput.budgetExhausted,
        });
        flushParentThenSteps(
          buildInvocationRow({
            invocationId,
            threadId: input.threadId,
            userId: input.userId,
            provider: route.provider,
            modelId: route.modelId,
            startedAt: input.startedAt,
            finishedAt: finishInput.finishedAt,
            stepCount,
            toolCallCount: toolCallTotal,
            finishReason: lastFinishReason,
            stopReason,
            finalizeStarted: finishInput.finalizeStarted,
            initialContextChars: input.initialContextChars,
            finalContextChars: finishInput.finalContextChars,
            creditsMicroUsd: finishInput.creditsMicroUsd,
            errorMessage: finishInput.errorMessage,
            timing: timingOn ? buildTiming() : null,
          }),
        );
      } catch (e) {
        console.warn("[telemetry] finish failed (non-fatal):", e);
      }
    },
  };
}
