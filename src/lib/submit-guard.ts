/**
 * Guard for scan submission (Chat composer + Next Steps cards).
 *
 * The bug this prevents: `send()` does async work (investigation-cache lookup +
 * the case-start write) BEFORE `sendMessage()` runs, so useChat's `status` does not
 * flip to "submitted" until after those awaits. A status-only guard therefore
 * lets a rapid double/triple-click through — firing multiple scans (each POST
 * costs credits and the duplicate messages trigger React duplicate-key warnings).
 *
 * The caller holds a synchronous `locked` ref that is set before any await and
 * released in a finally; this predicate folds that ref into the decision so the
 * second click in a burst is rejected immediately.
 *
 * ── Why the refusal has a REASON (2026-09-30) ───────────────────────────────
 * Every caller used to `return` on a true predicate and say nothing. The
 * operator's report was exact: *"I'll click on continue and it won't do
 * anything and then I'll click off and click back and it ran the whole thing."*
 * Both halves follow from that silence. Continue is live precisely while the
 * lock is held and `status` has not yet flipped — the window this guard exists
 * for — so the button still reads "Continue", takes the click, and drops it.
 * Navigating away remounts ChatWindow, which resets the ref, so the next click
 * goes through and the run appears to have been waiting all along.
 *
 * The fix is not to loosen the guard — it is correct, and `retryLastUser`'s own
 * comment records why (the server has no idempotency key and does not reject
 * overlaps, so this ref is the only thing standing between a double-click and
 * two billed runs). The fix is to say which of the two states refused, because
 * they ask different things of the analyst: `starting` means the click already
 * landed, `running` means wait for the cycle in flight.
 */
export type ChatRunStatus = "ready" | "submitted" | "streaming" | "error" | (string & {});

/** Why a submission cannot proceed, or null when it can. */
export type SubmitRefusal = "starting" | "running" | "server_running";

/**
 * `running` wins when both hold: once the stream is up, "a run is in progress"
 * is the more useful thing to tell someone than "your click registered".
 */
export function submitRefusal(
  status: ChatRunStatus,
  locked: boolean,
  serverRunActive = false,
): SubmitRefusal | null {
  if (status === "submitted" || status === "streaming") return "running";
  if (locked) return "starting";
  // This tab's stream is idle but the server still reports a live run on the
  // thread (dropped stream, second tab, reload). The edge run is not bound to the
  // request signal, so a new send here starts a SECOND run on top of it.
  if (serverRunActive) return "server_running";
  return null;
}

/** Unchanged truth table — `locked || submitted || streaming`. Every existing
 *  caller keeps its behaviour; only the ones that now explain themselves differ. */
export function isSubmitBlocked(status: ChatRunStatus, locked: boolean, serverRunActive = false): boolean {
  return submitRefusal(status, locked, serverRunActive) !== null;
}

export function submitRefusalMessage(refusal: SubmitRefusal): string {
  if (refusal === "starting") return "Already starting that run — give it a second.";
  if (refusal === "server_running") {
    return "The previous run is still working on the server. Wait for it to finish — sending now would start a second run on top of it.";
  }
  return "A run is in progress on this case. It'll be ready when this cycle finishes.";
}
