// opsis_search_guard_test.ts — a paid opsis_search is only started when the run can read it.
//
// MEASURED (thread 0ea52455, 2026-10-21..23): 11 paid searches, 4 read, 7 never read ($2.10
// for nothing). These tests drive the pure decision, the per-thread registry and the REAL
// cache wrapper (the shipped control flow), plus source-level wiring. Synthetic values only.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { OPSIS_POLL_DEADLINE_MS } from "../../functions/osint-agent/lib/opsis.ts";
import { OPSIS_COLLECT_BUDGET_MS, requiredCompletionMs, type OpsisPendingRun } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { classifyToolOutcome } from "../../functions/osint-agent/tool-outcome.ts";
import {
  MAX_UNCOLLECTED_OPSIS_RUNS,
  OPSIS_GUARD_NOTE_CAP,
  OPSIS_GUARD_NOTE_DEADLINE,
  OPSIS_GUARD_NOTE_SAME_SELECTOR,
  OPSIS_GUARD_SKIP_PREFIX,
  clearOpsisGuardThread,
  decideOpsisSearch,
  findPendingForSelector,
  noteOpsisResultsOutcome,
  noteOpsisSearchOutcome,
  opsisSearchGuardDisabled,
  opsisSearchGuardSelfTest,
  opsisSearchNeededMs,
  uncollectedOpsisRuns,
} from "../../functions/osint-agent/lib/opsis-search-guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
const KILL = "OPSIS_SEARCH_GUARD_DISABLED";

// ── Pure decision ────────────────────────────────────────────────────────

Deno.test("needed time is the finalize path's own numbers: search + collect + completion (no correlate)", () => {
  assertEquals(opsisSearchNeededMs(), OPSIS_POLL_DEADLINE_MS + 5_000 + OPSIS_COLLECT_BUDGET_MS + requiredCompletionMs({ correlateBudgetMs: 0 }));
});

Deno.test("decision: cap, deadline, allow — and the cap is checked first", () => {
  const needed = opsisSearchNeededMs();
  const fine = decideOpsisSearch({ uncollected: MAX_UNCOLLECTED_OPSIS_RUNS - 1, remainingMs: needed });
  assertEquals(fine, { allow: true });
  const late = decideOpsisSearch({ uncollected: 0, remainingMs: needed - 1 });
  assert(!late.allow && late.reason === "deadline" && late.note === OPSIS_GUARD_NOTE_DEADLINE && late.needed_ms === needed);
  const cap = decideOpsisSearch({ uncollected: MAX_UNCOLLECTED_OPSIS_RUNS, remainingMs: needed * 10 });
  assert(!cap.allow && cap.reason === "uncollected_cap" && cap.note === OPSIS_GUARD_NOTE_CAP && cap.uncollected === MAX_UNCOLLECTED_OPSIS_RUNS);
  const both = decideOpsisSearch({ uncollected: 5, remainingMs: 0 });
  assert(!both.allow && both.reason === "uncollected_cap", "the cap is named before the deadline");
  const run: OpsisPendingRun = { run_id: "p1", kind: "username", value: "x" };
  const same = decideOpsisSearch({ uncollected: 5, remainingMs: 0, sameSelectorRun: run });
  assert(!same.allow && same.reason === "pending_same_selector" && same.note === OPSIS_GUARD_NOTE_SAME_SELECTOR, "a repeat of an un-read run is named before everything");
  assertEquals(same.pending_run, run);
  assertEquals(decideOpsisSearch({ uncollected: 0, remainingMs: needed, sameSelectorRun: null }), { allow: true });
});

Deno.test("selector match is by kind + value, case- and whitespace-insensitive; a different kind is a different search", () => {
  const pending: OpsisPendingRun[] = [{ run_id: "a", kind: "email", value: "Who@Example.test" }, { run_id: "b", kind: "username", value: "who" }];
  assertEquals(findPendingForSelector(pending, "EMAIL", "  who@example.test ")?.run_id, "a");
  assertEquals(findPendingForSelector(pending, "username", "WHO")?.run_id, "b");
  assertEquals(findPendingForSelector(pending, "domain", "who"), null);
  assertEquals(findPendingForSelector(pending, "", "who"), null);
});

