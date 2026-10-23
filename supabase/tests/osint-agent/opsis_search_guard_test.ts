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
import { OPSIS_COLLECT_BUDGET_MS, requiredCompletionMs } from "../../functions/osint-agent/orchestrator-finalize.ts";
import {
  MAX_UNCOLLECTED_OPSIS_RUNS,
  OPSIS_GUARD_NOTE_CAP,
  OPSIS_GUARD_NOTE_DEADLINE,
  clearOpsisGuardThread,
  decideOpsisSearch,
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
  assert(!both.allow && both.reason === "uncollected_cap", "the cap is the first reason named");
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
  noteOpsisSearchOutcome(t, { ok: true, partial: true, run_id: "a" });
  noteOpsisSearchOutcome(t, { ok: true, partial: true, run_id: "b" });
  noteOpsisSearchOutcome(t, { ok: true, complete: true, run_id: "c" });
  noteOpsisSearchOutcome(t, { ok: false, run_status: "failed", run_id: "d" });
  noteOpsisSearchOutcome(t, { ok: false, skipped: true }); // no run id: nothing to track
  assertEquals(uncollectedOpsisRuns(t), ["a", "b"]);
  noteOpsisResultsOutcome(t, { ok: true, partial: true, run_id: "a" }); // a read, even partial, retires the run
  assertEquals(uncollectedOpsisRuns(t), ["b"]);
  noteOpsisResultsOutcome(t, { ok: false, error: "x" }, "b"); // a failed read names the run it asked for
  assertEquals(uncollectedOpsisRuns(t), []);
  // The SDK envelope shape and ids replayed from history.
  noteOpsisSearchOutcome(t, { type: "json", value: { ok: true, partial: true, run_id: "e" } });
  assertEquals(uncollectedOpsisRuns(t, ["e", "f", " ", "f"]), ["e", "f"]);
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
function db(): SupabaseClient {
  const inert = chain({ data: [], error: null });
  return { from: () => inert, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

let seq = 0;
function harness(opts: { remainingMs: () => number; replayed?: () => string[]; partial?: boolean }) {
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
    pendingOpsisRunIds: opts.replayed ?? (() => []),
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
  const h = harness({ remainingMs: () => opsisSearchNeededMs() * 2, replayed: () => ["hist-1", "hist-2"] });
  const out = await h.exec("opsis_search")({ kind: "email", value: "guard.person@example.test" }, o());
  assertEquals(h.calls.search, 0);
  assertEquals(out.opsis_guard, "uncollected_cap");
  assertEquals(out.pending_run_ids, ["hist-1", "hist-2"]);
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
    const h = harness({ remainingMs: () => 0, replayed: () => ["a", "b", "c"] });
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
  assert(cache.includes('if (name === "opsis_search") noteOpsisSearchOutcome(ctx.investigationId, result);'));
  assert(cache.includes('if (name === "opsis_results") noteOpsisResultsOutcome(ctx.investigationId, result'));
  const index = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(index.includes("pendingOpsisRunIds: () => latestPendingOpsisRunIds,"));
  assert(index.includes("remainingRunMs: () => ORCHESTRATOR_WALL_CLOCK_MS - (Date.now() - runStartedAt),"));
  assert(index.includes("latestPendingOpsisRunIds = pendingOpsisRuns(stepMessages as Array<{ content?: unknown }>).map((r) => r.run_id);"));
  const health = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.opsis_search_guard = opsisSearchGuardSelfTest();"));
  const registry = await Deno.readTextFile(new URL("../../functions/osint-agent/tool-registry.ts", import.meta.url));
  const desc = registry.slice(registry.indexOf("opsis_search: tool({"), registry.indexOf("opsis_results: tool({"));
  assertStringIncludes(desc, "read pending runs with opsis_results first");
});
