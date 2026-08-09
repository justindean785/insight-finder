/**
 * run-telemetry.ts — request-scoped run correlation and unconditional lifecycle events.
 *
 * PURE OBSERVABILITY. This module makes NO admission, budget, persistence, ranking,
 * confidence or safety decision, and nothing in the orchestrator branches on anything
 * it returns. It exists so a run can be *identified* in telemetry; it does not give a
 * run any authority. Durable run identity, single-flight and same-run terminal write
 * authority are deliberately NOT here — those need a database row, and conflating a
 * correlation handle with a lock is how `threads.status` ended up doing double duty
 * as both state and lock.
 *
 * ---- WHY --------------------------------------------------------------------------
 * Nothing written by a run currently records WHICH run wrote it. `tool_usage_log` has
 * `thread_id` and `created_at` and no run column; `incremental-persist.ts` declares a
 * `runId` field that no caller has ever set, so every checkpoint has stored `null`.
 *
 * The measurable consequence: per-run figures cannot be computed at all. Grouping
 * `tool_usage_log` by thread and splitting on a 90-second inter-call gap — the best
 * available proxy — showed 49 live tool calls inside a single 180s isolate lifetime
 * against a documented ceiling of 36. That is a real overrun, but the proxy cannot say
 * whether ONE run overshot its own closure counter or TWO overlapping runs each
 * received a fresh 36 while `clearRuntime(threadId)` zeroed the shared thread counter.
 * Those two diagnoses call for different fixes. A correlation id separates them.
 *
 * ---- NO MIGRATION ------------------------------------------------------------------
 * The run id reaches `tool_usage_log` through the existing `input_json` jsonb column
 * (stamped at the single `logUsage` choke point in cache.ts), so per-run attribution
 * is queryable the moment this deploys — `input_json->>'run_id'` — with no schema
 * change and nothing to roll back but this code. A dedicated column can follow later
 * as an indexing decision, not a prerequisite.
 *
 * ---- LOGGING POLICY ----------------------------------------------------------------
 * env.ts's policy is binding here and is ENFORCED, not merely documented: `emit`
 * drops every field whose NAME is not in `TELEMETRY_FIELDS` — an ALLOWLIST, so the
 * default is DROP. Telemetry carries ids, counts, durations, statuses, enum-ish
 * reasons and TYPE names — never selectors, never analyst input, never provider
 * payloads. A caller that passes a seed, a name or a credential by mistake logs
 * nothing rather than leaking it.
 */

/** Bumped when the emitted event shape changes, so a query can tell eras apart. */
export const RUN_TELEMETRY_VERSION = 1;

/**
 * The COMPLETE set of field names telemetry may emit. Anything not named here is
 * dropped before a line is written.
 *
 * This is an ALLOWLIST on purpose. The first version was a denylist of PII-shaped
 * key names, and reviewing this PR caught it leaking `queried_name` — a person's
 * name — because the pattern matched `query` and not `queried`. That is the generic
 * failure of a denylist: it can only block the key names somebody thought of, and a
 * near-miss reads as safe. An allowlist inverts the default, so a field a future
 * author forgot to think about is dropped rather than published.
 *
 * It is affordable precisely because telemetry is closed: three call sites emit a
 * fixed vocabulary of counts, ids, durations, enum-ish reasons and TYPE names —
 * never a selector, a name, a payload or a credential. `run_telemetry_test.ts` pins
 * the emitted set against this list, so adding a field without allowlisting it fails
 * the suite loudly instead of silently vanishing from the logs.
 */
