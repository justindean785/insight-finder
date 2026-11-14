// Maintenance lockdown (2026-11-14): WHO may trigger the /health maintenance sweeps.
//
// Anonymous `?health=1&maintenance=1` used to run all-users maintenance with the
// service role. After the lockdown:
//   anonymous → liveness only, no service-role client, no maintenance read/write
//   user JWT  → recovery + rejected-cluster sweep, scoped to the VERIFIED user id
//   secret    → all-users maintenance, as before
// All ids, tokens and secrets below are synthetic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleHealthProbe, type HealthProbeDeps } from "../../functions/osint-agent/health-handler.ts";
import {
  bearerToken, constantTimeEqual, maintenanceAuthSelfTest, maintenanceLockdownDisabled,
  MAINTENANCE_REFUSED_DETAIL, resolveMaintenanceAccess, type MaintenanceAccessDeps,
} from "../../functions/osint-agent/lib/maintenance-access.ts";
import { recoverStaleActiveThreads, STALE_RUN_AFTER_MS } from "../../functions/osint-agent/recovery.ts";
import { resetSweepMemo, sweepRejectedClusterAssignments } from "../../functions/osint-agent/lib/rejected-cluster-sweep.ts";

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const THREAD_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const THREAD_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const SECRET = "synthetic-operator-secret-0123456789";
const TOKEN_A = "synthetic.jwt.user-a";

const MAINT_KEYS = ["recovery", "rejected_cluster_sweep", "credentials", "synthesis", "cache_sweep"];

// ---------------------------------------------------------------------------
// A recording fake of the PostgREST builder: every filter, read and write is
// logged; `threads` and `artifact_reviews` reads honour `eq` filters so a scoped
// query genuinely returns only the scoped rows.
// ---------------------------------------------------------------------------
type Op = { table: string; op: "select" | "update" | "insert" | "delete"; filters: Array<[string, string, unknown]>; patch?: unknown };
function makeDb(seed: Record<string, Array<Record<string, unknown>>>) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const rec: Op = { table, op: "select", filters: [] };
    ops.push(rec);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {};
    for (const m of ["select", "or", "order", "limit", "in", "range", "not", "gte", "lt", "neq"]) c[m] = () => c;
    c.eq = (col: string, v: unknown) => { rec.filters.push(["eq", col, v]); return c; };
    c.is = (col: string, v: unknown) => { rec.filters.push(["is", col, v]); return c; };
    c.update = (patch: unknown) => { rec.op = "update"; rec.patch = patch; return c; };
    c.delete = () => { rec.op = "delete"; return c; };
    c.insert = (row: unknown) => { rec.op = "insert"; rec.patch = row; return Promise.resolve({ data: null, error: null }); };
    // An `update(...)` returns the rows its `eq` filters match, as PostgREST does
    // with `.select()`, so a guarded recovery claim on a real row WINS. Without
    // this the fake made every claim lose and "recovered" could never be proven.
    const result = () => {
      if (rec.op === "delete" || rec.op === "insert") return { data: [], error: null, count: 0 };
      let rows = seed[table] ?? [];
      for (const [kind, col, v] of rec.filters) {
        if (kind === "eq") rows = rows.filter((r) => r[col] === v);
      }
      return { data: rows, error: null, count: rows.length };
    };
    c.maybeSingle = () => Promise.resolve({ data: (result().data as unknown[])[0] ?? null, error: null });
    c.single = c.maybeSingle;
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
    return c;
  };
  return { from, ops };
}

const staleIso = () => new Date(Date.now() - STALE_RUN_AFTER_MS - 60_000).toISOString();
function staleThread(id: string, user: string) {
  const t = staleIso();
  return { id, user_id: user, title: "synthetic", seed_value: "jordan.vale@example.test", status: "active", run_started_at: t, last_heartbeat_at: t, updated_at: t };
}

