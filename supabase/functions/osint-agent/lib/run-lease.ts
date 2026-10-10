// lib/run-lease.ts — S1a: ATOMIC per-thread admission (the no-schema run lease).
//
// WHY. `markRunStarted` (recovery.ts) is an UNCONDITIONAL update: it stamps
// status='active' + run_started_at + last_heartbeat_at whether or not another run is
// already pulsing the same thread. The frontend's `server_running` refusal is per-tab and
// advisory. So a second send — a refresh, a second tab, a retry on a dropped stream —
// simply starts a second run on top of the first. Measured 2026-10-03..10 (94
// invocations): 12 overlapping pairs across 9 threads; the three runs on thread cfe70631
// started 05:59:00, 06:01:39 and 06:02:19 and all three ended `premature_client_cancel`.
//
// WHAT. Admission is ONE conditional UPDATE that is itself the run marker:
//
//   UPDATE threads SET status='active', run_started_at=now, last_heartbeat_at=now,
//                      recovered_at=null, recovery_reason=null
//    WHERE id=:thread AND user_id=:user
//      AND (status IS NULL OR status <> 'active'
//           OR last_heartbeat_at IS NULL OR last_heartbeat_at < now - 75 s)   -- admission
//      AND status IS NOT DISTINCT FROM :seen.status                            -- version
//      AND run_started_at / last_heartbeat_at / recovered_at / recovery_reason
//          IS NOT DISTINCT FROM the values this request just read
//    RETURNING id
//
// The version clause is what makes the rollback snapshot TRUSTWORTHY: the row this
// request read is provably the row version the UPDATE replaced, so `releaseRunLease` can
// put it back without resurrecting a run that finished between the read and the write
// (review finding 2). A version mismatch is retried once from a fresh read; a mismatch
// that persists is reported as unavailable, never as admitted.
//
// Zero rows with a LIVE heartbeat on the re-read ⇒ HTTP 409 RUN_IN_PROGRESS, thrown from
// `setupRequest` BEFORE the user message is inserted. Two concurrent requests cannot both
// pass the admission clause: Postgres re-evaluates the WHERE against the row version the
// first UPDATE committed (READ COMMITTED), so the second sees status='active' with a fresh
// heartbeat and updates nothing. `.github/ci/assert-run-lease.sql` drives that predicate
// on a real Postgres against the migrated schema.
//
// The 75 s bar is `STALE_RUN_AFTER_MS`, which `recoverStaleThreadById` and the frontend's
// `deriveRunState` also use. The PREDICATES are not identical and this header does not
// claim they are: admission treats ANY NULL heartbeat as "no live run", while recovery
// additionally requires a run marker and falls back to `updated_at`. They agree on every
// row that has a heartbeat; a blank thread (born `active`, heartbeat NULL; invariant I-1)
// is admitted here and ignored by recovery, which is the intended outcome in both places.
//
// FAIL-CLOSED. A database error or a persistent version mismatch does NOT prove
// ownership, so the request is refused with a retryable 503 RUN_LEASE_UNAVAILABLE before
// any message is stored or paid work starts (review finding 4). The only way to admit
// without the lease is the explicit operator switch below, which is a distinct, logged
// degraded mode — not a fallback the code takes on its own.
//
// CLEANUP. A lease is held from `setupRequest` until `startRunHeartbeat` takes over. Every
// exit in that window that will NOT start a run must give it back (`releaseRunLease`): the
// message-insert section of setupRequest runs under `withLeaseCleanup`, the credit-gate
// 402s release explicitly, and index.ts's outer catch releases a lease it still holds.
// Without that, a thrown setup error would strand a heartbeat-less marker and the stale
// sweep would post a recovery note for a run that never ran (review finding 1).
//
// LIMIT, stated plainly: this is a TIME lease on the heartbeat, not ownership fencing.
//   • A worker that stalls > 75 s without pulsing can be superseded while alive, and its
//     later writes are not fenced.
//   • A STOPPED thread is admitted at once. The predecessor's heartbeat and terminal
//     writes gate on `status='active'`, not on an owner, so once the successor sets the
//     row active again the predecessor's next pulse or terminal write can land on the
//     successor's row. `startRunHeartbeat` also calls the unconditional `markRunStarted`.
//   S1a removes duplicate ADMISSION. Fencing every heartbeat / start / terminal / recovery
//   / persistence writer behind a run generation is S1b and needs a schema change.
//
// KILL SWITCH, read at CALL TIME: RUN_LEASE_DISABLED=true (admission is unconditional,
// as before). /health proof key: checks.run_lease.

