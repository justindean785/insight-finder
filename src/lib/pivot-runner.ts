/**
 * pivot-runner.ts — is anything on this page able to run a pivot?
 *
 * Pivots are dispatched over the `proximity:run-pivot` window event, and only
 * `ChatWindow` listens. The read-only case view (`/cases/:id`) renders the
 * Evidence tab without a chat, so its Run buttons used to toast "Running
 * pivot" and mark the lead skipped while nothing ran at all. ChatWindow
 * registers here while mounted; the Pivots surface asks before offering Run.
 */
const runners = new Map<string, number>();

export function registerPivotRunner(threadId: string): () => void {
  runners.set(threadId, (runners.get(threadId) ?? 0) + 1);
  return () => {
    const n = (runners.get(threadId) ?? 1) - 1;
    if (n <= 0) runners.delete(threadId);
    else runners.set(threadId, n);
  };
}

export function hasPivotRunner(threadId: string): boolean {
  return (runners.get(threadId) ?? 0) > 0;
}
