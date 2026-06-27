/**
 * Guard for scan submission (Chat composer + Next Steps cards).
 *
 * The bug this prevents: `send()` does async work (investigation-cache lookup +
 * a readiness probe) BEFORE `sendMessage()` runs, so useChat's `status` does not
 * flip to "submitted" until after those awaits. A status-only guard therefore
 * lets a rapid double/triple-click through — firing multiple scans (each POST
 * costs credits and the duplicate messages trigger React duplicate-key warnings).
 *
 * The caller holds a synchronous `locked` ref that is set before any await and
 * released in a finally; this predicate folds that ref into the decision so the
 * second click in a burst is rejected immediately.
 */
export type ChatRunStatus = "ready" | "submitted" | "streaming" | "error" | (string & {});

export function isSubmitBlocked(status: ChatRunStatus, locked: boolean): boolean {
  return locked || status === "submitted" || status === "streaming";
}
