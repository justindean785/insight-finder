// lib/run_lease_test.ts — S1a: admission is ATOMIC and VERSIONED, or it is not admission.
//
// Measured 2026-10-03..10 (audit bundle, 94 invocations): 12 overlapping invocation pairs
// across 9 threads, 21 invocations in total; the three runs on thread cfe70631 started
// 05:59:00, 06:01:39 and 06:02:19 and all carried `premature_client_cancel`. The cause is
// structural: `markRunStarted` is an UNCONDITIONAL update. These tests drive the real
// `acquireRunLease` / `releaseRunLease` / `withLeaseCleanup` through a STATEFUL fake
// PostgREST chain that evaluates the same predicates a row would, so the version miss,
// the finish-between-read-and-write interleaving (review finding 2) and the failed-setup
// cleanup (review finding 1) are exercised as behaviour, not described.
// `.github/ci/assert-run-lease.sql` drives the SQL predicate on a real Postgres.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS } from "../../../functions/osint-agent/orchestrator-budget.ts";
import {
  acquireRunLease,
  admitsRow,
  leaseAdmissionFilter,
  releaseRunLease,
  RUN_LEASE_MAX_RUN_MS,
  RUN_LEASE_STALE_MS,
  runLeaseRefusalResponse,
  runLeaseSelfTest,
  withLeaseCleanup,
  type RunRowVersion,
} from "../../../functions/osint-agent/lib/run-lease.ts";

const KILL = "RUN_LEASE_DISABLED";
const NOW = new Date("2026-10-10T06:01:39.882Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const row = (p: Partial<RunRowVersion>): RunRowVersion => ({
  status: "active", run_started_at: null, last_heartbeat_at: null, recovered_at: null, recovery_reason: null, ...p,
});

type Call = { op: string; args: unknown[] };

/** A STATEFUL fake: one `threads` row. `.update()` applies the patch only when every
 *  `.eq`/`.is` filter and the `.or(admission)` clause hold against the CURRENT row, like
 *  Postgres would; `.select()` after a read returns the current row. `between` lets a test
 *  mutate the row between the read and the update (the race in review finding 2). */
function fakeDb(initial: RunRowVersion | null, opts: { between?: (r: RunRowVersion) => RunRowVersion; failUpdate?: string; throwOn?: string } = {}) {
  const calls: Call[] = [];
  let current = initial ? { ...initial } : null;
  const db = {
    row: () => current,
    calls,
    from: (table: string) => {
      const filters: Array<(r: RunRowVersion) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      let mode: "read" | "update" = "read";
      let reads = 0;
      const c: Record<string, unknown> = {};
      const rec = (op: string, fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
        calls.push({ op: `${table}.${op}`, args });
        if (opts.throwOn === op) throw new Error(`boom at ${op}`);
        fn(...args);
        return c;
      };
      c.update = rec("update", (p) => { mode = "update"; patch = p as Record<string, unknown>; });
      c.select = rec("select", () => {});
      c.maybeSingle = rec("maybeSingle", () => {});
      c.eq = rec("eq", (col, v) => {
        if (col === "id" || col === "user_id") return;
        filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === v);
      });
      c.is = rec("is", (col) => filters.push((r) => (r as unknown as Record<string, unknown>)[col as string] === null));
      c.or = rec("or", (f) => {
        const m = /last_heartbeat_at\.lt\.([^,]+)/.exec(String(f));
        const cutoff = m ? new Date(m[1]).getTime() : NaN;
        const ms = /run_started_at\.lt\.([^,]+)/.exec(String(f));
        const oldestStart = ms ? new Date(ms[1]).getTime() : NaN;
        filters.push((r) =>
          r.status === null || r.status !== "active" ||
          r.run_started_at === null || new Date(r.run_started_at).getTime() < oldestStart ||
          r.last_heartbeat_at === null || new Date(r.last_heartbeat_at).getTime() < cutoff
        );
      });
      c.then = (res: (v: unknown) => void) => {
        if (mode === "read") {
          reads++;
          return res({ data: current ? { ...current } : null, error: null });
        }
        if (opts.failUpdate) return res({ data: null, error: { message: opts.failUpdate } });
        if (opts.between && current) { current = opts.between(current); opts.between = undefined; }
        const ok = current !== null && filters.every((f) => f(current!));
        if (ok && patch) current = { ...current!, ...(patch as Partial<RunRowVersion>) } as RunRowVersion;
        return res({ data: ok ? [{ id: "t1" }] : [], error: null });
      };
      return c;
    },
  };
  return db;
}

