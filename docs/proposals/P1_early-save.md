# Proposal P1 — Persistence must not run before the model loop finishes

Status: PROPOSAL ONLY. Protected area (finalize/termination + report semantics). Nothing here is implemented.
Prerequisite evidence: PR #714 (`run_end` log + `run_end:<cause>` on the invocation row), to confirm cause in production.

## 1. Current behavior (verified in code + DB)
- `index.ts` defines `persistFinalMessages` once and passes it as `onFinish` to TWO UI streams: the server-owned
  `persistenceStream` (drained under `EdgeRuntime.waitUntil`, ~l.2128) and the browser response
  `toUIMessageStreamResponse` (~l.2170). A `finalPersisted` flag makes the FIRST caller win.
- ai@6 `handleUIMessageStreamFinish` (node_modules/ai/dist/index.mjs ~6020) calls `onFinish` from `flush` (stream ended)
  AND `cancel` (the consumer went away). A browser cancel therefore runs `persistFinalMessages` with the PARTIAL transcript
  while the loop still runs; `isAborted` is false in that case.
- `persistFinalMessages` then: runs the P0-B salvage backstop (a live `generateText` over the whole thread's artifacts),
  writes the assistant message, marks the thread `finished`, writes the invocation row (`telemetry.finish`, guarded by
  `finished`), and releases run state. The real end, later, is ignored by both guards.
- Intent of the cancel path: a CPU-killed isolate cancels its streams, and this is the "dominant CPU-kill finalize path"
  (comment at the salvage block). It must keep working.

## 2. Reproduced failure
Production case 21e8bc95 (read-only DB reads, nothing re-run): invocation 2 recorded `finish_reason=tool-calls`,
`stop_reason=unknown`, 5 steps, `finalize_started=false`, finished 02:09:38Z; the assistant message was persisted 02:09:36Z with
a text part `"All"` still `state:"streaming"` followed by an 8,037-char part with no `state` (the salvage report, titled with the
case's FIRST domain). Thread 94ef8115: four invocations whose rows end 12–17 s after the next request began while tool calls
kept landing for ~12 s after the last row.
Not yet proven: why each browser branch cancelled (#714 will record `premature_client_cancel` vs `premature_unknown`).

## 3. Proposed behavior
Invariant: **finalize-class work (salvage, final message write, `status='finished'`, invocation row) runs exactly once, when the
model loop has completed, was aborted, or errored — never merely because one consumer detached.**
- The browser-response `onFinish` becomes detach-only: record `run_end` with cause `client_detached` and do nothing else
  while the loop is live (`loopDone`/`loopAborted` false, from #714's flags).
- The server-owned persistence branch is the single persister (it is already drained under `waitUntil`).
- CPU-kill / isolate-death safety is NOT dropped: if the persistence branch never completes, the existing stale-run
  recovery (`recovery.ts`, heartbeat-stale >75 s, invariants I-1/I-2) owns it. Open question for review: how long after a
  detach we allow before recovery may claim the thread, so recovery never races a live loop (use the heartbeat, which the
  server pulses every ~15 s).

## 4. Invariants that must not change
I-1 (no run marker ⇒ not an interrupted investigation) · I-2 (`finished` only presents as complete with a report-shaped message
or `finalize_no_findings`) · no change to `toolChoice` phase logic · no change to evidence rows, scoring, custody ·
`finalPersisted` still guarantees one persist · the salvage backstop still runs when the loop truly ended without a report.

## 5. Implementation surface
`supabase/functions/osint-agent/index.ts` (`persistFinalMessages` entry guard; the response-branch `onFinish` wrapper),
`lib/run-end.ts` (extend causes), `recovery.ts` (only if the grace window needs a constant). Edge-only, one PR, one new
`/health` key (`checks.persist_after_loop`) and kill switch `PERSIST_AFTER_LOOP_DISABLED=true` (restores first-caller-wins).

## 6. Tests
Drive the real control flow, not a restatement: a harness that builds the two streams over a controllable fake `streamText`,
cancels the response branch mid-loop, and asserts (a) no salvage `generateText` call, no message write, no `finished`, no invocation
row until the loop ends; (b) a completed loop persists exactly once; (c) an aborted/errored loop persists once; (d) with the kill
switch on, the old first-caller-wins behavior is reproduced (negative control). Source-level wiring test as in #714.

## 7. Production verification
`/health` shows the new key; run one scan, background the phone, confirm the invocation row's `finished_at` ≈ the last
`tool_usage_log` row for that thread, no `state:"streaming"` text part in the saved message, no appended salvage report on a
run that produced its own report, thread status flips to `finished` only after the last tool call.

## 8. Rollback
Env kill switch (no deploy) restores current behavior; otherwise revert the PR and redeploy (full edge cycle).

## 9. Evidence semantics
No evidence row, confidence, corroboration or custody logic changes. What changes is WHEN the report/finalize artifacts are
written (after the loop), which removes partial-transcript persistence and the mis-scoped salvage report in the cancelled-browser case.

## 10. Risks to review
(1) A truly CPU-killed isolate now depends on recovery rather than the cancel hook — the grace window is the key decision.
(2) Two overlapping runs on one thread (the lease is separate work) still each persist; this proposal does not add run ownership.
