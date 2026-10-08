// lib/run-end.ts — record WHY a run's persistence/finish handler fired.
//
// Measured on thread 94ef8115 (2026-10-07 ~21:01–21:05Z). Five invocations in ~3 minutes; three
// were recorded as ended after 2–4 steps with finish_reason "tool-calls", no error and no
// finalize — while that thread's tool calls kept landing in tool_usage_log for another ~12 s
// after the last row's finished_at. Nothing in the row said why.
//
// The mechanism the AI SDK source shows (node_modules/ai, handleUIMessageStreamFinish): the
// UI-message stream's TransformStream calls `onFinish` from BOTH `flush` (the stream ended
// normally) and `cancel` (the CONSUMER went away — a browser tab that backgrounded or dropped
// its fetch). index.ts passes the same `persistFinalMessages` to two such streams (the
// browser-facing response and the server-owned persistence branch) and guards it with
// `finalPersisted`, so whichever fires first wins. A browser cancel therefore runs persistence
// — and writes the invocation row — with a PARTIAL transcript while the server loop is still
// running, and the later, real end is ignored. `isAborted` is false in that case (it only flips
// on an explicit "abort" chunk), so the arguments cannot tell the two apart.
//
// This module is OBSERVABILITY ONLY. It classifies the end from two facts the handler can
// measure — did the streamText loop itself complete, and did the request's own signal abort —
// and the caller records the result. It changes no persistence, finalize or termination
// behaviour (that area owns this project's worst incidents; see CLAUDE.md).
//
// KILL SWITCH, read at CALL TIME: RUN_END_LOG_DISABLED=true  (no log event, no note).
// /health proof key: checks.run_end_log.

export function runEndLogDisabled(): boolean {
  return (Deno.env.get("RUN_END_LOG_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export type RunEndCause =
  /** The streamText loop reported completion before persistence ran: a genuine end. */
  | "loop_complete"
  /** The SDK reported an explicit abort chunk. */
  | "aborted"
  /** Persistence ran while the loop was still going AND the request signal had aborted:
   *  the browser went away mid-run. */
  | "premature_client_cancel"
  /** Persistence ran while the loop was still going and nothing measured says why. */
  | "premature_unknown";

export interface RunEndInput {
  /** streamText's own onFinish fired. */
  loopDone: boolean;
  /** The UI stream's `isAborted`, or streamText's onAbort. */
  isAborted: boolean;
  /** `req.signal.aborted` at the moment persistence ran. */
  clientSignalAborted: boolean;
}

export function classifyRunEnd(i: RunEndInput): { cause: RunEndCause; premature: boolean } {
  if (i.isAborted) return { cause: "aborted", premature: false };
  if (i.loopDone) return { cause: "loop_complete", premature: false };
  return {
    cause: i.clientSignalAborted ? "premature_client_cancel" : "premature_unknown",
    premature: true,
  };
}

/** Text for `orchestrator_invocations.error_message` (nullable free text; the stop_reason
 *  CHECK constraint is deliberately NOT touched — a schema change goes through Lovable).
 *  Only a non-clean end writes a note, so a healthy run's row is unchanged. */
export function runEndNote(c: { cause: RunEndCause; premature: boolean }): string | null {
  if (runEndLogDisabled()) return null;
  if (c.cause === "loop_complete") return null;
  return `run_end:${c.cause}${c.premature ? " (persistence ran before the loop finished)" : ""}`;
}

/** `/health` → `checks.run_end_log`. Presence of the key proves this build is deployed. */
export function runEndSelfTest(): { ok: boolean; detail: string } {
  if (runEndLogDisabled()) return { ok: true, detail: "LEGACY via RUN_END_LOG_DISABLED" };
  const wrong: string[] = [];
  const done = classifyRunEnd({ loopDone: true, isAborted: false, clientSignalAborted: false });
  if (done.cause !== "loop_complete" || done.premature) wrong.push("clean end misclassified");
  const gone = classifyRunEnd({ loopDone: false, isAborted: false, clientSignalAborted: true });
  if (gone.cause !== "premature_client_cancel" || !gone.premature) wrong.push("client cancel misclassified");
  if (runEndNote(done) !== null) wrong.push("a clean end wrote a note");
  if (!runEndNote(gone)?.startsWith("run_end:premature_client_cancel")) wrong.push("premature note missing");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: "persistence-before-loop-finish is recorded as run_end:premature_* (log + invocation error_message); observability only" };
}
