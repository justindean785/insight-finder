// lib/run_lease_test.ts — S1a: admission is ATOMIC, or it is not admission.
//
// Measured 2026-10-03..10 (audit bundle, 94 invocations): 12 overlapping invocation pairs
// across 9 threads, 21 invocations in total; the three runs on thread cfe70631 started
// 05:59:00, 06:01:39 and 06:02:19 and all carried `premature_client_cancel`. The cause is
// structural: `markRunStarted` is an UNCONDITIONAL update, so a second request while a
// heartbeat is alive simply starts a second run. These tests drive the real
// `acquireRunLease` through a fake PostgREST chain and assert the decision the row's own
// state produces — and the wiring test at the bottom asserts the lease sits BEFORE the user
// message insert, so a refused send leaves no orphan message.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acquireRunLease,
  leaseAdmissionFilter,
  releaseRunLease,
  RUN_LEASE_STALE_MS,
  runLeaseRefusalResponse,
  runLeaseSelfTest,
} from "./run-lease.ts";

const KILL = "RUN_LEASE_DISABLED";
const NOW = new Date("2026-10-10T06:01:39.882Z");

type Call = { op: string; args: unknown[] };

/** A fake supabase-js chain: records every call, resolves the terminal `.select()` /
 *  `.maybeSingle()` with the canned answers. */
function fakeDb(answers: { update?: { data?: unknown; error?: { message: string } | null }; row?: unknown; throwOn?: string }) {
  const calls: Call[] = [];
  const chain = (table: string, kind: "update" | "select") => {
    const c: Record<string, unknown> = {};
    const rec = (op: string) => (...args: unknown[]) => {
      calls.push({ op: `${table}.${op}`, args });
      if (answers.throwOn === op) throw new Error(`boom at ${op}`);
      return c;
    };
    for (const op of ["eq", "or", "update", "select", "maybeSingle"]) c[op] = rec(op);
    // terminal awaits
    c.then = (res: (v: unknown) => void) =>
      res(kind === "update" ? { data: answers.update?.data ?? [], error: answers.update?.error ?? null } : { data: answers.row ?? null, error: null });
    // an `.update()` chain ending in `.select()` must still resolve as the update
    c.select = (...args: unknown[]) => { calls.push({ op: `${table}.select`, args }); return c; };
    return c;
  };
  let selects = 0;
  const db = {
    from: (table: string) => ({
      update: (patch: unknown) => { calls.push({ op: `${table}.update`, args: [patch] }); return chain(table, "update"); },
      select: (cols: string) => { selects++; calls.push({ op: `${table}.select`, args: [cols] }); return chain(table, "select"); },
    }),
  };
  return { db, calls, selectCount: () => selects };
}

Deno.test("the admission filter admits only a thread with no LIVE run, by the same 75 s bar recovery uses", () => {
  const f = leaseAdmissionFilter(NOW.getTime());
  assertEquals(RUN_LEASE_STALE_MS, 75_000);
  assertEquals(
    f,
    "status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.2026-10-10T06:00:24.882Z",
  );
});

Deno.test("a thread with no live run is admitted and the lease write is the run marker", async () => {
  Deno.env.delete(KILL);
  const PRIOR = { status: "finished", run_started_at: "2026-10-09T10:00:00.000Z", last_heartbeat_at: "2026-10-09T10:02:00.000Z", recovered_at: null, recovery_reason: null };
  const { db, calls } = fakeDb({ update: { data: [{ id: "t1" }] }, row: PRIOR });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, true);
  if (r.admitted) { assertEquals(r.mode, "leased"); assertEquals(r.prior, PRIOR); }
  const upd = calls.find((c) => c.op === "threads.update");
  assert(upd, "lease must be an UPDATE on threads");
  const patch = upd.args[0] as Record<string, unknown>;
  assertEquals(patch.status, "active");
  assertEquals(patch.run_started_at, NOW.toISOString());
  assertEquals(patch.last_heartbeat_at, NOW.toISOString());
  assertEquals(patch.recovered_at, null);
  assertEquals(patch.recovery_reason, null);
  // The write is CONDITIONAL: scoped to the owner and gated by the admission filter.
  assert(calls.some((c) => c.op === "threads.eq" && c.args[0] === "id" && c.args[1] === "t1"));
  assert(calls.some((c) => c.op === "threads.eq" && c.args[0] === "user_id" && c.args[1] === "u1"));
  const or = calls.find((c) => c.op === "threads.or");
  assert(or, "the admission filter must be applied to the UPDATE itself, never checked in a prior read");
  assertEquals(or.args[0], leaseAdmissionFilter(NOW.getTime()));
});

Deno.test("a live heartbeat REFUSES admission with the live marker and a retry hint", async () => {
  Deno.env.delete(KILL);
  const hb = new Date(NOW.getTime() - 20_000).toISOString();
  const { db } = fakeDb({ update: { data: [] }, row: { last_heartbeat_at: hb, run_started_at: "2026-10-10T05:59:00.134Z" } });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, false);
  if (!r.admitted) {
    assertEquals(r.code, "RUN_IN_PROGRESS");
    assertEquals(r.lastHeartbeatAt, hb);
    assertEquals(r.runStartedAt, "2026-10-10T05:59:00.134Z");
    // 75 s bar minus the 20 s already elapsed.
    assertEquals(r.retryAfterMs, 55_000);
    const res = runLeaseRefusalResponse(r, { "X-Test": "1" });
    assertEquals(res.status, 409);
    assertEquals(res.headers.get("X-Test"), "1");
    assertEquals(res.headers.get("Retry-After"), "55");
    const body = await res.json();
    assertEquals(body.code, "RUN_IN_PROGRESS");
    assertStringIncludes(String(body.detail), "still running");
  }
});

