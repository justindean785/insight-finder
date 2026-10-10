// lib/run-lease.ts — S1a: ATOMIC per-thread admission (the no-schema lease).
//
// WHY. `markRunStarted` (recovery.ts) is an UNCONDITIONAL update: it stamps
// status='active' + run_started_at + last_heartbeat_at whether or not another run is
// already pulsing the same thread. The frontend's `server_running` refusal is per-tab and
// advisory. So a second send — a refresh, a second tab, a retry on a dropped stream —
// simply starts a second run on top of the first. Measured 2026-10-03..10 (94
// invocations): 12 overlapping pairs across 9 threads; the three runs on thread cfe70631
// started 05:59:00, 06:01:39 and 06:02:19 and all three ended `premature_client_cancel`.
//
// WHAT. Admission becomes a single conditional UPDATE that is itself the run marker:
//
//   UPDATE threads SET status='active', run_started_at=now, last_heartbeat_at=now,
//                      recovered_at=null, recovery_reason=null
//    WHERE id=:thread AND user_id=:user
//      AND (status IS NULL OR status <> 'active'
//           OR last_heartbeat_at IS NULL OR last_heartbeat_at < now - 75 s)
//    RETURNING id
//
// Zero rows ⇒ a live run owns the thread ⇒ HTTP 409 RUN_IN_PROGRESS, thrown from
// `setupRequest` BEFORE the user message is inserted, so a refused send leaves nothing
// behind. Two concurrent requests cannot both pass: Postgres re-evaluates the WHERE
// against the row version the first UPDATE committed (READ COMMITTED), so the second
// sees status='active' with a fresh heartbeat and updates nothing.
//
// The 75 s bar is `STALE_RUN_AFTER_MS` — the same bar `recoverStaleThreadById` and the
// frontend's `deriveRunState` already judge liveness by — so "refused" and "running" can
// never disagree. A blank thread (born `active` from the column default, heartbeat NULL;
// invariant I-1 in CLAUDE.md) is admitted, as it must be.
//
// LIMIT, stated plainly: this is a TIME lease on the heartbeat. A worker that stalls for
// more than 75 s without pulsing can be superseded while still alive, and nothing here
// stops its later writes. That is S1b (run_generation fencing; needs a schema change).
// This PR removes duplicate ADMISSION, not every stale write.
//
// FAIL-OPEN on a database fault, loudly: a telemetry-class failure must never lock an
// analyst out of their own case. The event names the mode so it can be counted.
//
// KILL SWITCH, read at CALL TIME: RUN_LEASE_DISABLED=true (admission is unconditional,
// as before). /health proof key: checks.run_lease.

import { STALE_RUN_AFTER_MS } from "../recovery.ts";

export const RUN_LEASE_STALE_MS = STALE_RUN_AFTER_MS;

