# Handoff series — reading order (moved out of CLAUDE.md)

## Reading the handoff series

> **Archived 2026-10-14:** every dated handoff, audit and state note older than `SESSION_HANDOFF_2026-09-14` (the series named below, plus `AUDIT_REPORT_*`, `HANDOFF_*`, `PROJECT_STATE_*`, the June beta sign-off and checklists) was moved with `git mv` to `docs/archive/handoffs/`, so history is intact. A filename cited below that is not at the repo root is there. Handoffs from 2026-09-14 onward, the incident write-up, the `SCOPE_*` / `DESIGN_*` / `PRICING_*` / `PLAN_*` design notes and `NEXT_SESSION_PROMPT.md` stayed at the root.

`SESSION_HANDOFF_2026-08-09` → `…_2026-08-10_…-II` → `…_2026-08-10_…-III` →
`…_2026-08-14_deploy-transport-and-promote-boundary` →
`…_2026-08-23_report-authority-and-ci-recovery` (re-measured the baselines and carries the
production corpus numbers that govern #477/#479/#482) →
`…_2026-08-25_merge-deploy-and-tool-telemetry` →
`…_2026-08-26_workspace-pass-and-production-defects` →
`…_2026-08-31_workbench-truth-boundary` (its §4 is the trap list, §6 the honest not-done
list, §7 the ordered plan) →
`…_2026-09-03_evidence-board-and-pivot-quality` →
`…_2026-09-07_drop-suppression-and-the-duplicate-pr` →
`…_2026-09-08_queue-drain-and-dispatch-deploy.md` →
`…_2026-09-12_promotion-quarantine-and-measured-audit.md` (its §2 is the
promotion-quarantine switch, §3 the trap list of four instruments that lied) →
`…_2026-09-13_instrument-truth-and-the-lineage-prerequisite.md` →
`…_2026-09-14_sweep-false-positives-and-the-memory-retrieval-gap.md` →
`…_2026-09-20_prompt-ceiling-payload-store-and-the-overlap-wedge.md` →
**`SESSION_HANDOFF_2026-10-19_obsidian-foundation-and-stage-a-shell.md` (newest, frontend design revamp only — read it first for UI work: #805/#806/#807 merged, §3 the JD-ordered queue (trust labels, Stage C1), §5 the traps)** →
**`SESSION_HANDOFF_2026-10-19_integrity-before-tool-fleet.md` (newest for backend, orchestrator and evidence-integrity work — read it first for that).** It covers JD's latest direction, what was done since the 10-14 save, the PR queue (#797 ready; #799 and #800 drafts; the #593 decision), the three integrity defects, and the verify commands. Its evidence is in `docs/AUDIT_2026-10-18_full-code-review-lovable-vercel-github.md` (F1–F33) and `docs/AUDIT_2026-10-18-evening_state-pr-queue-next-tasks.md` (F34–F41; §10 is the integrity re-trace). Its §"Addendum" records what changed after it was written →
`SESSION_HANDOFF_2026-10-14_anthropic-orchestrator-and-the-dropped-connection.md` (read second for backend work; Anthropic went live, the dropped-connection run-termination bug was measured and fixed in #758, §3 is the PR queue, §5 the trap list, §6 the ordered plan) →
`SESSION_HANDOFF_2026-10-10_s1a-admission-lease-and-the-heartbeat-incident.md` (read second; the run lease is built, deployed and switched OFF, §5 is the JD-gated queue, §6 the release traps) →
`SESSION_HANDOFF_2026-10-10_evidence-guards-and-the-learning-loop.md` (read third; its §5 is the plan for making the agent learn from every run, §3 the ordered queue, §6 the release traps. **Superseded on one point:** its §5 L5 says the server-side run lease is "unbuilt" — S1a shipped as #730/#734 and is disabled by switch) →
`SESSION_HANDOFF_2026-10-06_release-train-and-audit-queue.md` (the draft-PR queue and release-recipe traps; `docs/proposals/` holds the P1/P2/P3 and E1-E4 design proposals).
Its §1 is the state and the caveat that Releases 1–2 are not yet observed in production, §3 JD's
standing rules, §4 the draft-PR queue with proof keys and recommended order, §5 the release-recipe
traps, §7 the decisions only JD can make, §9 the ordered plan.
The 09-20 handoff: its §2 is the stale-baseline correction, §4 the production overlap wedge
(the highest-value unfixed defect), §5 the `unknown` stop reason, §6 the payload-store decision
and why the store is a TABLE not the archive bucket, §7 the trap list, §9 the ordered plan.
The 09-14 handoff. Its §2 is the sweep bug that was manufacturing evidence, §4 the
memory-retrieval gap, §5 the built-and-dark synthesis layer, §7 the ruling on Lovable's audit
prompt, §8 the trap list, §9 the one open decision, §11 the ordered plan.

The 09-13 handoff. Its §3 carries the three verified findings that reorder the plan
(the GitHub 401, the missing call-to-artifact lineage, telemetry durability), §5 states the
goal, **§6 is the ordered roadmap**, **§7 is the small-PR discipline and why a large PR
cannot be deployed or reverted here**, §8 the trap list, §9 the ruling on Codex's planning
PR #586, §10 the open-PR queue.
`NEXT_SESSION_PROMPT.md` is the companion entry point and is the more current of the two.
Take the dated state from the top of THIS file rather than from any handoff's own §1 state
table — every one of them has been overtaken by a later session, including the 09-07 pair,
whose §1 predates the `4e6888a` deploy. Each corrects the
one before it, and **every one of them is a dated measurement, not a state.** III's own §1.0
is the lesson: a "deploy axis verified green" claim went false within six hours because the
mirror is writable by a second agent whose edits this repo never sees.

Read III plus its §11 corrections if you read only one. Then treat these as already applied
and do not act on the superseded originals:

- III's §3 promote-boundary P0 is **closed** (#448) — this file's section above is current.
- II's §2 status table lists #436/#437/#438/#439 as unmerged drafts; all are long since
  resolved. Its §2.1, *what green CI missed*, is still the most useful page in the repo:
  every defect caught in review here was a **timeline or identity** error, not a logic
  error, and every one passed the full suite, typecheck, lint and build. **A behavioural
  test must DRIVE the shipped control flow, never re-describe it.**
- The 08-09 handoff's three-boundary framing is right; its status is not.