function spyDeps(overrides: Partial<HealthProbeDeps> = {}) {
  const calls = { createAdmin: 0, recover: [] as unknown[], sweepRejected: [] as unknown[], synthesize: 0, sweepCache: 0, verifyUser: 0 };
  const db = makeDb({});
  const deps: Partial<HealthProbeDeps> = {
    createAdmin: () => { calls.createAdmin++; return db as never; },
    verifyUser: async (h: string) => { calls.verifyUser++; return h === `Bearer ${TOKEN_A}` ? USER_A : null; },
    rateLimit: async () => ({ ok: true }),
    probeSecret: SECRET,
    recover: (async (_db: unknown, opts: unknown) => { calls.recover.push(opts); return { scanned: 0, recovered: 0, assistantInserted: 0, errors: 0 }; }) as never,
    sweepRejected: (async (_db: unknown, opts: unknown) => { calls.sweepRejected.push(opts); return { ok: true, reviews: 0, stale: 0, threads: 0, cleared: 0, errors: 0, skipped: null }; }) as never,
    synthesize: (async () => { calls.synthesize++; return { threadsScanned: 0, findingsWritten: 0, findingsProposed: 0, errors: 0, distribution: { zero: 0, one: 0, twoPlus: 0 } }; }) as never,
    sweepCache: (async () => { calls.sweepCache++; return { scanned: 0, deleted: 0, errors: 0 }; }) as never,
    synthesisScopes: () => ["forward", "backfill"],
    cacheSweepOn: () => true,
    lockdownDisabled: () => false,
    ...overrides,
  };
  return { deps, calls, db };
}

function req(qs: string, headers: Record<string, string> = {}) {
  return new Request(`https://example.test/osint-agent?${qs}`, { method: "GET", headers });
}

// ---------------------------------------------------------------------------
// resolveMaintenanceAccess — the whole decision, table-tested
// ---------------------------------------------------------------------------
const deps: MaintenanceAccessDeps = {
  verifyUser: async (h) => (h === `Bearer ${TOKEN_A}` ? USER_A : null),
  rateLimit: async () => ({ ok: true }),
};
const base = { wantProbe: false, maintenanceAsked: true, suppliedSecret: null, configuredSecret: SECRET, authHeader: null, lockdownDisabled: false };

Deno.test("access: no maintenance asked → none", async () => {
  assertEquals((await resolveMaintenanceAccess({ ...base, maintenanceAsked: false }, deps)).kind, "none");
});
Deno.test("access: anonymous maintenance → anonymous(no_credentials)", async () => {
  assertEquals(await resolveMaintenanceAccess(base, deps), { kind: "anonymous", reason: "no_credentials" });
});
Deno.test("access: a token Supabase Auth rejects → anonymous(invalid_session)", async () => {
  assertEquals(await resolveMaintenanceAccess({ ...base, authHeader: "Bearer synthetic.jwt.forged" }, deps), { kind: "anonymous", reason: "invalid_session" });
});
Deno.test("access: verifier throwing → anonymous, never all-users", async () => {
  const boom: MaintenanceAccessDeps = { ...deps, verifyUser: async () => { throw new Error("auth down"); } };
  assertEquals((await resolveMaintenanceAccess({ ...base, authHeader: `Bearer ${TOKEN_A}` }, boom)).kind, "anonymous");
});
Deno.test("access: a blank user id from the verifier is refused (an unscoped sweep is all-users)", async () => {
  const blank: MaintenanceAccessDeps = { ...deps, verifyUser: async () => "  " };
  assertEquals((await resolveMaintenanceAccess({ ...base, authHeader: `Bearer ${TOKEN_A}` }, blank)).kind, "anonymous");
});
Deno.test("access: verified JWT → user(verified id)", async () => {
  assertEquals(await resolveMaintenanceAccess({ ...base, authHeader: `Bearer ${TOKEN_A}` }, deps), { kind: "user", userId: USER_A });
});
Deno.test("access: throttled user → anonymous(throttled), keyed apart from the chat quota", async () => {
  const keys: string[] = [];
  const t: MaintenanceAccessDeps = { ...deps, rateLimit: async (k) => { keys.push(k); return { ok: false }; } };
  assertEquals(await resolveMaintenanceAccess({ ...base, authHeader: `Bearer ${TOKEN_A}` }, t), { kind: "anonymous", reason: "throttled" });
  assertEquals(keys, [`maint:${USER_A}`]);
});
Deno.test("access: correct secret → operator; wrong secret of the same length → anonymous", async () => {
  assertEquals(await resolveMaintenanceAccess({ ...base, suppliedSecret: SECRET }, deps), { kind: "operator", via: "secret" });
  const wrong = SECRET.slice(0, -1) + "X";
  assertEquals((await resolveMaintenanceAccess({ ...base, suppliedSecret: wrong }, deps)).kind, "anonymous");
});
Deno.test("access: no configured secret fails closed even when the caller sends an empty one", async () => {
  assertEquals((await resolveMaintenanceAccess({ ...base, configuredSecret: "", suppliedSecret: "" }, deps)).kind, "anonymous");
});
Deno.test("access: ?probe=1 with a wrong secret → forbidden (403, as before); with the right one → operator", async () => {
  assertEquals((await resolveMaintenanceAccess({ ...base, wantProbe: true, suppliedSecret: "nope" }, deps)).kind, "forbidden");
  assertEquals((await resolveMaintenanceAccess({ ...base, wantProbe: true, suppliedSecret: SECRET }, deps)).kind, "operator");
  // A valid user JWT never unlocks the paid provider probe.
  assertEquals((await resolveMaintenanceAccess({ ...base, wantProbe: true, authHeader: `Bearer ${TOKEN_A}` }, deps)).kind, "forbidden");
});
Deno.test("access: kill switch MAINTENANCE_LOCKDOWN_DISABLED restores all-users for anonymous", async () => {
  assertEquals(await resolveMaintenanceAccess({ ...base, lockdownDisabled: true }, deps), { kind: "operator", via: "lockdown_disabled" });
  assertEquals(maintenanceLockdownDisabled((k) => (k === "MAINTENANCE_LOCKDOWN_DISABLED" ? "true" : undefined)), true);
  assertEquals(maintenanceLockdownDisabled(() => undefined), false);
});

