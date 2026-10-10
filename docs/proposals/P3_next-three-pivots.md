# Proposal P3 — A run owns a bounded objective: its next three highest-value pivots

Status: DESIGN PROPOSAL. Touches termination behavior (high-incident area) — sign-off required before any code.
Presentation half (cycle labels) can ship separately.

## 1. Current behavior
Each request is one bounded "cycle": `buildPerCycleCompactDirective` tells the model to report only this cycle's new findings and
"pivot"; the model typically finishes with a "Next 3 pivots" list and a `natural_stop` (e.g. thread 94ef8115, 21:07 run: 4 steps,
10 tool calls, `natural_stop`). Further work needs another user message (Continue) or Auto-run (capped at 3 cycles, stops on no new
evidence). The thread then shows Complete although the agent announced work it did not do. Run limits: `MAX_ORCHESTRATOR_STEPS=22`,
wall clock 180 s, finalize reserve, per-isolate paid-call cap (`MAX_PAID_CALLS`, settled — not changed here).

## 2. Goal
One run = one bounded objective: execute up to its next 3 highest-value pivots (or stop earlier with a stated reason), inside the
existing time/step/paid-call budgets. Raising the Auto-run cap is explicitly NOT the mechanism.

## 3. Proposed mechanism (phase-aware, not a global toggle — per the termination-oscillation history)
- Pivot phase state in the run: `pivotsPlanned` (from the model's structured next-pivot list OR the server's pivot engine),
  `pivotsAttempted`, `pivotsCompleted`. Cap 3.
- After the first work phase, if budget remains (`time left ≥ reserve + estimate`, step budget, paid calls) and
  `pivotsAttempted < 3`, `prepareStep` injects a pivot directive ("run pivot k: <action> on <target>") and sets `toolChoice` to
  required ONLY while a pivot is unattempted — released the instant it is attempted (mirrors `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`).
- A pivot counts attempted when a tool call whose selector matches the pivot's target is admitted; completed when it returns a
  recorded outcome (ok/empty/failed — failed/empty are valid completions of an attempt, recorded as coverage, never as findings).
- Stop reasons recorded durably (no schema change; reuse the #714 note channel): `pivots_done`, `budget_exhausted`,
  `no_valuable_pivot`, `finalize_window`.
- Pivot choice uses the existing, already-validated suggestion contract (`pivotSuggestionSchema`, `validatePivotSuggestion`,
  shared-infrastructure demotion from #715); sentence-valued or boilerplate targets are never executed.

## 4. Invariants that must not change
`MAX_PAID_CALLS` bounded · I-1/I-2 · finalize window/state machine · quarantine and analyst-rejection dispatch guards (a rejected
selector is still refused; a quarantined one is dispatched and tainted) · no intent inferred from prose (the pivot list must come from
structured data, not regexes over narration) · no new evidence authority.

## 5. Implementation surface
`index.ts` `prepareStep` (new third branch next to the opening-phase and finalize branches), a new pure `lib/pivot-phase.ts`
(state machine + budget predicate, fully unit-testable), `orchestrator-finalize.ts` (directive text), telemetry (`pivots_*`),
`health-handler.ts` (key `checks.pivot_phase`), kill switch `PIVOT_PHASE_DISABLED=true`. Frontend: cycle labels only (below).

## 6. Tests
State-machine tests (budget, cap, release-on-attempt, rejection, kill switch); a prepareStep integration test over a fake model
proving: toolChoice required only while a pivot is unattempted; text-only exit remains available once 3 are attempted; the run still
reaches finalize with a report when budget runs out mid-pivot (the two historical oscillation failures as regression cases).

## 7. Production verification
Measure before/after on real runs: pivots attempted per run, % of runs ending `natural_stop` with an unexecuted "Next pivots" list,
self-completion rate (the 61%→25% regression metric), `finalize_forced` share, p50/p90 duration, cost per run. Roll out dark
(flag default OFF) → enable for one case → compare.

## 8. Rollback
Kill switch (no deploy). Because this is the termination area, ship dark and enable by environment only after review.

## 9. UI (presentation only, no execution role)
Label each run group "Pivot 1/3 — <action> <target>" with outcome (attempted/completed/failed/skipped) and "Objective: next 3 pivots —
2 done, 1 skipped (budget)". Derived from `tool_usage_log` + the recorded stop reason; never drives the run.

## 10. Dependencies / risks
Overlapping runs make any per-run budget unreliable until the server-side run lease exists (still unbuilt, schema + edge). The
60-180 s wall clock bounds how many pivots fit; expect 1–2 on slow providers and report that honestly. The pivot list source
(model-structured vs server pivot engine) is the main design decision to settle first.
