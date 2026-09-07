/**
 * Thread status helpers.
 *
 * A thread is "active" (in progress) until the backend writes a terminal status.
 * Status is treated as an OPEN string, not a closed enum: the osint-agent edge
 * function can write values the UI doesn't enumerate (e.g. "failed_context_limit",
 * legacy "completed"). The Cases sidebar partitions threads into active vs.
 * finished using this predicate and its negation, so the two buckets are EXACT
 * complements — no status value can ever fall through both and render nowhere.
 */
export function isActiveThreadStatus(status: string | null | undefined): boolean {
  return (status ?? "active") === "active";
}

/**
 * The run markers the backend stamps when an investigation actually starts.
 * `run_started_at` is written once by markRunStarted; `last_heartbeat_at` is
 * pulsed (~15s) for the life of the run and stamped client-side by
 * beginInvestigation at send.
 */
export type ThreadRunMarkers = {
  run_started_at?: string | null;
  last_heartbeat_at?: string | null;
};

/**
 * Did an investigation ever START on this thread?
 *
 * This is the CLIENT MIRROR of the backend's own `hasRunMarker`
 * (supabase/functions/osint-agent/recovery.ts) and it exists for the same
 * reason — invariant I-1 in CLAUDE.md: "a thread with no run marker is NOT an
 * interrupted investigation". A blank thread is born `status='active'` from the
 * COLUMN DEFAULT the moment "New investigation" inserts `{ user_id }`; nothing
 * about that row says a run happened. The backend already refuses to recover
 * such a thread. Every surface that says "Running" must refuse to claim one too,
 * or the app reports a run the analyst never started.
 *
 * Fails closed: an absent/unparseable pair means "never started".
 */
export function hasRunMarker(row: ThreadRunMarkers | null | undefined): boolean {
  if (!row) return false;
  return Boolean(row.run_started_at) || Boolean(row.last_heartbeat_at);
}

/**
 * True only for a thread that is BOTH still active AND has actually run.
 * This — not `isActiveThreadStatus` alone — is the predicate for any surface
 * that renders a live-run affordance ("Running", a pulsing pip, "Open live chat").
 */
export function isRunningThread(
  row: ({ status?: string | null } & ThreadRunMarkers) | null | undefined,
): boolean {
  if (!row) return false;
  return isActiveThreadStatus(row.status) && hasRunMarker(row);
}

/**
 * True for a thread that was created and never used: still carrying the default
 * active status, with no run marker of any kind. These are drafts, not runs, and
 * must never be labelled Running (a live run that isn't) nor swept to Finished
 * (a completed run that never happened). Both are lies about run state.
 */
export function isNeverStartedThread(
  row: ({ status?: string | null } & ThreadRunMarkers) | null | undefined,
): boolean {
  if (!row) return false;
  return isActiveThreadStatus(row.status) && !hasRunMarker(row);
}
