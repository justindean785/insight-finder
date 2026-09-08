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

import type { ModelMessage } from "npm:ai@6";
import { approxMsgChars } from "./orchestrator-budget.ts";
import { registerBackground } from "./incremental-persist.ts";

// ---- bounds (defense in depth; the migration's CHECK constraints are the hard floor) --
const MAX_TOOL_NAMES = 40;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 500;
const MAX_ID_CHARS = 128;

/** Same redaction the tool-usage logger applies (cache.ts), duplicated here rather
 *  than imported: it is a tiny, self-contained defensive helper and cache.ts does
 *  not export its copy. Strips anything that looks like a live credential before
 *  an error string reaches a telemetry row. */
function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(/xai-[A-Za-z0-9._-]+/g, "xai-[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]");
}

function capId(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.slice(0, MAX_ID_CHARS);
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
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
}): StopReason {
  if (input.hadStreamError) return "stream_error";
  if (input.finalizeStarted) return "finalize_forced";
  switch (input.lastFinishReason) {
    case "stop":
      return "natural_stop";
    case "length":
      return "length_limit";
    case "tool-calls":
      // The model still wanted to call tools when the loop stopped — i.e. it
      // was cut off by a step/wall-clock/tool-cap ceiling, not a natural end.
      return "budget_exhausted";
    default:
      return "unknown";
  }
}

export interface StepMetricRowInput {
  invocationId: string;
  threadId: string;
  userId: string;
  stepNumber: number;
  durationMs: number | null;
  contextChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCallCount: number;
  toolNames: string[];
  finishReason: string | null;
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
    duration_ms: numberOrNull(input.durationMs),
    context_chars: numberOrNull(input.contextChars),
    input_tokens: numberOrNull(input.inputTokens),
    output_tokens: numberOrNull(input.outputTokens),
    tool_call_count: Math.max(0, Math.trunc(input.toolCallCount) || 0),
    tool_names: input.toolNames.slice(0, MAX_TOOL_NAMES),
    finish_reason: capId(input.finishReason),
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
}

/** Build the exact row shape inserted into orchestrator_invocations. Pure, same
 *  fail-safe-to-null contract as buildStepMetricRow. */
export function buildInvocationRow(input: InvocationRowInput): Record<string, unknown> {
  const errorMessage = input.errorMessage
    ? redactSecrets(input.errorMessage).slice(0, MAX_ERROR_CHARS)
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
}

export interface InvocationTelemetryRecorder {
  readonly invocationId: string;
  onStepStart(event: StepStartEventLike): void;
  recordStepFinish(event: StepFinishEventLike): void;
  getStepCount(): number;
  getToolCallCount(): number;
  getLastFinishReason(): string | null;
  finish(input: InvocationFinishInput): void;
}

/**
 * Create a per-invocation telemetry recorder. One instance per `streamText` call
 * (index.ts creates it right before that call and holds it for the lifetime of the
 * request). All writes are best-effort and non-blocking (`registerBackground`); a
 * DB or clock fault here can degrade observability but must never fail the run —
 * every catch below logs and swallows.
 */
export function createInvocationTelemetry(input: CreateInvocationTelemetryInput): InvocationTelemetryRecorder {
  const invocationId = crypto.randomUUID();
  const stepStarts = new Map<number, { startedAt: number; contextChars: number }>();
  let stepCount = 0;
  let toolCallTotal = 0;
  let lastFinishReason: string | null = null;
  let finished = false;

  const insertBestEffort = (table: string, row: Record<string, unknown>) => {
    const task = Promise.resolve()
      .then(() => input.db.from(table).insert(row))
      .then(({ error }) => {
        if (error) {
          const msg = (error as { message?: string } | null)?.message ?? String(error);
          console.warn(`[telemetry] ${table} insert failed:`, msg);
        }
      })
      .catch((e) => console.warn(`[telemetry] ${table} insert threw:`, e));
    registerBackground(task);
  };

  return {
    invocationId,

    onStepStart(event: StepStartEventLike) {
      const stepNumber = typeof event?.stepNumber === "number" ? event.stepNumber : stepCount;
      try {
        stepStarts.set(stepNumber, {
          startedAt: Date.now(),
          contextChars: contextCharsFromMessages(event?.messages),
        });
      } catch (e) {
        console.warn("[telemetry] onStepStart failed (non-fatal):", e);
      }
    },

    recordStepFinish(event: StepFinishEventLike) {
      try {
        const stepNumber = typeof event?.stepNumber === "number" ? event.stepNumber : stepCount;
        const start = stepStarts.get(stepNumber);
        stepStarts.delete(stepNumber);
        const durationMs = start ? Date.now() - start.startedAt : null;
        const toolNames = uniqueToolNames(event?.toolCalls);
        const toolCallCount = toolCallCountOf(event?.toolCalls);
        stepCount = Math.max(stepCount, stepNumber + 1);
        toolCallTotal += toolCallCount;
        if (typeof event?.finishReason === "string") lastFinishReason = event.finishReason;

        insertBestEffort(
          "orchestrator_step_metrics",
          buildStepMetricRow({
            invocationId,
            threadId: input.threadId,
            userId: input.userId,
            stepNumber,
            durationMs,
            contextChars: start?.contextChars ?? null,
            inputTokens: numberOrNull(event?.usage?.inputTokens),
            outputTokens: numberOrNull(event?.usage?.outputTokens),
            toolCallCount,
            toolNames,
            finishReason: lastFinishReason,
          }),
        );
      } catch (e) {
        console.warn("[telemetry] recordStepFinish failed (non-fatal):", e);
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

    finish(finishInput: InvocationFinishInput) {
      if (finished) return;
      finished = true;
      try {
        const stopReason = deriveStopReason({
          hadStreamError: finishInput.hadStreamError,
          finalizeStarted: finishInput.finalizeStarted,
          lastFinishReason,
        });
        insertBestEffort(
          "orchestrator_invocations",
          buildInvocationRow({
            invocationId,
            threadId: input.threadId,
            userId: input.userId,
            provider: input.provider,
            modelId: input.modelId,
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
          }),
        );
      } catch (e) {
        console.warn("[telemetry] finish failed (non-fatal):", e);
      }
    },
  };
}