Deno.test("constantTimeEqual / bearerToken", async () => {
  assertEquals(await constantTimeEqual("abc", "abc"), true);
  assertEquals(await constantTimeEqual("abc", "abd"), false);
  assertEquals(await constantTimeEqual("abc", "abcd"), false);
  assertEquals(await constantTimeEqual("", ""), true);
  assertEquals(bearerToken("Bearer x.y.z"), "x.y.z");
  assertEquals(bearerToken("bearer x"), "x");
  assertEquals(bearerToken("Bearer "), null);
  assertEquals(bearerToken("Basic abc"), null);
  assertEquals(bearerToken(null), null);
});

Deno.test("checks.maintenance_auth self-test passes, and reports LEGACY under the kill switch", async () => {
  assertEquals((await maintenanceAuthSelfTest(false)).ok, true);
  assert((await maintenanceAuthSelfTest(true)).detail.startsWith("LEGACY"));
});

// ---------------------------------------------------------------------------
// handleHealthProbe — the three paths end to end, with spies on every sweep
// ---------------------------------------------------------------------------
Deno.test("anonymous ?maintenance=1: no service-role client, no sweep, no maintenance detail; body = plain probe", async () => {
  const { deps: d, calls } = spyDeps();
  const res = await handleHealthProbe(req("health=1&maintenance=1"), d);
  const body = await res.json();
  assertEquals(calls.createAdmin, 0);
  assertEquals(calls.recover.length + calls.sweepRejected.length + calls.synthesize + calls.sweepCache, 0);
  for (const k of MAINT_KEYS) assertEquals(body.checks[k], undefined, `${k} must not appear for an anonymous caller`);
  assertEquals(body.checks.maintenance, { ok: true, detail: MAINTENANCE_REFUSED_DETAIL });

  const plain = await (await handleHealthProbe(req("health=1"), spyDeps().deps)).json();
  assertEquals(Object.keys(body.checks).sort(), Object.keys(plain.checks).sort());
});

Deno.test("anonymous with a forged token: same as anonymous", async () => {
  const { deps: d, calls } = spyDeps();
  const body = await (await handleHealthProbe(req("health=1&maintenance=1", { Authorization: "Bearer synthetic.jwt.forged" }), d)).json();
  assertEquals(calls.verifyUser, 1);
  assertEquals(calls.createAdmin, 0);
  for (const k of MAINT_KEYS) assertEquals(body.checks[k], undefined);
});