Deno.test("a database error FAILS OPEN, loudly — a telemetry fault must not lock the analyst out", async () => {
  Deno.env.delete(KILL);
  const { db } = fakeDb({ update: { error: { message: "connection reset" } } });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, true);
  if (r.admitted) assertEquals(r.mode, "fail_open");
});

Deno.test("a thrown client error also fails open", async () => {
  Deno.env.delete(KILL);
  const { db } = fakeDb({ update: { data: [] }, throwOn: "or" });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, true);
  if (r.admitted) assertEquals(r.mode, "fail_open");
});

Deno.test("kill switch: RUN_LEASE_DISABLED=true admits without touching the database", async () => {
  Deno.env.set(KILL, "true");
  try {
    const { db, calls } = fakeDb({ update: { data: [] } });
    const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
    assertEquals(r.admitted, true);
    if (r.admitted) assertEquals(r.mode, "disabled");
    assertEquals(calls.length, 0);
    assertEquals(runLeaseSelfTest().detail, "LEGACY via RUN_LEASE_DISABLED — admission is unconditional");
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("release restores the prior row state, only while this lease's own marker is on the row", async () => {
  Deno.env.delete(KILL);
  const PRIOR = { status: "finished", run_started_at: "2026-10-09T10:00:00.000Z", last_heartbeat_at: "2026-10-09T10:02:00.000Z", recovered_at: "2026-10-09T10:05:00.000Z", recovery_reason: "stale heartbeat recovered by sweeper" };
  const lease = { admitted: true as const, mode: "leased" as const, startedAt: NOW.toISOString(), prior: PRIOR };
  const { db, calls } = fakeDb({ update: { data: [{ id: "t1" }] } });
  assertEquals(await releaseRunLease(db as never, "t1", lease, "credit_gate_402"), true);
  const upd = calls.find((c) => c.op === "threads.update");
  assert(upd);
  const patch = upd.args[0] as Record<string, unknown>;
  for (const k of Object.keys(PRIOR)) assertEquals(patch[k], (PRIOR as Record<string, unknown>)[k], k);
  // Conditional on OUR marker: a later run that took over is never clobbered.
  assert(calls.some((c) => c.op === "threads.eq" && c.args[0] === "run_started_at" && c.args[1] === NOW.toISOString()));
  assert(calls.some((c) => c.op === "threads.eq" && c.args[0] === "status" && c.args[1] === "active"));
});

Deno.test("release without a snapshot clears the marker (I-1: no marker is not a run), and a non-lease is a no-op", async () => {
  Deno.env.delete(KILL);
  const { db, calls } = fakeDb({ update: { data: [{ id: "t1" }] } });
  const lease = { admitted: true as const, mode: "leased" as const, startedAt: NOW.toISOString(), prior: null };
  assertEquals(await releaseRunLease(db as never, "t1", lease, "x"), true);
  const patch = (calls.find((c) => c.op === "threads.update")!.args[0]) as Record<string, unknown>;
  assertEquals(patch.run_started_at, null);
  assertEquals(patch.last_heartbeat_at, null);
  assertEquals(patch.status, "active");
  const before = calls.length;
  assertEquals(await releaseRunLease(db as never, "t1", { admitted: true, mode: "disabled", startedAt: "x", prior: null }, "x"), false);
  assertEquals(await releaseRunLease(db as never, "t1", null, "x"), false);
  assertEquals(calls.length, before, "nothing to release ⇒ no database call");
});

Deno.test("/health self-test is ok when the rule is on", () => {
  Deno.env.delete(KILL);
  const s = runLeaseSelfTest();
  assertEquals(s.ok, true);
  assertStringIncludes(s.detail, "409");
});

// ---- wiring: the lease must be taken BEFORE the user message is stored -------------------
const AUTH = await Deno.readTextFile(new URL("../auth.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("../health-handler.ts", import.meta.url));

Deno.test("wiring: setupRequest takes the lease after stale recovery and before the messages insert", () => {
  const recover = AUTH.indexOf("recoverStaleThreadById(");
  const lease = AUTH.indexOf("acquireRunLease(");
  const insert = AUTH.indexOf('.from("messages")');
  assert(recover > 0 && lease > 0 && insert > 0, "all three call sites must exist in auth.ts");
  assert(recover < lease, "stale recovery must run first so a dead run is closed before the lease is judged");
  assert(lease < insert, "a refused send must leave no orphan user message");
  assertStringIncludes(AUTH, "runLeaseRefusalResponse(", "a refusal must be thrown as a Response, like THREAD_ACCESS_DENIED");
});

const INDEX = await Deno.readTextFile(new URL("../index.ts", import.meta.url));

Deno.test("wiring: every early exit between setupRequest and the heartbeat start releases the lease", () => {
  const setup = INDEX.indexOf("await setupRequest(req)");
  const heartbeat = INDEX.indexOf("startRunHeartbeat(supabaseAdmin");
  assert(setup > 0 && heartbeat > setup);
  const between = INDEX.slice(setup, heartbeat);
  const exits = between.split("status: 402").length - 1;
  const releases = between.split("releaseRunLease(").length - 1;
  assertEquals(exits, 2, "this test knows about exactly two credit-gate 402 exits; update it with the code");
  assertEquals(releases, exits, "each 402 exit must release the lease it took");
});

Deno.test("wiring: /health carries the proof key", () => {
  assertStringIncludes(HEALTH, "r.checks.run_lease = runLeaseSelfTest()");
});
