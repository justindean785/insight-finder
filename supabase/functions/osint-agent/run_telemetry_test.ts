/**
 * run_telemetry_test.ts — pins the properties PR 0a exists to guarantee.
 *
 * Every test here fails against the preceding commit, where run-telemetry.ts does not
 * exist and no run emits a correlation id at all. The wiring tests at the bottom read
 * index.ts and cache.ts off disk (hence --allow-read) to assert the call sites exist,
 * because a helper nothing calls is indistinguishable from a helper that works.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  makeRunLogger,
  newRunId,
  RUN_TELEMETRY_VERSION,
  TELEMETRY_FIELDS,
  scrubLogFields,
} from "./run-telemetry.ts";
import { stampRunId } from "./cache.ts";

function capture() {
  const lines: string[] = [];
  return { lines, sink: (l: string) => void lines.push(l), parsed: () => lines.map((l) => JSON.parse(l)) };
}

// ---- identity ---------------------------------------------------------------------

Deno.test("newRunId returns distinct ids for runs minted back to back", () => {
  // The failure this guards: a timestamp surrogate collides for two runs started on
  // the same thread in the same millisecond — precisely the overlapping-run case the
  // id exists to disambiguate.
  const ids = new Set(Array.from({ length: 500 }, () => newRunId()));
  assertEquals(ids.size, 500);
});

Deno.test("every emitted line carries event, run_id, thread_id and a version", () => {
  const c = capture();
  const log = makeRunLogger("run-A", "thread-1", c.sink);
  log.emit("run_started", { provider: "deepseek" });
  log.emit("step_finished", { step_number: 3 });
  const rows = c.parsed();
  assertEquals(rows.length, 2);
  for (const r of rows) {
    assert(typeof r.event === "string" && r.event.length > 0);
    assertEquals(r.run_id, "run-A");
    assertEquals(r.thread_id, "thread-1");
    assertEquals(r.v, RUN_TELEMETRY_VERSION);
  }
  assertEquals(rows[0].provider, "deepseek");
  assertEquals(rows[1].step_number, 3);
});

Deno.test("a caller cannot overwrite the identity fields the logger owns", () => {
  // Without this, one mislabeled call site silently reattributes a whole run.
  const c = capture();
  const log = makeRunLogger("real-run", "real-thread", c.sink);
  log.emit("step_finished", { run_id: "spoofed", thread_id: "spoofed", event: "spoofed", v: 99 });
  const r = c.parsed()[0];
  assertEquals(r.run_id, "real-run");
  assertEquals(r.thread_id, "real-thread");
  assertEquals(r.event, "step_finished");
  assertEquals(r.v, RUN_TELEMETRY_VERSION);
});

// ---- the terminal latch -----------------------------------------------------------

Deno.test("terminal() emits exactly once no matter how many exits fire", () => {
  // A run has many exits (clean finalize, onError, analyst stop, credit exhaustion,
  // deadline). Two of them firing must not produce two terminal events, or the
  // completion rate is overcounted.
  const c = capture();
  const log = makeRunLogger("run-A", "thread-1", c.sink);
  assertEquals(log.isTerminated(), false);
  assertEquals(log.terminal("clean_finalize", { genuine_tool_calls: 7 }), true);
  assertEquals(log.terminal("stream_error"), false);
  assertEquals(log.terminal("deadline"), false);
  assertEquals(log.isTerminated(), true);
  const terminals = c.parsed().filter((r) => r.event === "run_terminal");
  assertEquals(terminals.length, 1);
  assertEquals(terminals[0].terminal_reason, "clean_finalize");
  assertEquals(terminals[0].genuine_tool_calls, 7);
});

Deno.test("the first exit to fire wins, and later exits cannot relabel the run", () => {
  const c = capture();
  const log = makeRunLogger("run-A", "thread-1", c.sink);
  log.terminal("stream_error");
  log.terminal("clean_finalize");
  assertEquals(c.parsed().filter((r) => r.event === "run_terminal")[0].terminal_reason, "stream_error");
});

// ---- the logging policy is enforced, not documented --------------------------------

Deno.test("a field that is not on the allowlist is dropped, whatever it is called", () => {
  // The first version of this scrubber was a DENYLIST and it leaked `queried_name`:
  // the pattern matched `query`, not `queried`. A near-miss read as safe. These are
  // the shapes an analyst's investigation actually contains.
  const c = capture();
  const log = makeRunLogger("run-A", "thread-1", c.sink);
  log.emit("step_finished", {
    seed_value: "leoseyes86@gmail.com",
    queried_name: "Example Person",
    subject_name: "Example Person",
    display_name: "Example Person",
    selector: "+1 (212) 555-0123",
    query: 'site:example.com "Example Person"',
    raw_response: '{"ssn":"000-00-0000"}',
    associated_password: "hunter2",
    ip_addresses: ["203.0.113.47"],
    some_field_nobody_thought_of: "leoseyes86@gmail.com",
    step_index: 4,
  });
  const line = c.lines[0];
  for (const leaked of [
    "leoseyes86", "Example Person", "555-0123", "site:example.com",
    "000-00-0000", "hunter2", "203.0.113.47",
  ]) {
    assertEquals(line.includes(leaked), false, `leaked ${leaked}`);
  }
  const r = JSON.parse(line);
  assertEquals(r.step_index, 4);
  for (const k of ["seed_value", "queried_name", "subject_name", "some_field_nobody_thought_of"]) {
    assertEquals(k in r, false, `${k} survived`);
  }
});

Deno.test("the allowlist contains no field that is itself a selector or payload", () => {
  // Reviewer aid: every entry must be a count, id, duration, enum-ish reason, or a
  // TYPE name. If a future author adds a value-bearing key this fails.
  const banned = /^(seed_value|selector|query|value|email|phone|password|raw|body|payload|snapshot|handle|username|address|name)$/i;
  for (const f of TELEMETRY_FIELDS) {
    assertEquals(banned.test(f), false, `${f} looks like it carries a value, not a measure`);
  }
});

Deno.test("the fields index.ts actually emits all survive the scrubber", () => {
  // Regression guard for a real self-inflicted bug: `seed_kind` matches the `seed`
  // pattern and was silently dropped on first authoring. A field that is scrubbed
  // away is indistinguishable from a field nobody emitted, so the emitted set is
  // pinned rather than trusted.
  const emitted = {
    provider: "deepseek", model: "deepseek-v4-pro", provider_reason: "pinned",
    seed_kind: "username", tool_schema_size: 107, step_cap: 22, tool_call_cap: 36,
    wall_clock_budget_ms: 180000, step_index: 1, finish_reason: "tool-calls",
    tool_call_count: 2, tool_names: ["a"], distinct_tool_count: 1, finalize_phase: null,
    reserved_tool_calls: 2, genuine_tool_calls: 2, elapsed_ms: 900, steps: 5,
    last_finish_reason: "stop", budget_capped: false, finalize_started: true,
    finalize_steps_run: 3, contract_reason: null, run_cost_micro_usd: 1234,
    terminal_reason: "clean_finalize", context_overflow: false,
    message_schema_invalid: false, error_name: "",
  };
  assertEquals(Object.keys(scrubLogFields(emitted)).sort(), Object.keys(emitted).sort());
  // and every one of them is declared, so the list and the call sites cannot drift
  for (const k of Object.keys(emitted)) {
    assert(TELEMETRY_FIELDS.has(k), `${k} is emitted by index.ts but not in TELEMETRY_FIELDS`);
  }
});

Deno.test("scrubLogFields never mutates the caller's object", () => {
  const input = { seed_value: "x", step_number: 1 };
  scrubLogFields(input);
  assertEquals(input.seed_value, "x");
});

Deno.test("long strings are bounded so one error message cannot flood the log", () => {
  const c = capture();
  // Uses a real emitted field: `contract_reason` is free text from resolveTerminalState.
  makeRunLogger("run-A", "thread-1", c.sink).emit("run_terminal", { contract_reason: "z".repeat(5000) });
  assertEquals((JSON.parse(c.lines[0]).contract_reason as string).length, 300);
});

// ---- telemetry can never break a run -----------------------------------------------

Deno.test("a throwing sink does not propagate", () => {
  const log = makeRunLogger("run-A", "thread-1", () => {
    throw new Error("stdout gone");
  });
  log.emit("run_started");
  log.terminal("clean_finalize");
  assertEquals(log.isTerminated(), true);
});

Deno.test("an unserializable field costs one line, not the run", () => {
  const c = capture();
  const log = makeRunLogger("run-A", "thread-1", c.sink);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // `tool_names` is a real emitted field; a cyclic value in it must cost the line only.
  log.emit("step_finished", { tool_names: circular });
  log.emit("step_finished", { step_number: 2 });
  assertEquals(c.parsed().length, 1);
  assertEquals(c.parsed()[0].step_number, 2);
});

// ---- wiring: the helper is actually called ------------------------------------------

const SRC = new URL(".", import.meta.url).pathname;
const read = (f: string) => Deno.readTextFileSync(SRC + f);

Deno.test("index.ts mints a run id and builds a logger for every request", () => {
  const src = read("index.ts");
  assertStringIncludes(src, `from "./run-telemetry.ts"`);
  assertStringIncludes(src, "newRunId()");
  assertStringIncludes(src, "makeRunLogger(");
});

Deno.test("index.ts emits a step_finished event on EVERY step, not only finalize steps", () => {
  // The pre-existing finalize_step_finished event is inside `if (finalizeStarted)`,
  // so an ordinary step — the overwhelming majority — recorded no finish reason at
  // all. Without an unconditional event there is no denominator.
  const src = read("index.ts");
  assertStringIncludes(src, `"step_finished"`);
  const stepFinishBody = src.slice(src.indexOf("onStepFinish:"), src.indexOf("onStepFinish:") + 3000);
  const guardIdx = stepFinishBody.indexOf("if (finalizeStarted)");
  const eventIdx = stepFinishBody.indexOf(`"step_finished"`);
  assert(eventIdx >= 0, "step_finished not emitted inside onStepFinish");
  assert(eventIdx < guardIdx, "step_finished must be emitted BEFORE the finalizeStarted guard");
});

Deno.test("every terminal exit in index.ts records a terminal reason", () => {
  // Both terminal paths must call the latched terminal(); the latch itself guarantees
  // only one fires, so the risk this guards is an exit path that emits NOTHING.
  // All THREE terminal exits must call the latched terminal(): the clean finalize,
  // the stream-error path, and the outer catch that returns a 500. The latch itself
  // guarantees only one fires, so the risk this guards is an exit that emits NOTHING —
  // which is what the outer catch did on first authoring.
  const src = read("index.ts");
  assertEquals((src.match(/runLog(ger)?[?]?\.terminal\(/g) ?? []).length, 3);
  // The clean path distinguishes a met from an unmet I-2 completion contract.
  for (const reason of ["clean_finalize", "finished_contract_unmet", "stream_error", "orchestrator_fault"]) {
    assertStringIncludes(src, `"${reason}"`);
  }
  // onError must terminate in its `finally`, so a throw inside the status update
  // cannot swallow the run's only terminal event.
  const onErrIdx = src.indexOf("onError: async ({ error })");
  assert(onErrIdx > 0, "onError not found");
  const onErrBody = src.slice(onErrIdx, src.indexOf("onFinish: persistFinalMessages"));
  assertStringIncludes(onErrBody, "} finally {");
  assert(
    onErrBody.indexOf("} finally {") < onErrBody.indexOf(".terminal("),
    "onError must record its terminal event in the finally block",
  );
});

Deno.test("an auth/validation rejection is not recorded as a run that faulted", () => {
  // setupRequest throws a Response for 401/403/400/413/429. Those never started a
  // run, and counting them as orchestrator faults would manufacture a failure rate
  // out of ordinary rejected requests.
  const src = read("index.ts");
  const i = src.indexOf(`runLog?.terminal("orchestrator_fault"`);
  assert(i > 0, "orchestrator_fault terminal not found");
  assertStringIncludes(src.slice(Math.max(0, i - 400), i), "if (!(e instanceof Response))");
});

Deno.test("cache.ts stamps the run id on every tool_usage_log row", () => {
  // Stamped at the single logUsage choke point rather than at each of the ~10 call
  // sites, so a newly added rejection path cannot write an unattributed row.
  const src = read("cache.ts");
  assertStringIncludes(src, "runId");
  const logUsageIdx = src.indexOf("const logUsage = async (");
  assert(logUsageIdx > 0, "logUsage not found");
  const body = src.slice(logUsageIdx, logUsageIdx + 3000);
  assertStringIncludes(body, "stampRunId(");
  assert(!/input_json:\s*inputJson\s*,/.test(body), "input_json must be stamped, not passed through raw");
});

Deno.test("the run id reaches tool_usage_log without a schema change", () => {
  // It rides the existing input_json jsonb column, so per-run attribution is
  // queryable on deploy (input_json->>'run_id') with nothing to migrate.
  const src = read("cache.ts");
  const i = src.indexOf("function stampRunId");
  assert(i > 0, "stampRunId helper not found");
  assertStringIncludes(src.slice(i, i + 500), "run_id");
});

// ---- stampRunId: the no-migration attribution path ---------------------------------

Deno.test("stampRunId attributes a row even when the call site passes no input_json", () => {
  // Several logUsage call sites pass nothing. Those rows would drop out of every
  // per-run query — precisely the rejection paths (run_capped, finalize_window,
  // circuit) whose rate is the thing worth measuring.
  assertEquals(stampRunId(null, "run-A"), { run_id: "run-A" });
});

Deno.test("stampRunId preserves the existing input_json shape", () => {
  const original = { input: { purpose: "default" }, runtime: { expected_value: 62 } };
  const out = stampRunId(original, "run-A");
  assertEquals(out, { input: { purpose: "default" }, runtime: { expected_value: 62 }, run_id: "run-A" });
  assertEquals("run_id" in original, false, "caller's object was mutated");
});

Deno.test("stampRunId is a no-op when no run id is set, so existing callers are unaffected", () => {
  const original = { input: { a: 1 } };
  assertEquals(stampRunId(original, null), original);
  assertEquals(stampRunId(original, undefined), original);
  assertEquals(stampRunId(null, ""), null);
});

Deno.test("run-telemetry makes no admission, budget or persistence decision", () => {
  // Guards the module's stated contract: it is observability, not authority. If a
  // later change makes the orchestrator branch on telemetry, this fails loudly.
  const src = read("run-telemetry.ts");
  for (const forbidden of ["supabase", "from(", "insert(", "activeTools", "toolChoice", "reserveToolCall"]) {
    assertEquals(src.includes(forbidden), false, `run-telemetry.ts must not reference ${forbidden}`);
  }
});