Deno.test("HEALTH_MAINTENANCE_ALWAYS does not hand anonymous callers all-users maintenance", async () => {
  const prev = Deno.env.get("HEALTH_MAINTENANCE_ALWAYS");
  Deno.env.set("HEALTH_MAINTENANCE_ALWAYS", "true");
  try {
    const { deps: d, calls } = spyDeps();
    await handleHealthProbe(req("health=1"), d);
    assertEquals(calls.createAdmin, 0);
  } finally {
    if (prev === undefined) Deno.env.delete("HEALTH_MAINTENANCE_ALWAYS"); else Deno.env.set("HEALTH_MAINTENANCE_ALWAYS", prev);
  }
});

Deno.test("user JWT: recovery + rejected-cluster sweep scoped to the verified id; no synthesis, cache sweep or credential read", async () => {
  const { deps: d, calls, db } = spyDeps();
  const body = await (await handleHealthProbe(
    req(`health=1&maintenance=1&user_id=${USER_B}&thread_id=${THREAD_B}`, { Authorization: `Bearer ${TOKEN_A}` }), d,
  )).json();
  assertEquals(calls.createAdmin, 1);
  assertEquals(calls.recover.length, 1);
  assertEquals((calls.recover[0] as { userId?: string }).userId, USER_A, "the query-string user_id must be ignored");
  assertEquals((calls.sweepRejected[0] as { userId?: string }).userId, USER_A);
  assertEquals(calls.synthesize, 0);
  assertEquals(calls.sweepCache, 0);
  assertEquals(db.ops.filter((o) => o.table === "tool_usage_log").length, 0);
  assertEquals(body.checks.synthesis, undefined);
  assertEquals(body.checks.cache_sweep, undefined);
  assertEquals(body.checks.credentials, undefined);
  assert(String(body.checks.maintenance.detail).includes("scope: user"));
});

Deno.test("operator secret: all-users maintenance exactly as before (unscoped recovery, synthesis, cache sweep)", async () => {
  const { deps: d, calls } = spyDeps();
  const body = await (await handleHealthProbe(req("health=1&maintenance=1", { "x-probe-secret": SECRET }), d)).json();
  assertEquals(calls.recover.length, 1);
  assertEquals((calls.recover[0] as { userId?: string }).userId, undefined);
  assertEquals((calls.sweepRejected[0] as { userId?: string } | undefined)?.userId, undefined);
  assertEquals(calls.synthesize, 2); // both scopes enabled by the spy
  assertEquals(calls.sweepCache, 1);
  assert(body.checks.credentials !== undefined);
});

Deno.test("kill switch: anonymous maintenance runs all-users again", async () => {
  const { deps: d, calls } = spyDeps({ lockdownDisabled: () => true });
  await handleHealthProbe(req("health=1&maintenance=1"), d);
  assertEquals(calls.recover.length, 1);
  assertEquals((calls.recover[0] as { userId?: string }).userId, undefined);
});

Deno.test("?probe=1 with a wrong secret is still 403", async () => {
  const { deps: d, calls } = spyDeps();
  const res = await handleHealthProbe(req("health=1&probe=1", { "x-probe-secret": "wrong" }), d);
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(calls.createAdmin, 0);
});

Deno.test("checks.maintenance_auth is present on a plain probe", async () => {
  const body = await (await handleHealthProbe(req("health=1"), spyDeps().deps)).json();
  assertEquals(body.checks.maintenance_auth?.ok, true);
});

// ---------------------------------------------------------------------------
// The scoped sweeps themselves: user A cannot touch user B's thread, even with
// B's thread id known. The unscoped call is the control that proves the fake
// would have exposed B's row.
// ---------------------------------------------------------------------------
Deno.test("recovery scoped to user A never reads or writes user B's stale thread", async () => {
  const db = makeDb({ threads: [staleThread(THREAD_B, USER_B)] });
  const out = await recoverStaleActiveThreads(db as never, { limit: 20, reason: "synthetic", userId: USER_A });
  assertEquals(out.scanned, 0);
  assertEquals(db.ops.filter((o) => o.op !== "select").length, 0, "no write of any kind");
  const sel = db.ops.find((o) => o.table === "threads");
  assert(sel?.filters.some(([k, c, v]) => k === "eq" && c === "user_id" && v === USER_A));
});

