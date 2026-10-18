/**
 * client-cancel.ts — a dropped browser connection must not end the investigation.
 *
 * ## The defect (measured 2026-10-14, thread 968e33d8: two runs ended at 47 s and 51 s with
 * `run_end:premature_client_cancel`, the analyst never pressed Stop)
 *
 * index.ts builds TWO UI-message streams from the same `streamText` result: the browser-facing
 * response (`toUIMessageStreamResponse`) and a server-owned persistence branch
 * (`toUIMessageStream`, drained under `EdgeRuntime.waitUntil`) that exists precisely so the run
 * survives a browser that refreshes, backgrounds or loses its network. Both were handed the SAME
 * `persistFinalMessages` as `onFinish`, guarded by a first-caller-wins flag.
 *
 * The AI SDK calls a UI stream's `onFinish` from its `cancel` path as well as its `flush` path
 * (node_modules/ai, handleUIMessageStreamFinish). So the moment the browser dropped its response
 * branch — a phone switching apps, a locked screen, a network change — the response stream's
 * `onFinish` ran FIRST, persisted a PARTIAL transcript, marked the thread finished, stopped the
 * heartbeat and released run state, while the loop kept running on the server branch. The loop's
 * real end then hit the guard and was ignored: no final report was ever saved, the spend after the
 * cut was invisible to the analyst, and the "Interrupted" card invited a resend that started a
 * SECOND concurrent run on the same thread (admission is unconditional while RUN_LEASE_DISABLED).
 * lib/run-end.ts recorded this mechanism as "observability only" rather than fixing it.
 *
 * ## The fix
 *
 * The browser-facing response stream carries NO persistence `onFinish`. The server-owned branch
 * is the single writer, and it finishes when the loop finishes. Nothing about finalize, budget,
 * termination or the persistence handler itself changes; only WHICH stream is allowed to call it.
 *
 * ## Kill switch, read at CALL TIME
 *
 * `PERSIST_ON_CLIENT_CANCEL=true` restores the legacy wiring (both streams) on the running build
 * with no deploy. Unset or any other value = the fix. /health proof key: checks.client_cancel_isolation.
 *
 * Zero imports on purpose: pure, testable without Deno.env.
 */

export const PERSIST_ON_CLIENT_CANCEL_ENV = "PERSIST_ON_CLIENT_CANCEL";

/** True only when the operator explicitly asked for the legacy behaviour. */
export function persistOnClientCancelEnabled(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

export interface ClientCancelIsolationCheck {
  ok: boolean;
  mode: "server_branch_only" | "legacy_both_streams";
  detail: string;
}

/** /health: what the deployed bundle does when the browser drops its stream. `ok` is true in both
 *  modes (the legacy mode is an operator choice, not a fault); PRESENCE proves the deploy. */
export function clientCancelIsolationCheck(raw: string | null | undefined): ClientCancelIsolationCheck {
  if (persistOnClientCancelEnabled(raw)) {
    return {
      ok: true,
      mode: "legacy_both_streams",
      detail: `${PERSIST_ON_CLIENT_CANCEL_ENV}=true: a dropped browser connection persists a partial transcript and ends the run (legacy)`,
    };
  }
  return {
    ok: true,
    mode: "server_branch_only",
    detail: "a dropped browser connection does not end the run; the server-owned branch is the only writer of the final transcript",
  };
}
