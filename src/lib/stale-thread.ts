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
 * not running; it was killed. This lets the signed-in owner reconcile that dead
 * state to the terminal "finished" (owner-writable under RLS) so the UI stops
 * showing it stuck.
 *
 * This is a UI safety net, NOT a replacement for the backend finalizer — it only
 * reconciles threads the owner can already see, and never touches a thread that
 * is still writing. The evidence itself is unaffected (artifacts persist
 * incrementally); this only corrects the run's terminal status.
 */

/**
 * No live run goes this long without a single persisted write. Sits comfortably
 * above the slowest single-tool cap (~30s) and the longest between-step model
 * gap, so a genuinely-running scan is never reconciled out from under itself.
 */
export const STALE_ACTIVE_MS = 3 * 60_000;

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
 *  reconciled to "finished". Pure — exported for tests. */
export function selectStaleActiveIds<
  T extends { id: string; status: string | null; updated_at: string },
>(rows: T[], now: number = Date.now()): string[] {
  return rows.filter((t) => isStaleActiveThread(t.status, t.updated_at, now)).map((t) => t.id);
}