Deno.test("control: unscoped recovery DOES reach user B's stale thread (the fake exposes cross-user rows)", async () => {
  const db = makeDb({ threads: [staleThread(THREAD_B, USER_B)] });
  const out = await recoverStaleActiveThreads(db as never, { limit: 20, reason: "synthetic" });
  assertEquals(out.scanned, 1);
});

Deno.test("recovery with a blank userId fails closed instead of sweeping every user", async () => {
  const db = makeDb({ threads: [staleThread(THREAD_B, USER_B)] });
  const out = await recoverStaleActiveThreads(db as never, { limit: 20, reason: "synthetic", userId: "" });
  assertEquals(out.scanned, 0);
  assertEquals(db.ops.length, 0);
});

Deno.test("recovery scoped to user A still recovers user A's own stale thread", async () => {
  const db = makeDb({ threads: [staleThread(THREAD_A, USER_A), staleThread(THREAD_B, USER_B)] });
  const out = await recoverStaleActiveThreads(db as never, { limit: 20, reason: "synthetic", userId: USER_A });
  assertEquals(out.scanned, 1);
  assertEquals(out.recovered, 1, "user A's own stale thread is actually recovered, not just selected");
  const touched = new Set(db.ops.filter((o) => o.op !== "select").flatMap((o) => o.filters.filter(([, c]) => c === "id" || c === "thread_id").map(([, , v]) => v)));
  assert(touched.has(THREAD_A), "the recovery claim must write user A's thread");
  assert(!touched.has(THREAD_B), "user B's thread must not be written");
});

Deno.test("rejected-cluster sweep scoped to user A reads only A's reviews and skips B's thread even with a review on it", async () => {
  resetSweepMemo();
  const db = makeDb({
    artifact_reviews: [
      { artifact_id: "art-b", thread_id: THREAD_B, user_id: USER_B, state: "dismissed" },
    ],
    artifacts: [{ id: "art-b", thread_id: THREAD_B, cluster_id: "c1", subject_id: null, metadata: {} }],
    threads: [{ id: THREAD_B, user_id: USER_B }],
  });
  const out = await sweepRejectedClusterAssignments(db as never, { userId: USER_A });
  assertEquals(out.reviews, 0);
  assertEquals(db.ops.filter((o) => o.op !== "select").length, 0);
  const rev = db.ops.find((o) => o.table === "artifact_reviews");
  assert(rev?.filters.some(([k, c, v]) => k === "eq" && c === "user_id" && v === USER_A));
});

Deno.test("rejected-cluster sweep scoped: a review by A on B's thread does not let A clear B's rows", async () => {
  resetSweepMemo();
  const db = makeDb({
    artifact_reviews: [{ artifact_id: "art-b", thread_id: THREAD_B, user_id: USER_A, state: "dismissed" }],
    artifacts: [{ id: "art-b", thread_id: THREAD_B, cluster_id: "c1", subject_id: null, metadata: {} }],
    threads: [{ id: THREAD_B, user_id: USER_B }],
  });
  const out = await sweepRejectedClusterAssignments(db as never, { userId: USER_A });
  assertEquals(out.cleared, 0);
  assertEquals(db.ops.filter((o) => o.op !== "select").length, 0);
});

Deno.test("rejected-cluster sweep: a scoped clean pass does not set the global 'recently clean' memo", async () => {
  resetSweepMemo();
  const empty = makeDb({ artifact_reviews: [] });
  await sweepRejectedClusterAssignments(empty as never, { userId: USER_A });
  const global = makeDb({ artifact_reviews: [] });
  const out = await sweepRejectedClusterAssignments(global as never, {});
  assertEquals(out.skipped, null, "an all-users sweep right after a scoped one must still run");
});

Deno.test("rejected-cluster sweep with a blank userId fails closed", async () => {
  resetSweepMemo();
  const db = makeDb({ artifact_reviews: [{ artifact_id: "x", thread_id: THREAD_B, user_id: USER_B, state: "dismissed" }] });
  const out = await sweepRejectedClusterAssignments(db as never, { userId: "" });
  assertEquals(db.ops.length, 0);
  assertEquals(out.reviews, 0);
});