export const TELEMETRY_FIELDS: ReadonlySet<string> = new Set([
  // run_started
  "provider", "model", "provider_reason",
  // The seed's KIND ("email" | "username" | "domain" | …), never the seed itself.
  "seed_kind",
  "tool_schema_size", "step_cap", "tool_call_cap", "wall_clock_budget_ms",
  // step_finished
  "step_index", "finish_reason", "tool_call_count",
  // TOOL names ("serus_darkweb_scan"), never tool arguments.
  "tool_names",
  "distinct_tool_count", "finalize_phase",
  "reserved_tool_calls", "genuine_tool_calls", "elapsed_ms",
  // run_terminal
  "terminal_reason", "steps", "last_finish_reason", "budget_capped",
  "finalize_started", "finalize_steps_run", "contract_reason",
  "run_cost_micro_usd", "context_overflow", "message_schema_invalid",
  // An Error's `.name` ("AbortError"), never its message.
  "error_name",
  // Pre-existing events folded in when their console.log calls were migrated.
  "rejected", "reviewed", "cap", "trigger", "step_number", "nudge_count",
  "tool_calls", "record_artifact_calls", "inserted", "skipped_duplicates",
  "evidence_appended", "phase", "decision_succeeded",
  // Ranking/measurement signals: a 0-100 SCORE and a TYPE name, never the selector.
  "expected_value", "selector_type", "weak_lead", "value_count", "values_kept",
  "content_hash",
]);

/** Identity fields the logger owns. A caller may not overwrite them. */
const RESERVED_FIELDS = new Set(["event", "run_id", "thread_id", "ts", "v"]);

export type RunLogFields = Record<string, unknown>;

/** Where a line goes. Injectable so tests observe emissions without stdout. */
export type RunLogSink = (line: string) => void;

export interface RunLogger {
  readonly runId: string;
  readonly threadId: string;
  /** Emit one structured line. Never throws. */
  emit(event: string, fields?: RunLogFields): void;
  /**
   * Emit the run's single terminal event. Returns true if THIS call emitted it,
   * false if a terminal event was already recorded for this run.
   *
   * A run has many exits — clean finalize, `onError`, analyst stop, credit
   * exhaustion, deadline — and the whole point of a terminal event is that every
   * run produces exactly one. The latch lives here rather than at each call site so
   * a newly added exit path cannot forget it and cannot double-count.
   */
  terminal(reason: string, fields?: RunLogFields): boolean;
  /** True once a terminal event has been recorded. */
  isTerminated(): boolean;
}

/**
 * Mint a fresh run correlation id. Random, not derived — two runs started on the same
 * thread in the same millisecond must not collide, which is exactly the case that
 * matters here and exactly the case a timestamp surrogate gets wrong.
 */
export function newRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Deno provides randomUUID; this only guards an exotic/stubbed global so that a
    // telemetry helper can never be the reason a run fails to start.
    let out = "";
    for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
}

/**
 * Drop reserved and sensitive keys, and bound value size. Returns a NEW object;
 * the caller's object is never mutated.
 */
export function scrubLogFields(fields: RunLogFields | undefined): RunLogFields {
  const out: RunLogFields = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(k)) continue;
    // Allowlist, not denylist — see TELEMETRY_FIELDS. Default is DROP.
    if (!TELEMETRY_FIELDS.has(k)) continue;
    if (typeof v === "string" && v.length > 300) {
      out[k] = v.slice(0, 300);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Build the logger for one request. `threadId` and `runId` are stamped on every line,
 * so every event this run emits is joinable to every `tool_usage_log` row it wrote.
 */
export function makeRunLogger(
  runId: string,
  threadId: string,
  sink: RunLogSink = (line) => console.log(line),
): RunLogger {
  let terminated = false;
  const write = (event: string, fields?: RunLogFields) => {
    try {
      sink(JSON.stringify({
        event,
        run_id: runId,
        thread_id: threadId,
        v: RUN_TELEMETRY_VERSION,
        ...scrubLogFields(fields),
      }));
    } catch {
      // Telemetry must never break a run. A sink that throws, or a field that cannot
      // be serialized, costs one log line and nothing else.
    }
  };
  return {
    runId,
    threadId,
    emit: write,
    terminal(reason: string, fields?: RunLogFields): boolean {
      if (terminated) return false;
      terminated = true;
      write("run_terminal", { ...fields, terminal_reason: reason });
      return true;
    },
    isTerminated: () => terminated,
  };
}