Deno.test("the admission filter admits only a thread with no LIVE run, by the same 75 s bar recovery uses", () => {
  assertEquals(RUN_LEASE_STALE_MS, 75_000);
  assertEquals(
    leaseAdmissionFilter(NOW.getTime()),
    "status.is.null,status.neq.active,run_started_at.is.null,run_started_at.lt.2026-10-10T05:55:39.882Z,last_heartbeat_at.is.null,last_heartbeat_at.lt.2026-10-10T06:00:24.882Z",
  );
  // The run wall the guard keys on must cover a real run with headroom for finalize.
  assert(RUN_LEASE_MAX_RUN_MS >= 2 * ORCHESTRATOR_WALL_CLOCK_MS, "max run must be at least twice the orchestrator wall clock");
});

Deno.test("incident 2026-10-10: a fresh heartbeat with NO run start, or on an ancient start, is NOT a live run", () => {
  const t = NOW.getTime();
  // Thread 6d55b8da: created 09:35:56, client stamped heartbeat 09:36:11, run_started_at NULL.
  assertEquals(admitsRow(row({ last_heartbeat_at: ago(1_000) }), t), true, "client-stamp shape on a blank thread");
  // Thread cfe70631: run_started_at 06:02:19, client stamped heartbeat 09:36:34 (3.5 h later).
  assertEquals(admitsRow(row({ run_started_at: ago(3.5 * 3_600_000), last_heartbeat_at: ago(1_000) }), t), true, "foreign stamp on an old start");
  // A genuinely live run: started 40 s ago, pulsing.
  assertEquals(admitsRow(row({ run_started_at: ago(40_000), last_heartbeat_at: ago(5_000) }), t), false, "real live run");
  // Exactly at the run wall: strict <, so a start exactly MAX_RUN ago still counts as live.
  assertEquals(admitsRow(row({ run_started_at: ago(RUN_LEASE_MAX_RUN_MS), last_heartbeat_at: ago(5_000) }), t), false);
  assertEquals(admitsRow(row({ run_started_at: ago(RUN_LEASE_MAX_RUN_MS + 1), last_heartbeat_at: ago(5_000) }), t), true);
});

Deno.test("predicate matrix: blank, fresh, stale, exact threshold, finished, stopped, null status", () => {
  const t = NOW.getTime();
  const cases: Array<[string, RunRowVersion | null, boolean]> = [
    ["blank thread (active, heartbeat NULL) — I-1: no marker is not a run", row({}), true],
    ["active + fresh heartbeat (20 s) + recent start", row({ run_started_at: ago(30_000), last_heartbeat_at: ago(20_000) }), false],
    ["active + exactly 75 s is NOT yet stale (strict <)", row({ run_started_at: ago(90_000), last_heartbeat_at: ago(75_000) }), false],
    ["active + 75 s + 1 ms is stale", row({ run_started_at: ago(90_000), last_heartbeat_at: ago(75_001) }), true],
    ["active + fresh heartbeat but NO run start (client stamp)", row({ last_heartbeat_at: ago(20_000) }), true],
    ["active + old heartbeat + run marker (dead run)", row({ run_started_at: ago(90_000), last_heartbeat_at: ago(80_000) }), true],
    ["finished + fresh heartbeat (terminal write just landed)", row({ status: "finished", last_heartbeat_at: ago(1_000) }), true],
    ["stopped + fresh heartbeat (admitted — stated S1a limit)", row({ status: "stopped", last_heartbeat_at: ago(1_000) }), true],
    ["status NULL", row({ status: null, last_heartbeat_at: ago(1_000) }), true],
    ["no row", null, false],
  ];
  for (const [name, r, want] of cases) assertEquals(admitsRow(r, t), want, name);
});

