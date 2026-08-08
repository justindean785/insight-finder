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
 * strips any field whose NAME matches a sensitive pattern (seed, query, value, email,
 * phone, token, password, secret, raw, body, snapshot, …). Telemetry carries ids,
 * counts, durations, statuses and reasons — never selectors, never analyst input,
 * never provider payloads. A caller that passes a seed by mistake logs nothing rather
 * than leaking it.
 */

/** Bumped when the emitted event shape changes, so a query can tell eras apart. */
export const RUN_TELEMETRY_VERSION = 1;

/**
 * Field names that must never reach a log line. Matched case-insensitively as a
 * SUBSTRING of the key, so `seed_value`, `userEmail` and `raw_body` are all caught.
 * Deliberately broad: a dropped counter is a cosmetic loss, a leaked selector is not.
 */
export const SENSITIVE_FIELD_RE =
  /seed|query|selector|value|email|phone|token|password|passwd|secret|api[_-]?key|authorization|cookie|raw|body|payload|snapshot|content|handle|username|address/i;

/**
 * Keys that match SENSITIVE_FIELD_RE by substring but carry no subject data — a
 * SCORE, a TYPE NAME, or a COUNT rather than the thing itself. Without this the broad
 * regex would silently swallow exactly the signals the ranking work needs to measure
 * (`expected_value` is a 0-100 score; `selector_type` is "email"/"phone", never the
 * selector). Explicit and enumerated: a key is safe because it is on this list, not
 * because it looked safe to whoever added it.
 */
export const SAFE_FIELD_ALLOWLIST = new Set([
  // The seed's KIND ("email" | "username" | "domain" | …), never the seed. Caught by
  // the regex on its first authoring, which is the enforcement working as intended.
  "seed_kind",
  "expected_value",
  "selector_type",
  "value_count",
  "values_kept",
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
    if (!SAFE_FIELD_ALLOWLIST.has(k) && SENSITIVE_FIELD_RE.test(k)) continue;
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