Deno.test("a refusal's error text classifies as SKIPPED, never failed — it must not count against Opsis's health", () => {
  for (const reason of ["pending_same_selector", "uncollected_cap", "deadline"]) {
    assertEquals(classifyToolOutcome(`${OPSIS_GUARD_SKIP_PREFIX} ${reason}`, null), "skipped", reason);
  }
  assertEquals(classifyToolOutcome("opsis search start request failed", null), "failed", "a real Opsis failure still reads as one");
});

Deno.test("decision FAILS CLOSED on an unreadable clock; a disabled guard admits everything", () => {
  const nan = decideOpsisSearch({ uncollected: 0, remainingMs: Number.NaN });
  assert(!nan.allow && nan.reason === "deadline" && nan.remaining_ms === null);
  const inf = decideOpsisSearch({ uncollected: 0, remainingMs: Number.POSITIVE_INFINITY });
  assert(!inf.allow && inf.reason === "deadline", "an infinite reading is not a reading");
  assertEquals(decideOpsisSearch({ uncollected: 0, remainingMs: null }), { allow: true }, "no clock wired: only the cap applies");
  const capNoClock = decideOpsisSearch({ uncollected: MAX_UNCOLLECTED_OPSIS_RUNS, remainingMs: null });
  assert(!capNoClock.allow && capNoClock.reason === "uncollected_cap" && capNoClock.remaining_ms === null);
  assertEquals(decideOpsisSearch({ uncollected: 99, remainingMs: -1, enabled: false }), { allow: true });
  const weird = decideOpsisSearch({ uncollected: Number.NaN, remainingMs: opsisSearchNeededMs() });
  assertEquals(weird, { allow: true }, "an unreadable count reads as zero, never as over the cap");
});

// ── Registry ─────────────────────────────────────────────────────────────

Deno.test("registry: partial searches await a read; complete/failed searches and any results read retire them; history ids union by id", () => {
  const t = "guard-registry-thread";
  clearOpsisGuardThread(t);
  const ids = (x: OpsisPendingRun[]) => x.map((r) => r.run_id);
  noteOpsisSearchOutcome(t, { ok: true, partial: true, run_id: "a", kind: "username", value: "A_Handle" });
  noteOpsisSearchOutcome(t, { ok: true, partial: true, run_id: "b" }, { kind: "email", value: "b@example.test" }); // selector from the input when the body lacks it
  noteOpsisSearchOutcome(t, { ok: true, complete: true, run_id: "c" });
  noteOpsisSearchOutcome(t, { ok: false, run_status: "failed", run_id: "d" });
  noteOpsisSearchOutcome(t, { ok: false, skipped: true }); // no run id: nothing to track
  assertEquals(uncollectedOpsisRuns(t), [{ run_id: "a", kind: "username", value: "A_Handle" }, { run_id: "b", kind: "email", value: "b@example.test" }]);
  noteOpsisResultsOutcome(t, { ok: true, partial: true, run_id: "a" }); // a read, even partial, retires the run
  assertEquals(ids(uncollectedOpsisRuns(t)), ["b"]);
  noteOpsisResultsOutcome(t, { ok: false, error: "x" }, "b"); // a failed read names the run it asked for
  assertEquals(uncollectedOpsisRuns(t), []);
  // The SDK envelope shape, and runs replayed from history (history wins on a shared id; blanks dropped).
  noteOpsisSearchOutcome(t, { type: "json", value: { ok: true, partial: true, run_id: "e", kind: "domain", value: "e.example" } });
  const replayed: OpsisPendingRun[] = [{ run_id: "f", kind: "username", value: "f" }, { run_id: " ", kind: "", value: "" }, { run_id: "f", kind: "username", value: "f" }];
  assertEquals(ids(uncollectedOpsisRuns(t, replayed)), ["e", "f"]);
  clearOpsisGuardThread(t);
  assertEquals(uncollectedOpsisRuns(t), []);
});

Deno.test("kill switch is read at CALL time and ships OFF; the self-test states the rule", () => {
  assertEquals(opsisSearchGuardDisabled(), false);
  assertEquals(opsisSearchGuardDisabled(() => "true"), true);
  assertEquals(opsisSearchGuardDisabled(() => " TRUE "), true);
  const t = opsisSearchGuardSelfTest();
  assert(t.ok, t.detail);
  assertStringIncludes(t.detail, `max ${MAX_UNCOLLECTED_OPSIS_RUNS} un-collected`);
  assertStringIncludes(t.detail, "free");
  Deno.env.set(KILL, "true");
  try {
    assertEquals(opsisSearchGuardSelfTest().detail, "LEGACY via OPSIS_SEARCH_GUARD_DISABLED");
  } finally {
    Deno.env.delete(KILL);
  }
});