Deno.test("a thread with no live run is admitted; the UPDATE is conditional on admission AND on the row version it read", async () => {
  Deno.env.delete(KILL);
  const prior = row({ status: "finished", run_started_at: "2026-10-09T10:00:00.000Z", last_heartbeat_at: "2026-10-09T10:02:00.000Z" });
  const db = fakeDb(prior);
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, true);
  if (r.admitted) { assertEquals(r.mode, "leased"); assertEquals(r.prior, prior); }
  assertEquals(db.row(), { status: "active", run_started_at: NOW.toISOString(), last_heartbeat_at: NOW.toISOString(), recovered_at: null, recovery_reason: null, updated_at: NOW.toISOString() } as unknown as RunRowVersion);
  const upd = db.calls.find((c) => c.op === "threads.update");
  assert(upd, "lease must be an UPDATE on threads");
  assert(db.calls.some((c) => c.op === "threads.eq" && c.args[0] === "user_id" && c.args[1] === "u1"));
  assert(db.calls.some((c) => c.op === "threads.or" && c.args[0] === leaseAdmissionFilter(NOW.getTime())), "admission clause on the UPDATE itself");
  assert(db.calls.some((c) => c.op === "threads.eq" && c.args[0] === "status" && c.args[1] === "finished"), "version clause: status as read");
  assert(db.calls.some((c) => c.op === "threads.eq" && c.args[0] === "last_heartbeat_at" && c.args[1] === prior.last_heartbeat_at), "version clause: heartbeat as read");
  assert(db.calls.some((c) => c.op === "threads.is" && c.args[0] === "recovered_at"), "version clause: NULLs via .is()");
});

Deno.test("a live heartbeat REFUSES admission with the live marker and a retry hint, and writes nothing", async () => {
  Deno.env.delete(KILL);
  const live = row({ run_started_at: ago(60_000), last_heartbeat_at: ago(20_000) });
  const db = fakeDb(live);
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, false);
  assertEquals(db.row(), live, "a refusal never touches the row");
  assert(!db.calls.some((c) => c.op === "threads.update"));
  if (!r.admitted && r.code === "RUN_IN_PROGRESS") {
    assertEquals(r.lastHeartbeatAt, live.last_heartbeat_at);
    assertEquals(r.runStartedAt, live.run_started_at);
    assertEquals(r.retryAfterMs, 55_000);
    const res = runLeaseRefusalResponse(r, { "X-Test": "1" });
    assertEquals(res.status, 409);
    assertEquals(res.headers.get("X-Test"), "1");
    assertEquals(res.headers.get("Retry-After"), "55");
    const body = await res.json();
    assertEquals(body.code, "RUN_IN_PROGRESS");
    assertStringIncludes(String(body.detail), "active on this case right now");
  } else throw new Error("expected RUN_IN_PROGRESS");
});

Deno.test("finding 2: a run that FINISHES between the read and the UPDATE is never resurrected by release", async () => {
  Deno.env.delete(KILL);
  // A is active and alive at the first read … no: for the race to matter the first read
  // must be admissible. Model it exactly as the review did: snapshot sees A active with a
  // STALE heartbeat (admissible), A's terminal write lands (finished) before B's UPDATE.
  const aActive = row({ run_started_at: ago(100_000), last_heartbeat_at: ago(80_000) });
  const aFinished = row({ status: "finished", run_started_at: ago(100_000), last_heartbeat_at: ago(1_000) });
  const db = fakeDb(aActive, { between: () => aFinished });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  // The first UPDATE missed its version clause; the retry read the finished row and leased it.
  assertEquals(r.admitted, true);
  if (!r.admitted) throw new Error("expected admission on retry");
  assertEquals(r.prior, aFinished, "the snapshot is the row version the UPDATE actually replaced");
  assert(db.calls.some((c) => c.op === "threads.update"));
  assertEquals(db.calls.filter((c) => c.op === "threads.update").length, 2, "one version miss, one success");
  // B is refused by the credit gate and releases: the row goes back to FINISHED, not to A-active.
  assertEquals(await releaseRunLease(db as never, "t1", r, "credit_gate_402"), true);
  assertEquals(db.row()?.status, "finished");
  assertEquals(db.row()?.last_heartbeat_at, aFinished.last_heartbeat_at);
});

