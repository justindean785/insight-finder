# Session handoff — 2026-11-14 — Subject Name rule and multi-selector seed

Every figure here is a dated measurement (2026-11-14, about 11:40Z). Re-measure before acting.

## 1. State

- `main` is `8c95420` (#1030, the stale-run sweep sends the signed-in user's token).
- Live edge build is `6e0c7b6` (#1031, CORS preflight answered early; stamp #1034, ledger #1035). JD drove that deploy in the lockdown session.
- Nothing from this session is merged or deployed.

## 2. Open PRs

| PR | What | Head | Base | State | PR CI |
|---|---|---|---|---|---|
| #1032 | Subject Name rule v2 (frontend) | `8123aff` | `main` | ready, mergeable | green |
| #1036 | Multi-selector seed (frontend), stacked on #1032 | `3c9e2fd` | the #1032 branch | ready, mergeable | green |
| #1033 | Maintenance endpoint lockdown (edge) | `79900f1` | `main` | draft | green |
| #1029 | Edge tool-usage audit (docs) | `edb2e71` | `main` | ready | green |

- PR CI does not run e2e. Local e2e on `3c9e2fd`: 132 passed, 12 skipped, 0 failed. Unit: 3,545 passed, 1 skipped (298 files). On `8123aff`: 3,522 passed, 1 skipped (296 files); e2e was last run on its parent `d687b3f` (the later commit is tests only).
- **Merge order:** #1032 first, then retarget #1036 to `main`.
- **#1033:** its session rebased onto `8c95420` locally, but the force-push was blocked by a permission check, so GitHub still shows the old head. JD must allow the push in that session. Rollout order is in the PR body; deploy needs JD's go and the `edge-deploy` skill.
- Auto-fix is on for #1032 and #1036 in the session that opened them. A new session must re-bind the PRs to receive review and CI events. There are no scheduled check-ins or other triggers to cancel.
- Devin reported flags it did not post on #1032 (1) and #1036 (6). They are unread.

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