import { STALE_RUN_AFTER_MS } from "../recovery.ts";

export const RUN_LEASE_STALE_MS = STALE_RUN_AFTER_MS;
/** Retry hint on a 503: long enough for a transient fault, short enough not to feel stuck. */
export const RUN_LEASE_UNAVAILABLE_RETRY_MS = 5_000;
const VERSION_ATTEMPTS = 2;

export function runLeaseDisabled(): boolean {
  return (Deno.env.get("RUN_LEASE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The PostgREST `.or()` clause that admits only a thread with no LIVE run. */
export function leaseAdmissionFilter(nowMs: number, staleMs: number = RUN_LEASE_STALE_MS): string {
  const cutoff = new Date(nowMs - staleMs).toISOString();
  return `status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.${cutoff}`;
}

/** The columns the lease overwrites, as one row version. */
export type RunRowVersion = {
  status: string | null;
  run_started_at: string | null;
  last_heartbeat_at: string | null;
  recovered_at: string | null;
  recovery_reason: string | null;
};

const VERSION_COLUMNS: ReadonlyArray<keyof RunRowVersion> = [
  "status",
  "run_started_at",
  "last_heartbeat_at",
  "recovered_at",
  "recovery_reason",
];

/** The admission predicate, in code, for the decision on a RE-READ row. The database
 *  evaluates the same predicate in `leaseAdmissionFilter`; `assert-run-lease.sql` pins
 *  the two to each other on a real Postgres. */
export function admitsRow(row: RunRowVersion | null, nowMs: number, staleMs: number = RUN_LEASE_STALE_MS): boolean {
  if (!row) return false;
  if (row.status === null || row.status !== "active") return true;
  if (row.last_heartbeat_at === null) return true;
  const hb = new Date(row.last_heartbeat_at).getTime();
  return Number.isFinite(hb) ? hb < nowMs - staleMs : true;
}

export type RunLeaseResult =
  | { admitted: true; mode: "leased" | "disabled"; startedAt: string; prior: RunRowVersion | null }
  | {
    admitted: false;
    code: "RUN_IN_PROGRESS";
    lastHeartbeatAt: string | null;
    runStartedAt: string | null;
    retryAfterMs: number;
  }
  | { admitted: false; code: "RUN_LEASE_UNAVAILABLE"; reason: string; retryAfterMs: number };

export type RunLeaseHeld = Extract<RunLeaseResult, { admitted: true }>;
export type RunLeaseRefusal = Extract<RunLeaseResult, { admitted: false }>;

type LeaseReply = { data: unknown; error: { message?: string } | null };
interface LeaseQuery extends PromiseLike<LeaseReply> {
  update(patch: Record<string, unknown>): LeaseQuery;
  select(columns: string): LeaseQuery;
  eq(column: string, value: unknown): LeaseQuery;
  is(column: string, value: null): LeaseQuery;
  or(filter: string): LeaseQuery;
  maybeSingle(): LeaseQuery;
}
// Structural, so tests can drive it with a fake chain and production passes supabase-js
// (cast `as unknown as LeaseDb`, the same way reviews.ts takes its ReviewDb).
export type LeaseDb = { from(table: string): LeaseQuery };

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function toVersion(row: unknown): RunRowVersion | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const s = (k: keyof RunRowVersion): string | null => (typeof r[k] === "string" ? (r[k] as string) : null);
  return {
    status: s("status"),
    run_started_at: s("run_started_at"),
    last_heartbeat_at: s("last_heartbeat_at"),
    recovered_at: s("recovered_at"),
    recovery_reason: s("recovery_reason"),
  };
}

async function readVersion(db: LeaseDb, threadId: string): Promise<{ row: RunRowVersion | null; error: string | null }> {
  const { data, error } = await db
    .from("threads")
    .select(VERSION_COLUMNS.join(","))
    .eq("id", threadId)
    .maybeSingle();
  if (error) return { row: null, error: String(error.message ?? error) };
  return { row: toVersion(data), error: null };
}

function unavailable(threadId: string, reason: string): RunLeaseResult {
  console.warn(JSON.stringify({ event: "run_lease_unavailable", thread_id: threadId, reason: reason.slice(0, 200) }));
  return { admitted: false, code: "RUN_LEASE_UNAVAILABLE", reason, retryAfterMs: RUN_LEASE_UNAVAILABLE_RETRY_MS };
}

export async function acquireRunLease(
  db: LeaseDb,
  threadId: string,
  userId: string,
  opts?: { now?: Date; staleMs?: number },
): Promise<RunLeaseResult> {
  const now = opts?.now ?? new Date();
  const iso = now.toISOString();
  const staleMs = opts?.staleMs ?? RUN_LEASE_STALE_MS;
  if (runLeaseDisabled()) {
    log({ event: "run_lease_disabled", thread_id: threadId });
    return { admitted: true, mode: "disabled", startedAt: iso, prior: null };
  }
  try {
    for (let attempt = 1; attempt <= VERSION_ATTEMPTS; attempt++) {
      const seen = await readVersion(db, threadId);
      if (seen.error) return unavailable(threadId, `read: ${seen.error}`);
      if (!seen.row) return unavailable(threadId, "thread row not found");
      // Decide from the row we just read first: a live heartbeat is a refusal, and the
      // UPDATE below would only confirm it. (Two reads are still cheaper than a 409 path
      // that mis-attributes a version mismatch as a live run.)
      if (!admitsRow(seen.row, now.getTime(), staleMs)) return refusal(threadId, seen.row, now, staleMs);
      let q = db
        .from("threads")
        .update({
          status: "active",
          run_started_at: iso,
          last_heartbeat_at: iso,
          recovered_at: null,
          recovery_reason: null,
          updated_at: iso,
        })
        .eq("id", threadId)
        .eq("user_id", userId)
        .or(leaseAdmissionFilter(now.getTime(), staleMs));
      // Version clause: the UPDATE replaces exactly the row version we read, or nothing.
      for (const col of VERSION_COLUMNS) {
        const v = seen.row[col];
        q = v === null ? q.is(col, null) : q.eq(col, v);
      }
      const { data, error } = await q.select("id");
      if (error) return unavailable(threadId, `update: ${String(error.message ?? error)}`);
      if (Array.isArray(data) && data.length > 0) {
        log({ event: "run_lease_acquired", thread_id: threadId, attempt, prior_status: seen.row.status });
        return { admitted: true, mode: "leased", startedAt: iso, prior: seen.row };
      }
      // Zero rows: either a run went live between our read and the UPDATE, or the row
      // changed in some other way. Re-read and let the next loop decide.
      log({ event: "run_lease_version_miss", thread_id: threadId, attempt });
    }
    const again = await readVersion(db, threadId);
    if (!again.error && again.row && !admitsRow(again.row, now.getTime(), staleMs)) {
      return refusal(threadId, again.row, now, staleMs);
    }
    return unavailable(threadId, `row version changed ${VERSION_ATTEMPTS} times during admission`);
  } catch (e) {
    return unavailable(threadId, `threw: ${String(e)}`);
  }
}

function refusal(threadId: string, row: RunRowVersion, now: Date, staleMs: number): RunLeaseResult {
  const hbMs = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : NaN;
  const retryAfterMs = Number.isFinite(hbMs) ? Math.max(1_000, staleMs - (now.getTime() - hbMs)) : staleMs;
  log({
    event: "run_lease_refused",
    thread_id: threadId,
    last_heartbeat_at: row.last_heartbeat_at,
    run_started_at: row.run_started_at,
    retry_after_ms: retryAfterMs,
  });
  return { admitted: false, code: "RUN_IN_PROGRESS", lastHeartbeatAt: row.last_heartbeat_at, runStartedAt: row.run_started_at, retryAfterMs };
}

/**
 * Undo a lease for a request that will NOT start a run. Restores the row version the
 * lease's UPDATE provably replaced (see the version clause above), CONDITIONALLY: only
 * while this lease's own marker is still on the row (`run_started_at = startedAt` and
 * status 'active'), so a later run that legitimately took over is never clobbered. A
 * `disabled`-mode lease wrote nothing and releases nothing. Best-effort; a failure is
 * logged and the stale sweep remains the backstop it is today.
 */
export async function releaseRunLease(
  db: LeaseDb,
  threadId: string,
  lease: RunLeaseHeld | null | undefined,
  reason: string,
): Promise<boolean> {
  if (!lease || lease.mode !== "leased") return false;
  const iso = new Date().toISOString();
  const restore: Record<string, unknown> = lease.prior
    ? { ...lease.prior, updated_at: iso }
    : { status: "active", run_started_at: null, last_heartbeat_at: null, recovered_at: null, recovery_reason: null, updated_at: iso };
  try {
    const { data, error } = await db
      .from("threads")
      .update(restore)
      .eq("id", threadId)
      .eq("status", "active")
      .eq("run_started_at", lease.startedAt)
      .select("id");
    const released = !error && Array.isArray(data) && data.length > 0;
    log({ event: "run_lease_released", thread_id: threadId, reason, released, restored_status: restore.status, error: error ? String(error.message ?? error).slice(0, 200) : undefined });
    return released;
  } catch (e) {
    console.warn(JSON.stringify({ event: "run_lease_released", thread_id: threadId, reason, released: false, error: String(e).slice(0, 200) }));
    return false;
  }
}

/** Run `fn` while holding `lease`; if it throws, release the lease first, then rethrow.
 *  The throw is preserved as-is (a `Response` thrown by setupRequest stays a Response). */
export async function withLeaseCleanup<T>(
  db: LeaseDb,
  threadId: string,
  lease: RunLeaseHeld,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await releaseRunLease(db, threadId, lease, reason);
    throw e;
  }
}

/** The response the analyst sees. The frontend's `describeTransportError` has no 409/503
 *  line, so its fallback renders `HTTP <status> (<code>): <detail>` — the detail must
 *  therefore be a complete sentence on its own. */
export function runLeaseRefusalResponse(r: RunLeaseRefusal, cors: Record<string, string>): Response {
  const secs = Math.ceil(r.retryAfterMs / 1000);
  const headers = { ...cors, "Content-Type": "application/json", "Retry-After": String(secs) };
  if (r.code === "RUN_IN_PROGRESS") {
    return new Response(
      JSON.stringify({
        error: "Conflict",
        code: r.code,
        detail: `A run is still running on this case (last heartbeat ${r.lastHeartbeatAt ?? "unknown"}). ` +
          `Sending now would start a second run on top of it. Wait for it to finish, or about ${secs}s if it has stalled, then try again.`,
        last_heartbeat_at: r.lastHeartbeatAt,
        run_started_at: r.runStartedAt,
        retry_after_ms: r.retryAfterMs,
      }),
      { status: 409, headers },
    );
  }
  return new Response(
    JSON.stringify({
      error: "Service Unavailable",
      code: r.code,
      detail: `The case could not be claimed for this run (${r.reason.slice(0, 120)}). Nothing was sent or charged. Try again in about ${secs}s.`,
      retry_after_ms: r.retryAfterMs,
    }),
    { status: 503, headers },
  );
}

/** Pure. Its PRESENCE on /health proves the build with atomic admission is live;
 *  ok:false means the filter or the in-code predicate drifted from the 75 s bar. */
export function runLeaseSelfTest(): { ok: boolean; detail: string } {
  if (runLeaseDisabled()) return { ok: true, detail: "LEGACY via RUN_LEASE_DISABLED — admission is unconditional" };
  const now = Date.UTC(2026, 9, 10, 6, 1, 39, 882);
  const f = leaseAdmissionFilter(now);
  const fresh = new Date(now - 20_000).toISOString();
  const stale = new Date(now - 80_000).toISOString();
  const row = (status: string | null, hb: string | null): RunRowVersion => ({ status, run_started_at: null, last_heartbeat_at: hb, recovered_at: null, recovery_reason: null });
  const ok = f === "status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.2026-10-10T06:00:24.882Z" &&
    RUN_LEASE_STALE_MS === STALE_RUN_AFTER_MS &&
    !admitsRow(row("active", fresh), now) && admitsRow(row("active", stale), now) &&
    admitsRow(row("active", null), now) && admitsRow(row("finished", fresh), now);
  return ok
    ? { ok: true, detail: `atomic versioned conditional-update lease; live heartbeat (<${RUN_LEASE_STALE_MS / 1000}s) -> 409, db fault -> 503, both before the message insert` }
    : { ok: false, detail: "lease predicate drifted from the recovery stale bar" };
}