Deno.test("a run that goes LIVE between the read and the UPDATE is refused, not retried into a lease", async () => {
  Deno.env.delete(KILL);
  const blank = row({});
  const db = fakeDb(blank, { between: () => row({ run_started_at: ago(500), last_heartbeat_at: ago(500) }) });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, false);
  if (!r.admitted) assertEquals(r.code, "RUN_IN_PROGRESS");
});

Deno.test("finding 4: a database error FAILS CLOSED with a retryable 503 — no message, no paid work", async () => {
  Deno.env.delete(KILL);
  const db = fakeDb(row({}), { failUpdate: "connection reset" });
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  assertEquals(r.admitted, false);
  if (!r.admitted && r.code === "RUN_LEASE_UNAVAILABLE") {
    assertStringIncludes(r.reason, "connection reset");
    const res = runLeaseRefusalResponse(r, {});
    assertEquals(res.status, 503);
    assertEquals(res.headers.get("Retry-After"), "5");
    assertStringIncludes(String((await res.json()).detail), "Nothing was sent or charged");
  } else throw new Error("expected RUN_LEASE_UNAVAILABLE");
});

Deno.test("a thrown client error and a missing row also fail closed", async () => {
  Deno.env.delete(KILL);
  const thrown = await acquireRunLease(fakeDb(row({}), { throwOn: "or" }) as never, "t1", "u1", { now: NOW });
  assertEquals(thrown.admitted, false);
  if (!thrown.admitted) assertEquals(thrown.code, "RUN_LEASE_UNAVAILABLE");
  const missing = await acquireRunLease(fakeDb(null) as never, "t1", "u1", { now: NOW });
  assertEquals(missing.admitted, false);
  if (!missing.admitted) assertEquals(missing.code, "RUN_LEASE_UNAVAILABLE");
});

