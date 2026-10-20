/**
 * Stale-active reconciliation — a client-side safety net for CPU-killed runs.
 *
 * The osint-agent edge function can be hard-killed by Supabase's CPU-time limit
 * mid-run. When that happens the isolate dies before its onFinish/onError
 * callbacks can flip the thread's status, so the row stays "active" forever and
 * every surface (sidebar, header, case list) shows the run as perpetually in
 * progress. This is the "agent stopped mid-investigation and hangs" symptom.
 *
 * A live run persists a tool_usage_log row / artifact (and bumps
 * threads.updated_at) every few seconds — the slowest single tool cap is ~30s.
 * So a thread that is STILL "active" but has had no write for several minutes is
 * not running; it was killed. The sidebar uses this to stop SHOWING it as
 * running.
 *
 * Display only — never a DB write. The browser used to write `finished` here,
 * which broke invariant I-2: without a `recovery_reason` the row reads as
 * COMPLETE, and server recovery (`recoverStaleActiveThreads`, which only claims
 * `status='active'` rows) could then no longer stamp the reason and post the
 * recovered report. The terminal status of a dead run is the server's to write.
 */
import { hasRunMarker, type ThreadRunMarkers } from "@/lib/thread-status";

/**
 * No live run goes this long without a single persisted write. Sits comfortably
 * above the slowest single-tool cap (~30s) and the longest between-step model
 * gap, so a genuinely-running scan is never reconciled out from under itself.
 */
export const STALE_ACTIVE_MS = 3 * 60_000;

/**
 * How fresh `last_heartbeat_at` must be for a run to count as STILL ALIVE.
 *
 * Deliberately the server's own bar: recoverStaleActiveThreads treats a run as
 * dead past ~75s, so using the same number keeps client and backend from
 * disagreeing about the same thread. Past this line the server will itself write
 * `finished` + `recovery_reason` and the UI renders "Interrupted" — the honest
 * label — so the client never needs to claim a run is alive after the server has
 * given up on it.
 */
export const RUN_HEARTBEAT_ALIVE_MS = 75_000;

/**
 * Is the backend still pulsing this run's heartbeat?
 *
 * FAILS CLOSED, and the failing-closed is the whole point. `status === 'active'`
 * is NOT a liveness signal — it is exactly the state a CPU-killed isolate leaves
 * behind, and the state a never-started blank thread is born in. Answering
 * "alive?" from the status column is how you tell an analyst their dead run is
 * "still running in the background". Only a recent heartbeat proves a live run.
 */
export function isRunHeartbeatAlive(
  lastHeartbeatAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lastHeartbeatAt) return false;
  const t = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= RUN_HEARTBEAT_ALIVE_MS;
}

/** True when a thread is still "active" but has been silent long enough that its
 *  run must have died without finalizing. Pure — exported for tests. */
export function isStaleActiveThread(
  status: string | null | undefined,
  updatedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if ((status ?? "active") !== "active") return false;
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t > STALE_ACTIVE_MS;
}

/** Ids of the threads in `rows` whose active run has gone stale and should be
 *  displayed as not running (display only; the server writes the terminal
 *  status). Pure — exported for tests.
 *
 *  A thread with NO run marker is excluded, mirroring the backend's own refusal
 *  to recover one (CLAUDE.md invariant I-1). Without that check this sweep read
 *  a never-started blank thread — born `active` from the column default, its
 *  `updated_at` frozen at creation and therefore instantly "stale" — as a dead
 *  run and wrote `finished` over it. That is the same lie as calling it Running,
 *  just in the other direction: it reports a completed investigation that never
 *  happened. Drafts are neither running nor finished; they are untouched. */
export function selectStaleActiveIds<
  T extends { id: string; status: string | null; updated_at: string } & ThreadRunMarkers,
>(rows: T[], now: number = Date.now()): string[] {
  return rows
    .filter((t) => hasRunMarker(t) && isStaleActiveThread(t.status, t.updated_at, now))
    .map((t) => t.id);
}