export function runLeaseDisabled(): boolean {
  return (Deno.env.get("RUN_LEASE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The PostgREST `.or()` clause that admits only a thread with no LIVE run. */
export function leaseAdmissionFilter(nowMs: number, staleMs: number = RUN_LEASE_STALE_MS): string {
  const cutoff = new Date(nowMs - staleMs).toISOString();
  return `status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.${cutoff}`;
}

export type RunLeaseResult =
  | { admitted: true; mode: "leased" | "disabled" | "fail_open"; startedAt: string; prior: PriorRunState | null }
  | {
    admitted: false;
    code: "RUN_IN_PROGRESS";
    lastHeartbeatAt: string | null;
    runStartedAt: string | null;
    retryAfterMs: number;
  };

/** The columns the lease overwrites, as they were just before it. Read immediately before
 *  the UPDATE and used ONLY by `releaseRunLease`; the admission decision is never made from
 *  this read — it is made by the conditional UPDATE. */
export type PriorRunState = {
  status: string | null;
  run_started_at: string | null;
  last_heartbeat_at: string | null;
  recovered_at: string | null;
  recovery_reason: string | null;
};

// Structural, so tests can drive it with a fake chain and production passes supabase-js
// (cast `as unknown as LeaseDb`, the same way reviews.ts takes its ReviewDb).
type LeaseReply = { data: unknown; error: { message?: string } | null };
interface LeaseQuery extends PromiseLike<LeaseReply> {
  update(patch: Record<string, unknown>): LeaseQuery;
  select(columns: string): LeaseQuery;
  eq(column: string, value: unknown): LeaseQuery;
  or(filter: string): LeaseQuery;
  maybeSingle(): LeaseQuery;
}
export type LeaseDb = { from(table: string): LeaseQuery };

export async function acquireRunLease(
  db: LeaseDb,
  threadId: string,
  userId: string,
  opts?: { now?: Date; staleMs?: number },
): Promise<RunLeaseResult> {
  const now = opts?.now ?? new Date();
  const iso = now.toISOString();
  const staleMs = opts?.staleMs ?? RUN_LEASE_STALE_MS;
  if (runLeaseDisabled()) return { admitted: true, mode: "disabled", startedAt: iso, prior: null };
  try {
    let prior: PriorRunState | null = null;
    try {
      const { data: before } = await db
        .from("threads")
        .select("status,run_started_at,last_heartbeat_at,recovered_at,recovery_reason")
        .eq("id", threadId)
        .maybeSingle();
      if (before && typeof before === "object") prior = before as PriorRunState;
    } catch { /* release will fall back to clearing the marker */ }
    const { data, error } = await db
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
      .or(leaseAdmissionFilter(now.getTime(), staleMs))
      .select("id");
    if (error) {
      console.warn(JSON.stringify({ event: "run_lease_error", thread_id: threadId, mode: "fail_open", error: String(error.message ?? error).slice(0, 200) }));
      return { admitted: true, mode: "fail_open", startedAt: iso, prior: null };
    }
    if (Array.isArray(data) && data.length > 0) {
      return { admitted: true, mode: "leased", startedAt: iso, prior };
    }
    // Refused. Read the live marker for the refusal detail (best-effort; the decision
    // was already made by the UPDATE above, never by this read).
    let lastHeartbeatAt: string | null = null;
    let runStartedAt: string | null = null;
    try {
      const { data: row } = await db
        .from("threads")
        .select("last_heartbeat_at,run_started_at")
        .eq("id", threadId)
        .maybeSingle();
      lastHeartbeatAt = (row as { last_heartbeat_at?: string | null } | null)?.last_heartbeat_at ?? null;
      runStartedAt = (row as { run_started_at?: string | null } | null)?.run_started_at ?? null;
    } catch { /* detail only */ }
    const hbMs = lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : NaN;
    const retryAfterMs = Number.isFinite(hbMs) ? Math.max(1_000, staleMs - (now.getTime() - hbMs)) : staleMs;
    console.log(JSON.stringify({
      event: "run_lease_refused",
      thread_id: threadId,
      last_heartbeat_at: lastHeartbeatAt,
      run_started_at: runStartedAt,
      retry_after_ms: retryAfterMs,
    }));
    return { admitted: false, code: "RUN_IN_PROGRESS", lastHeartbeatAt, runStartedAt, retryAfterMs };
  } catch (e) {
    console.warn(JSON.stringify({ event: "run_lease_error", thread_id: threadId, mode: "fail_open", error: String(e).slice(0, 200) }));
    return { admitted: true, mode: "fail_open", startedAt: iso, prior: null };
  }
}

/**
 * Undo a lease for a request that will NOT start a run (today: the two credit-gate 402
 * returns in index.ts that sit between `setupRequest` and `startRunHeartbeat`). Without
 * this, a credit-refused send would leave a run marker with no heartbeat behind it, and
 * 75 s later `recoverStaleThreadById` would reap it as an interrupted run and post a
 * recovery note the analyst never earned — the I-1 ghost, re-created from a new direction.
 *
 * Restores the prior snapshot, CONDITIONALLY: only while this lease's own marker is still
 * on the row (`run_started_at = startedAt` and status 'active'), so it can never clobber a
 * later run that legitimately took over. Without a snapshot it clears the marker, which
 * leaves the thread exactly where a blank thread starts (I-1: no marker ⇒ not a run).
 * Best-effort; a failure is logged and the stale sweep remains the backstop it is today.
 */
export async function releaseRunLease(
  db: LeaseDb,
  threadId: string,
  lease: Extract<RunLeaseResult, { admitted: true }> | null | undefined,
  reason: string,
): Promise<boolean> {
  if (!lease || lease.mode !== "leased") return false;
  const iso = new Date().toISOString();
  const restore = lease.prior
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
    console.log(JSON.stringify({ event: "run_lease_released", thread_id: threadId, reason, released, restored_status: restore.status, error: error ? String(error.message ?? error).slice(0, 200) : undefined }));
    return released;
  } catch (e) {
    console.warn(JSON.stringify({ event: "run_lease_released", thread_id: threadId, reason, released: false, error: String(e).slice(0, 200) }));
    return false;
  }
}

/** The 409 the analyst sees. The frontend's `describeTransportError` has no 409 line yet,
 *  so its fallback renders `HTTP 409 (RUN_IN_PROGRESS): <detail>` — the detail must
 *  therefore be a complete sentence on its own. */
export function runLeaseRefusalResponse(
  r: Extract<RunLeaseResult, { admitted: false }>,
  cors: Record<string, string>,
): Response {
  const secs = Math.ceil(r.retryAfterMs / 1000);
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
    { status: 409, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(secs) } },
  );
}

/** Pure. Its PRESENCE on /health proves the build with atomic admission is live;
 *  ok:false means the filter no longer encodes the 75 s bar it shares with recovery. */
export function runLeaseSelfTest(): { ok: boolean; detail: string } {
  if (runLeaseDisabled()) return { ok: true, detail: "LEGACY via RUN_LEASE_DISABLED — admission is unconditional" };
  const now = Date.UTC(2026, 9, 10, 6, 1, 39, 882);
  const f = leaseAdmissionFilter(now);
  const ok = f === "status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.2026-10-10T06:00:24.882Z" &&
    RUN_LEASE_STALE_MS === STALE_RUN_AFTER_MS;
  return ok
    ? { ok: true, detail: `atomic conditional-update lease; a live heartbeat (<${RUN_LEASE_STALE_MS / 1000}s) -> 409 RUN_IN_PROGRESS before the message insert` }
    : { ok: false, detail: "lease filter drifted from the recovery stale bar" };
}