Deno.test("kill switch: RUN_LEASE_DISABLED=true admits without touching the database, and such a lease releases nothing", async () => {
  Deno.env.set(KILL, "true");
  try {
    const db = fakeDb(row({ last_heartbeat_at: ago(1_000) }));
    const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
    assertEquals(r.admitted, true);
    if (r.admitted) assertEquals(r.mode, "disabled");
    assertEquals(db.calls.length, 0);
    if (r.admitted) assertEquals(await releaseRunLease(db as never, "t1", r, "x"), false);
    assertEquals(db.calls.length, 0);
    assertEquals(runLeaseSelfTest().detail, "LEGACY via RUN_LEASE_DISABLED — admission is unconditional");
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("release restores the replaced version only while this lease's own marker is on the row", async () => {
  Deno.env.delete(KILL);
  const prior = row({ status: "finished", run_started_at: "2026-10-09T10:00:00.000Z", last_heartbeat_at: "2026-10-09T10:02:00.000Z", recovered_at: "2026-10-09T10:05:00.000Z", recovery_reason: "stale heartbeat recovered by sweeper" });
  const db = fakeDb(prior);
  const r = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  if (!r.admitted) throw new Error("expected lease");
  assertEquals(await releaseRunLease(db as never, "t1", r, "setup_failed"), true);
  const after = db.row() as unknown as Record<string, unknown>;
  for (const k of Object.keys(prior)) assertEquals(after[k], (prior as unknown as Record<string, unknown>)[k], k);
  // A later run took the row (different run_started_at): our stale release must be a no-op.
  const db2 = fakeDb(row({ run_started_at: ago(10), last_heartbeat_at: ago(10) }));
  assertEquals(await releaseRunLease(db2 as never, "t1", r, "setup_failed"), false);
  assertEquals(db2.row()?.run_started_at, ago(10));
});

Deno.test("finding 1: withLeaseCleanup releases on a throw (preserving a thrown Response) and not on success", async () => {
  Deno.env.delete(KILL);
  const db = fakeDb(row({}));
  const lease = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  if (!lease.admitted) throw new Error("expected lease");
  assertEquals(db.row()?.status, "active");
  assertEquals(db.row()?.run_started_at, NOW.toISOString());
  const thrown = new Response("bad parts", { status: 400 });
  const err = await assertRejects(() => withLeaseCleanup(db as never, "t1", lease, "setup_failed", () => Promise.reject(thrown)));
  assert(err === thrown, "the original throw is rethrown as-is");
  assertEquals(db.row()?.run_started_at, null, "the marker is gone: a blank thread again, not a ghost run");
  // Success path: nothing released.
  const lease2 = await acquireRunLease(db as never, "t1", "u1", { now: NOW });
  if (!lease2.admitted) throw new Error("expected lease");
  assertEquals(await withLeaseCleanup(db as never, "t1", lease2, "setup_failed", () => Promise.resolve(42)), 42);
  assertEquals(db.row()?.run_started_at, NOW.toISOString());
});

Deno.test("/health self-test is ok when the rule is on", () => {
  Deno.env.delete(KILL);
  const s = runLeaseSelfTest();
  assertEquals(s.ok, true);
  assertStringIncludes(s.detail, "409");
  assertStringIncludes(s.detail, "503");
});

// ---- wiring --------------------------------------------------------------------------------
const AUTH = await Deno.readTextFile(new URL("../../../functions/osint-agent/auth.ts", import.meta.url));
const INDEX = await Deno.readTextFile(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));

Deno.test("wiring: setupRequest takes the lease after stale recovery and runs the message insert under cleanup", () => {
  const recover = AUTH.indexOf("recoverStaleThreadById(");
  const lease = AUTH.indexOf("acquireRunLease(");
  const cleanup = AUTH.indexOf('withLeaseCleanup(leaseDb, threadId, lease, "setup_failed"');
  const insert = AUTH.indexOf('.from("messages")');
  assert(recover > 0 && lease > 0 && cleanup > 0 && insert > 0, "all four call sites must exist in auth.ts");
  assert(recover < lease, "stale recovery must run first so a dead run is closed before the lease is judged");
  assert(lease < cleanup && cleanup < insert, "the insert must run INSIDE the cleanup scope, after the lease");
  assertStringIncludes(AUTH, "runLeaseRefusalResponse(", "a refusal must be thrown as a Response, like THREAD_ACCESS_DENIED");
});

Deno.test("wiring: index.ts holds the lease as startup state, releases it in the outer catch, and clears it at the heartbeat handoff", () => {
  const setup = INDEX.indexOf("await setupRequest(req)");
  const hold = INDEX.indexOf("startupLease = { db:");
  const handoff = INDEX.indexOf("startupLease = null;\n    heartbeat = startRunHeartbeat(");
  const catchRelease = INDEX.indexOf('"startup_failed"');
  assert(setup > 0 && hold > setup && handoff > hold && catchRelease > handoff, "hold after setup, clear at handoff, release in the catch");
  const between = INDEX.slice(setup, handoff);
  assertEquals(between.split("status: 402").length - 1, 2, "this test knows about exactly two credit-gate 402 exits; update it with the code");
  assertEquals(between.split("releaseRunLease(").length - 1, 2, "each 402 exit releases explicitly");
});

Deno.test("wiring: /health carries the proof key", () => {
  assertStringIncludes(HEALTH, "r.checks.run_lease = runLeaseSelfTest()");
});
