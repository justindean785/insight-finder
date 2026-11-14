# Session handoff — 2026-11-14 — Subject Name rule and multi-selector seed

Every figure here is a dated measurement (2026-11-14, about 11:40Z). Re-measure before acting.

## 1. State

- `main` is `2d2584b`: #1032 (Subject Name rule v2, squash `a90c770`) and #1036 (multi-selector seed, squash `2d2584b`) are merged. JD approved both merges.
- Vercel production succeeded on `a90c770`. The deploy for `2d2584b` and the `main` e2e run for both commits were still in progress when this was written: check them first.
- Live edge build is `6e0c7b6` (#1031, CORS preflight answered early; stamp #1034, ledger #1035). JD drove that deploy in the lockdown session. Nothing in this session touched the edge.

## 2. Open PRs

| PR | What | Head | State |
|---|---|---|---|
| #1033 | Maintenance endpoint lockdown (edge) | `1f87682` | ready, review addressed by its own session, not merged or deployed |
| #1038 | Maintenance lockdown plan (docs, split out of #1033) | n/a | open |
| #1029 | Edge tool-usage audit (docs) | `edb2e71` | ready, PR CI green |

- Last local gates before the #1036 merge, on its head `bc44125` (the merged tree): typecheck pass, lint 0 errors, unit 3,555 passed and 1 skipped (299 files), build pass, e2e 132 passed and 12 skipped, 0 failed.
- **#1033:** owned by its own session. Rollout order is in the PR body; deploy needs JD's go and the `edge-deploy` skill. Devin raised two flags that show only on Devin's review page; that session is checking them.
- No subscriptions or scheduled check-ins are left from this session: its PRs are merged.
- Devin reported flags it did not post on #1032 (1) and #1036 (6). They were never read. Both PRs are merged, so anything real in them is follow-up work.

## 3. JD's standing decisions from this session

- **Decision A:** releasing an artifact from quarantine does not establish that it belongs to the subject. Without positive linkage it stays unresolved.
- **Decision B:** evidence may keep supported linkage while its claim is disputed. A disputed claim is never an authoritative Subject Profile attribute until resolved. Linkage and claim verification stay separate.
- **Name rule v2 (approved):** one shared reading, `readSubjectName` in `src/lib/subject-linkage.ts`, used by every surface that names the subject. A name is asserted when it is the whole seed, or the one name whose words appear together and in order in the typed seed, or (when the seed names nobody) the single linked name. Two candidates are never reconciled by score.
- **Multi-selector seed (approved, four rulings):** every selector typed in the seed is the subject's and reads "Supplied as the case seed"; every seed contact of a kind is shown; a bare word is never a handle inside a composite seed; a selector that touches the 200-character cut is dropped.
- **Gates before push:** typecheck, lint, build, full unit suite, e2e and desktop plus mobile screenshots finish before a branch is pushed for review. Local commits are fine.
- **Linked sessions:** the starting session leads them without check-ins. Merge, deploy, mirror push, secrets and evidence-rule changes stay JD's.
- **Maintenance work:** do not deploy; do not touch Lovable secrets or `reveal_breach_data`; M2 and any scheduler need JD's written approval; logs carry no selectors, names, emails, phones, payloads, tokens or keys.

## 4. Known gaps (each is a separate change or JD's ruling)

- Decision B has no writer: nothing sets `metadata.conflict` and no control clears it.
- Decisions A and B are frontend only. The edge findings table and next-pivot brief still treat a release as restored authority. The release control still reads "Confirm linkage to subject".
- Hunter's note, Risk level and Analyst confidence count any non-quarantined name as the subject's. The Identity panel's DOB, Age, Phone and Region use the old negative gate.
- Decision B is applied to the Name only, not to contact fields.
- Rejection is honoured per row, not per name.
- When verdicts fail to load, the Report can assert a name that the rail and Connections withhold.
- The pivot engines, the graph's seed node, the case header and `seed_type` still read a composite seed as one string. The markdown export's "Detected subject" may be built from fragments of a two-email seed (inferred from code, not run).
- A released row whose name is typed in the seed is asserted as "Named in the case seed". This is pinned as current behaviour for JD to confirm or change.
- The harness thread's seed is an address at a non-reserved domain. Moving it belongs with JD's scrub decision.
- A mutation run was done on `c2bc34d` (30 of 30 caught) and on the six clauses added since. It was not repeated across the whole of #1036.

## 5. Next step

**UI-01 — Confidence and status clarity** (frontend only, its own PR, never combined with UI-02 to UI-05):

- Separate execution completion from investigative readiness.
- Clarify the identity linkage, corroboration and report-readiness percentages.
- Show denominators and confidence explanations.

Start by measuring: list every percentage and status the signed-in workspace shows, where each number comes from, and what its denominator is. Use the harness (`ui-harness` skill). Read `docs/AUDIT_2026-10-24_pivot-workflow-and-language.md` Finding 4 first: the three counting systems measure different things and must not be collapsed into one. Propose the changes with before screenshots and stop for JD's approval before changing what any number means. Display copy and layout need no ruling; a changed definition does.

Then UI-02 (right-rail pivot station), UI-03 (graph), UI-04 (mobile evidence), UI-05 (workspace polish), one PR each.

## 6. Traps met in this session

- A background workflow that hits the usage limit is paused, not dead. Both resumed after the reset and returned full results hours later.
- A reviewer reading the working tree may be reading a different branch than the PR under review. State the commit.
- `getByText("Email")` is ambiguous once a profile shows "Email" and "Email 2".
- The `stage1b-wcag` e2e test "quarantined row selected" fails now and then at one or two viewports on unmodified `main` too.
