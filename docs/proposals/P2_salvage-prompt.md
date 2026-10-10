# Proposal P2 — The report-salvage prompt: scope, date, labels, failed lookups

Status: PROPOSAL ONLY. Changes what the model is told to assert in a persisted report (claim generation) — protected.
Keep separate from P1: either can ship alone.

## 1. Current behavior
`buildSalvageSynthesisPrompt(seed, artifacts)` (`orchestrator-finalize.ts` ~799) is called from `index.ts` (~1759) with
`seedValueRaw` (the thread's FIRST user message), the top-200 artifacts of the WHOLE thread, and the dateless base system prompt.
It asks for: a summary paragraph; "Confirmed findings grouped by type, each with its confidence and source"; gaps. It says
nothing about (a) which target this turn investigated, (b) today's date, (c) failed/skipped/empty lookups, (d) the difference
between a recorded observation and an adjudicated finding.
No prompt path (SYSTEM_PROMPT_FULL, workflow addendum, finalize directive, salvage) injects a date.

## 2. Reproduced failures (case 21e8bc95, read-only)
1. Title/scope: a pivot on an email produced "Findings Report: <first domain>", case-wide, appended after the pivot's text.
2. "Confirmed Findings" + confidence numbers written while the record states no authoritative finding rows exist.
3. "crt.sh returned 404 — no CT logs found": `crtsh_lookup` returns `{ok:false,error:"crt.sh 404"}` (phase1_free.ts ~109); the
   model turned a failed request into absence. `workflow_prompt.ts` tells it 404 is a deterministic stop but never says failed ≠ absent.
4. "Founded 2026" described as future: no reference date anywhere in the prompts.

## 3. Proposed behavior (all text/inputs; no row is created or changed)
a. Scope: pass `{ turnSeed, turnSeedKind, caseSeed }`; the report title and first line state "This turn: <turnSeed> (<kind>)"
   and "Whole-case summary as of <ISO date>". Never title a turn-scoped report with the case seed alone.
b. Date: add `Reference date: YYYY-MM-DD (UTC)` to the salvage prompt; separately (own decision) to the base prompt.
c. Labels: replace "Confirmed findings" with "Recorded observations (not adjudicated)" unless at least one `isFindingRow` row
   exists, in which case list ONLY those under "Adjudicated findings" with their persisted confidence; never restate a number
   that is not a stored value.
d. Coverage: feed a bounded `coverage` block from this thread's `tool_usage_log` (tool, outcome ∈ ok/empty/failed/skipped,
   status_code) and instruct: failed/skipped/timeout = coverage gap, never evidence of absence; an `empty` result = "no result from
   <tool>", scoped to that tool; a single provider's zero hits never establishes universal absence.
e. Inference guardrails (wording only, mirroring existing rules): shared infrastructure does not imply common ownership;
   different tool names are not independent sources; DNS/MX/parking observations are stated as observations.

## 4. Invariants that must not change
Persisted artifact/finding rows, `record_finding`, `confidence.ts`, corroboration, quarantine, custody, review filtering
(`applyReviewsToArtifacts`, fail-closed on unreadable reviews) · generated prose never creates authoritative rows ·
the Evidence Record block is still appended server-side exactly as today · salvage still bounded (top 200, same model, same cap).

## 5. Implementation surface
`orchestrator-finalize.ts` (`buildSalvageSynthesisPrompt` signature + text; new pure helper for the coverage block),
`index.ts` (call site only: derive turn seed from the LAST user message via the existing seed detector, read a bounded
`tool_usage_log` slice). Edge-only. Kill switch `SALVAGE_PROMPT_V2_DISABLED=true` (old prompt). New `/health` key
`checks.salvage_prompt` (self-test builds the prompt on a fixture and asserts the required sentences + no "Confirmed findings").

## 6. Tests
Prompt-builder unit tests on sanitized fixtures: (1) email pivot after a domain run ⇒ turn scope line names the email;
(2) zero finding rows ⇒ no "Confirmed" heading, "not adjudicated" present; (3) crt.sh 404 row ⇒ appears under coverage gaps,
absence wording forbidden by the prompt; (4) founding year equal to the reference year is not "future"; (5) kill switch ⇒ byte-identical
legacy prompt; (6) wiring test that `index.ts` passes turn seed + coverage. Model output itself cannot be unit-tested; add a
post-hoc linter test on SAMPLE outputs (flag "no CT logs found" next to a failed row) as a regression fixture, not a gate.

## 7. Production verification
`/health` key; one salvaged report on a controlled case (`report_salvaged` log event) showing scope line, date line, coverage
section, no unadjudicated "Confirmed". Salvage fires rarely once P1 lands, so this needs a deliberately interrupted run.

## 8. Rollback
Env kill switch; else revert + full edge cycle.

## 9. Evidence semantics
None stored. Reader-facing wording only, but it changes what the system asserts in prose, hence review. Open questions:
exact wording of the "not adjudicated" label; whether the date also goes into the main orchestrator prompt (broader effect, separate PR).
