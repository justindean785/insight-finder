---
paths:
  - "supabase/functions/osint-agent/**"
  - "supabase/tests/osint-agent/**"
---

<!-- Loads when editing the orchestrator. Moved verbatim from CLAUDE.md lines 152-190 on 2026-11-10. -->

## ⛔ Run-termination invariants — 48 hours of incidents live here (2026-07-26)

Full write-up: `INCIDENT_2026-07-26_termination-and-ghost-recovery.md`. Two invariants
now hold the line. **Do not "simplify" either one away.** Both are pinned by tests
(`recovery_test.ts`, `orchestrator_finalize_test.ts`, `intermediate_step_plan_test.ts`)
that assert the kill switches ship ON — if you flip one, those tests fail loudly, which
is the point.

- **I-1 — a thread with no run marker is NOT an interrupted investigation.** A blank
  thread is born `status='active'` (DB column default) with `run_started_at` NULL, and
  `isStaleActiveThread` falls back to `updated_at`, so without `hasRunMarker()` the
  health sweep reaps a thread the analyst never typed into and posts a fake "Findings
  report — recovered run". This shipped for ~11 days: 14 ghosts, 192/264 threads eligible.
- **I-2 — `status='finished'` may only *present as complete* with a durable
  report-shaped assistant message or an explicit `finalize_no_findings`.** `finished` is
  written on THREE different paths (clean finalize, `onError`, stale recovery); painting
  all three green is how a 10-character `"I'll start"` stub and a real report looked
  identical. Unmet contract ⇒ `recovery_reason` ⇒ UI renders **Interrupted**.

**The termination oscillation — read before touching `toolChoice`.** This project has
twice swung between extremes and broken production both ways:
  - `FORCE_TOOL_CALL_UNTIL_FINALIZE=true` forced a tool call on EVERY intermediate step →
    removed the model's only natural exit (a text-only report) → self-completion 61%→25%.
  - Pure `"auto"` everywhere → unfinished `"I'll now run…"` narration ends the run and
    marks it COMPLETE.
  The resolution is **phase-aware, not global**: `REQUIRE_TOOL_CALL_IN_OPENING_PHASE`
  forces a tool call *only* while the run has admitted **zero** tool calls **and** the
  latest user message parses as a seed. It releases the instant work starts. Never
  "fix" a termination bug by flipping a global toggle again.

**Also settled, do not re-litigate:** intent is NOT inferred from prose. A future-intent
regex was implemented and removed — it matched the legitimate closing line *"Drop a seed
and I'll run the investigation from TRIAGE through REPORT"*, fabricating a report on top
of a plain answer. Structural signals only (report shape, phase, length floor); anything
unclassifiable falls through to the completion contract and is labelled honestly.

**`stopWhen` cannot prevent a natural stop** — it only ADDS stop conditions. The SDK's
`finishReason:"stop"` on a text-only step is not vetoable from there. Don't try again.