// ── The real wrapper ─────────────────────────────────────────────────────

function chain(v: { data: unknown; error: unknown }): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) n[m] = () => n;
  n.maybeSingle = () => Promise.resolve(v);
  n.then = (r: (x: { data: unknown; error: unknown }) => void) => r(v);
  n.insert = () => Promise.resolve({ error: null });
  n.upsert = () => Promise.resolve({ error: null });
  return n;
}
const USAGE_ROWS: Array<Record<string, unknown>> = [];
function db(): SupabaseClient {
  const inert = chain({ data: [], error: null });
  const usage = chain({ data: [], error: null });
  usage.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
    USAGE_ROWS.push(...(Array.isArray(rows) ? rows : [rows]));
    return Promise.resolve({ error: null });
  };
  return { from: (t: string) => (t === "tool_usage_log" ? usage : inert), rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

let seq = 0;
function harness(opts: { remainingMs: () => number; replayed?: () => OpsisPendingRun[]; partial?: boolean }) {
  seq += 1;
  const investigationId = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  clearOpsisGuardThread(investigationId);
  const calls = { search: 0, results: 0 };
  let run = 0;
  const search = {
    description: "opsis_search stand-in",
    execute: (input: { kind: string; value: string }) => {
      calls.search += 1;
      run += 1;
      const base = { source: "opsis", run_id: `run-${seq}-${run}`, kind: input.kind, value: input.value, results: [] };
      return Promise.resolve(opts.partial === false
        ? { ...base, ok: true, run_status: "completed", complete: true }
        : { ...base, ok: true, partial: true, run_status: "running", complete: false });
    },
  } as unknown as Tool;
  const results = {
    description: "opsis_results stand-in",
    execute: (input: { run_id: string }) => {
      calls.results += 1;
      return Promise.resolve({ ok: true, source: "opsis", run_id: input.run_id, run_status: "completed", complete: true, results: [] });
    },
  } as unknown as Tool;
  const wrapped = wrapToolsWithCache({ opsis_search: search, opsis_results: results }, {
    investigationId,
    userId: "guard-user",
    supabase: db(),
    pendingOpsisRuns: opts.replayed ?? (() => []),
    remainingRunMs: opts.remainingMs,
  });
  const exec = (name: string) => (wrapped[name] as unknown as Exec).execute;
  return { calls, exec, investigationId };
}
let callSeq = 0;
const o = () => ({ toolCallId: `g${++callSeq}`, messages: [] });

Deno.test("wrapper: a search the run cannot read before the report is refused, free, legible, with no provider call", async () => {
  const h = harness({ remainingMs: () => opsisSearchNeededMs() - 1 });
  const out = await h.exec("opsis_search")({ kind: "username", value: "guard_handle_a" }, o());
  assertEquals(h.calls.search, 0, "the paid tool must not run");
  assertEquals(out.ok, false);
  assertEquals(out.skipped, true);
  assertEquals(out.provider_attempted, false);
  assertEquals(out.opsis_guard, "deadline");
  assertEquals(out.reason, OPSIS_GUARD_NOTE_DEADLINE);
  assert(typeof out.remaining_ms === "number" && typeof out.needed_ms === "number");
});

Deno.test("wrapper: the third un-read search in one step is refused with the pending ids; a read frees a slot; opsis_results is never gated", async () => {
  const h = harness({ remainingMs: () => opsisSearchNeededMs() * 2 });
  const s = h.exec("opsis_search");
  const first = await s({ kind: "username", value: "guard_handle_b1" }, o());
  const second = await s({ kind: "username", value: "guard_handle_b2" }, o());
  assertEquals(h.calls.search, 2);
  assertEquals(first.partial, true);
  const third = await s({ kind: "username", value: "guard_handle_b3" }, o());
  assertEquals(h.calls.search, 2, "the cap refuses before the provider");
  assertEquals(third.opsis_guard, "uncollected_cap");
  assertEquals(third.uncollected_runs, MAX_UNCOLLECTED_OPSIS_RUNS);
  assertEquals(third.pending_run_ids, [first.run_id, second.run_id].sort());
  assertEquals(third.reason, OPSIS_GUARD_NOTE_CAP);
  // Reading one pending run is never refused, and frees a slot.
  const read = await h.exec("opsis_results")({ kind: "username", value: "guard_handle_b1", run_id: first.run_id }, o());
  assertEquals(h.calls.results, 1);
  assertEquals(read.ok, true);
  const fourth = await s({ kind: "username", value: "guard_handle_b4" }, o());
  assertEquals(h.calls.search, 3, "a slot freed by a read admits the next search");
  assertEquals(fourth.partial, true);
});

Deno.test("wrapper: runs replayed from earlier steps' history count too (the model cannot forget them)", async () => {
  const h = harness({
    remainingMs: () => opsisSearchNeededMs() * 2,
    replayed: () => [{ run_id: "hist-1", kind: "username", value: "h1" }, { run_id: "hist-2", kind: "username", value: "h2" }],
  });
  const out = await h.exec("opsis_search")({ kind: "email", value: "guard.person@example.test" }, o());
  assertEquals(h.calls.search, 0);
  assertEquals(out.opsis_guard, "uncollected_cap");
  assertEquals(out.pending_run_ids, ["hist-1", "hist-2"]);
});

Deno.test("wrapper: CARRY-OVER — a search for a selector whose run from an EARLIER TURN is still un-read is refused free and pointed at that run; reading it is allowed; a different selector still runs", async () => {
  // The earlier turn's run reaches this request only through the replayed history (a fresh
  // isolate has no registry), which is exactly what index.ts hands the wrapper per step.
  const h = harness({
    remainingMs: () => opsisSearchNeededMs() * 2,
    replayed: () => [{ run_id: "turn1-run", kind: "username", value: "Carry_Over" }],
  });
  const repeat = await h.exec("opsis_search")({ kind: "username", value: "carry_over" }, o());
  assertEquals(h.calls.search, 0, "no second credit for the same selector");
  assertEquals(repeat.opsis_guard, "pending_same_selector");
  assertEquals(repeat.pending_run_id, "turn1-run");
  assertEquals(repeat.read_with, { tool: "opsis_results", run_id: "turn1-run", kind: "username", value: "Carry_Over" });
  assertEquals(repeat.reason, OPSIS_GUARD_NOTE_SAME_SELECTOR);
  const read = await h.exec("opsis_results")({ kind: "username", value: "Carry_Over", run_id: "turn1-run" }, o());
  assertEquals(h.calls.results, 1);
  assertEquals(read.ok, true);
  const other = await h.exec("opsis_search")({ kind: "username", value: "someone_new" }, o());
  assertEquals(h.calls.search, 1, "one un-read run leaves room under the cap for a NEW selector");
  assertEquals(other.partial, true);
});

Deno.test("wrapper: the refusal's tool_usage_log row is SKIPPED at $0 with the reason — never a failed Opsis call", async () => {
  USAGE_ROWS.length = 0;
  const h = harness({ remainingMs: () => 0 });
  await h.exec("opsis_search")({ kind: "username", value: "logged_handle" }, o());
  const row = USAGE_ROWS.find((r) => r.tool_name === "opsis_search");
  assert(row, "a usage row must be written for the refusal");
  assertEquals(row!.outcome, "skipped");
  assertEquals(row!.charged_micro_usd, 0);
  assertEquals(row!.cost_micro_usd, 0);
  assertEquals(row!.ok, true, "okStored: not a hard failure");
  assertStringIncludes(String(row!.error_msg), `${OPSIS_GUARD_SKIP_PREFIX} deadline`);
  const runtime = ((row!.input_json as Record<string, unknown>)?.runtime ?? {}) as Record<string, unknown>;
  assertEquals(runtime.rejection_source, "opsis_guard");
  assertEquals(runtime.rejection_reason, "opsis_deadline");
});

Deno.test("wrapper: a COMPLETED search needs no read, so it never counts toward the cap", async () => {
  const h = harness({ remainingMs: () => opsisSearchNeededMs() * 2, partial: false });
  const s = h.exec("opsis_search");
  for (const v of ["done_c1", "done_c2", "done_c3"]) await s({ kind: "username", value: v }, o());
  assertEquals(h.calls.search, 3);
});

Deno.test("wrapper: with NO clock wired only the cap applies (a wired clock that cannot be read still fails closed)", async () => {
  seq += 1;
  const investigationId = `44444444-5555-4666-8777-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  clearOpsisGuardThread(investigationId);
  const calls = { n: 0 };
  const search = { description: "x", execute: () => { calls.n += 1; return Promise.resolve({ ok: true, partial: true, run_id: `z${calls.n}` }); } } as unknown as Tool;
  const wrapped = wrapToolsWithCache({ opsis_search: search }, { investigationId, userId: "u", supabase: db() });
  const exec = (wrapped.opsis_search as unknown as Exec).execute;
  await exec({ kind: "username", value: "no_clock_1" }, o());
  await exec({ kind: "username", value: "no_clock_2" }, o());
  const third = await exec({ kind: "username", value: "no_clock_3" }, o());
  assertEquals(calls.n, 2, "the cap still holds without a clock");
  assertEquals(third.opsis_guard, "uncollected_cap");
  const nan = harness({ remainingMs: () => Number.NaN });
  const out = await nan.exec("opsis_search")({ kind: "username", value: "bad_clock" }, o());
  assertEquals(nan.calls.search, 0);
  assertEquals(out.opsis_guard, "deadline");
});

Deno.test("wrapper: kill switch OPSIS_SEARCH_GUARD_DISABLED restores the legacy admission", async () => {
  Deno.env.set(KILL, "true");
  try {
    const h = harness({ remainingMs: () => 0, replayed: () => [{ run_id: "a", kind: "username", value: "legacy_handle" }, { run_id: "b", kind: "username", value: "b" }] });
    const out = await h.exec("opsis_search")({ kind: "username", value: "legacy_handle" }, o());
    assertEquals(h.calls.search, 1);
    assertEquals(out.partial, true);
    assert(!("opsis_guard" in out));
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("wrapper: a refusal is logged by reason and counts, never by selector value", async () => {
  const h = harness({ remainingMs: () => 0 });
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    await h.exec("opsis_search")({ kind: "email", value: "VALUE-MUST-NOT-LOG@example.test" }, o());
  } finally {
    console.warn = orig;
  }
  const line = logged.find((l) => l.includes("opsis_search_refused"));
  assert(line, "a structured opsis_search_refused event must be emitted");
  const evt = JSON.parse(line!) as Record<string, unknown>;
  assertEquals(evt.reason, "deadline");
  assertEquals(evt.thread_id, h.investigationId);
  assert(!line!.includes("VALUE-MUST-NOT-LOG"));
});

// ── Wiring (source-level) ────────────────────────────────────────────────

Deno.test("wiring: the guard sits after cache hits and BEFORE the paid slot; index.ts feeds both inputs; /health reports the rule; the model is told", async () => {
  const cache = await Deno.readTextFile(new URL("../../functions/osint-agent/cache.ts", import.meta.url));
  const guardAt = cache.indexOf('if (name === "opsis_search" && !opsisSearchGuardDisabled())');
  assert(guardAt > 0, "the wrapper must consult the guard");
  assert(guardAt < cache.indexOf("// ---- Per-run tool-call cap (graceful) ----"), "guard before the run cap");
  assert(guardAt < cache.indexOf("reserveToolCall(ctx.toolCallBudget"), "guard before the paid slot is reserved");
  assert(guardAt > cache.lastIndexOf("isCacheableToolResult(output)"), "guard after the cache-hit reads, so a completed run still replays free");
  assert(cache.includes('if (name === "opsis_search") noteOpsisSearchOutcome(ctx.investigationId, result, input as { kind?: unknown; value?: unknown });'));
  // opsis_results: the hint (opsis_results_hint_test.ts) is computed BEFORE the run is retired as read.
  const resultsAt = cache.indexOf('if (name === "opsis_results") {');
  assert(resultsAt > 0 && cache.indexOf("noteOpsisResultsOutcome(ctx.investigationId, result, asked.run_id);") > cache.indexOf("opsisResultsHint(", resultsAt));
  const index = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(index.includes("pendingOpsisRuns: () => latestPendingOpsisRuns,"));
  assert(index.includes("remainingRunMs: () => ORCHESTRATOR_WALL_CLOCK_MS - (Date.now() - runStartedAt),"));
  assert(index.includes("latestPendingOpsisRuns = pendingOpsisRuns(stepMessages as Array<{ content?: unknown }>);"));
  const outcome = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-outcome.ts", import.meta.url));
  assert(outcome.includes("opsis search guard:"), "SKIP_RE names the refusal prefix");
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.opsis_search_guard = opsisSearchGuardSelfTest();"));
  const registry = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  const desc = registry.slice(registry.indexOf("opsis_search: tool({"), registry.indexOf("opsis_results: tool({"));
  assertStringIncludes(desc, "read pending runs with opsis_results first");
});
