# Session handoff — 2026-11-11 — the rail says "about half" at exactly half (#1024, `9120a4c`)

Every number below is a dated measurement from 2026-11-11, about 03:57–04:55 PST (11:57–12:55Z), not a state. Re-measure first. No real case value appears here and none may be added: the repo is public.

## §0 Rules (unchanged; all in CLAUDE.md → SETTLED)

`REVEAL_BREACH_DATA` stays ON · `RUN_LEASE_DISABLED=true` stays · `MAX_PAID_CALLS` stays bounded · intent is not inferred from prose · GLM primary / Anthropic backup, do not re-pin · edge ships only via stamp → surgical mirror sync → `verify:deploy` → Lovable message → `/health` moved build → ledger · one PR = one behaviour · never mix frontend and edge · squash only, never delete branches. Address the user as JD.

## §1 State (verified)

- **`main` = `9120a4c`** (#1024, squash-merged 12:42:41Z on JD's go). Parent is `3c5daf1` (#1015).
- **Vercel production** = deployment `dpl_6YLJehKvcnFcyuj1Kb7NDfMvnR44`, `READY`, `target: production`, commit `9120a4c`. Checked through the Vercel API (`target` field), not the checkmark.
- **Served bytes:** the production page and 49 JS chunks were fetched at about 04:45 PST. The string `About half of what was found links to the seed` is in the lazy `ChatPage` chunk (`assets/ChatPage-DS3Z8FfZ.js`). The hash changes on every build; search for the string, not the file name.
- **CI push run on `9120a4c`:** success on all four jobs, including "Workspace e2e (playwright)". The push run on `3c5daf1` (#1015) was also all green, including e2e.
- **Edge is untouched by this session.** Live `osint-agent` was not re-measured here; the last figure is `3f6ed05`, 72 checks, 0 not ok, from the audit at about 03:25 PST. Take the live build from `/health`, not from this file.
- Nothing is uncommitted or unpushed from the #1024 work. This handoff and the two edits beside it (§8) are the only pending changes.

## §2 What shipped

| PR | Channel | What |
|---|---|---|
| #1024 | frontend | `assessmentReading()` reserves "Most" for MORE than half. Exactly half now prints "About half of what was found links to the seed." (`9120a4c`) |

The bug: `src/lib/assessment-sheet.ts` chose the sentence with `linkedTotal * 2 >= others`, so 2 of 4 (or 1 of 2) printed "Most of what was found links to the seed." It was introduced in `27583af` (part of #1015) together with a test titled "says most links when at least half do", which pinned the wrong behaviour. It was live in production from 03:28 PST (the #1015 merge) to about 04:43 PST.

The sentence table as it now stands, in order of precedence:

| Condition | Sentence |
|---|---|
| no findings besides the seed (`others <= 0`) | none (null) |
| 1 contradiction | "1 finding contradicts the case record. Read it before relying on the rest." |
| N contradictions | "N findings contradict the case record. Read them before relying on the rest." |
| nothing links, every finding held | "Everything found is held: its link to the subject is unproven." |
| nothing links, mixed reasons | none (null); the Connections section lists the reasons |
| every finding links | "Everything found links to the seed." |
| more than half link | "Most of what was found links to the seed." |
| exactly half link | "About half of what was found links to the seed." (new) |
| fewer than half link | "Most of what was found does not link to the seed yet." |

Only the last three rows were touched, and only the middle one is new. Display copy only: no count, linkage figure, row ordering, quarantine rule, confidence value or stored value changed. The seed's own row is still excluded from the share (`others`).

**One authority.** `assessmentReading()` in `src/lib/assessment-sheet.ts` is the only place that decides this sentence. Its single caller is `buildAssessmentSheet()` in the same file; `src/components/workspace/CaseSheet.tsx` only renders `assessment.reading`. A grep of `src` and `e2e` for the sentences found no other printer or asserter besides `src/test/assessment-sheet.test.tsx`, and no second copy of the `* 2 >=` threshold. e2e does not assert this sentence at all.

**Diff:** two files, 34 insertions, 5 deletions. `src/lib/assessment-sheet.ts` and `src/test/assessment-sheet.test.tsx`.

**Kill switch:** none. A revert of `9120a4c` restores the old text.

## §3 Verification

Tests were written first.

- **Baseline on `3c5daf1`:** the single file passed 24 of 24.
- **Red:** with the new tests and the old code, 2 failed and 25 passed. The failures were "says about half when exactly half link" and "picks the sentence by the share alone, for every split up to 8 findings", both with "Most…" received where "About half…" was expected. The two other new tests ("more than half", "just below half") passed, as they should under the old `>=`.
- **Green:** single file 27 of 27.
- **Local, on the PR head `3a7d15b`:** typecheck clean · lint 0 errors (8 warnings, all existing) · vitest **3,420 passed / 1 skipped / 292 files** · `npm run test:e2e` **126 passed / 12 skipped / 2 failed** (see §4).
- **CI on the PR head `3a7d15b`:** 6 checks passed, 0 failed. "Workspace e2e (playwright)" was skipped: that job has `if: github.event_name == 'push'` in `.github/workflows/ci.yml`, so it never runs on a pull request, only on pushes to `main`.
- **CI push run on `9120a4c`:** all four jobs green, including e2e.

New tests in the `assessmentReading — the rail's first sentence` block (the old "at least half" test is gone; the 1-of-6 test is untouched; no two tests share a title):

1. says most links only when MORE than half do (3 of 4, 3 of 5)
2. says about half when exactly half link (2 of 4, 1 of 2)
3. keeps 'does not link yet' just below half (1 of 3, 2 of 5)
4. picks the sentence by the share alone, for every split up to 8 findings (every `linked` from 1 to `others - 1`, for `others` 2 to 8; the expected sentence is restated in the test with integer arithmetic, independent of the implementation)

## §4 The local e2e failure: a macOS-only failure, not a regression on `main`

`e2e/stage1b-wcag.spec.ts`, "Evidence Ledger — quarantined row selected (release-gate visible)", failed locally at both viewports (1280x720 and 1440x900).

What was measured:

- The violation is axe `color-contrast`, impact serious, on nodes inside the "Filter evidence" dropdown: the menu container has `data-state="closed"`, and the reported contrast is 1.04 (foreground `#111214` on background `#0b0c0e`). That is text caught while the menu fades out, not a resting colour.
- It fails the same way on pristine `3c5daf1` with the #1024 change stashed (one rerun of that test alone). So #1024 did not cause it.
- The same suite passed in CI on Ubuntu on both `3c5daf1` and `9120a4c`.

Reading (mine, not proven): the axe scan runs before the menu's close animation ends on this workstation. The workstation is macOS; CI is Linux. The earlier local figure of 128 passed / 12 skipped was taken before #1015 merged, so it is possible #1015 changed the timing or the page state this test scans, and only the slower local run shows it. What was NOT done: no repeat runs to measure a failure rate, no check of whether the test itself opens that menu, no bisect.

The primary checkout at `/Users/dizosint/insight-finder` sits on an old local branch named `fix/e2e-macos-flake` (tip `750e885`, 124 commits behind `main`, no PR found for that head). The name suggests earlier macOS flake work; it was not read.

Consequence for the workflow: because the e2e job never runs on PRs, a real e2e regression is first seen on the push to `main`, after the merge. A local `npm run test:e2e` before merge is the only earlier signal, and on this workstation it currently carries these two known failures.

## §5 PR board (re-measured about 04:50 PST with `gh pr list`)

Not started in this session. The fix prompt's queue section was stale in four places; the list below is what the board shows now.

Ready or near-ready, waiting on JD, nothing approved:

- **#1009** (frontend, base `main`): "an interrupted-run notice is a status card, never a superseded report". Goes before #1014.
- **#1014** (frontend, base is #1009's branch `claude/ecstatic-galileo-07c405`, not `main`): "a reply is only superseded by a later report in the same exchange". Retarget to `main` after #1009 merges.
- **#1016** (frontend, base `main`): "a dotted handle is a username seed, not a domain (frontend half)".
- **#1017 → #1018 → #1019** (edge, literally stacked: #1017 is based on #1016's branch, #1018 on #1017's, #1019 on #1018's). Titles on the board: #1017 "a dotted handle is a username seed, not a domain (edge half)"; #1018 "a lookup on a shortened seed handle runs tainted, with a hint naming the exact handle"; #1019 "a recorded profile whose URL ends in the exact seed handle carries that handle". These titles differ from the fix prompt's description (punycode TLDs, guard fields), which was taken from tip commits. Read each PR's full diff, not its last commit. **#1018 and #1019 change evidence rules and need JD's explicit ruling.** As a stack they break the one-edge-PR-in-flight rule: merge and deploy strictly in order, each with its own build proof, each on JD's named go.
- **#1023** (docs, base `main`): moves path-scoped CLAUDE.md sections to `.claude/rules` (433 → 157 lines). Read the diff first; it rewrites the file every session loads. It will conflict with the CLAUDE.md edit in this handoff's PR (§8): whichever merges second needs a rebase.

Closed: **#1013** (closed 06:17:21Z as a duplicate of #1007; branch kept). No action left.

Older, unchanged by this session: #963, #973 (conflicts), #929 (red), and drafts #998, #997, #883, #882, #821, #804, #800, #793, #763, #701, #613, #593, #516.

## §6 Traps found this session

- **The session opened in `/Users/dizosint/Claude`, which is not the repo.** The canonical checkout is `/Users/dizosint/insight-finder` (remote `origin` = the public repo; a second remote `mirror` exists). About 40 worktrees hang off it. Never switch branches in the primary checkout; add a worktree.
- **A new worktree needs `npm ci`.** It printed install-script warnings (esbuild postinstall, fsevents) and did not run them; vitest, typecheck, lint, the build inside Playwright's web server and e2e all worked anyway.
- **`security-headers.test.ts` passed inside the full suite this time** (the fix prompt warned it fails in the sandbox on a blocked read of `.env.example`). No rerun was needed.
- **`npm run test:e2e` must run outside the sandbox.**
- **The GitHub deployments API returns nothing for this repo.** Vercel reports through the commit status named `Vercel` and the Vercel API. For `target`, ask Vercel: list deployments filtered by the commit SHA, team slug `justindean785-2985s-projects`, project `insight-finder`.
- **A commit status of "success" from Vercel does not say `production`.** On the audit commit `3c5daf1` only the status was read in this session; `target` was confirmed only for `9120a4c`.
- **The new sentence is in a lazy chunk.** A search of only the scripts named in `index.html` misses it; follow the chunk imports.
- **Two sessions were live at once** (the one that shipped #1015 and this one). The #1015 session stated it would not touch the fix. If both are still open, only one should act on the queue.

## §7 What was NOT done, and why

- The macOS e2e failure (§4) was not fixed or investigated beyond one rerun: out of scope for a one-behaviour PR.
- Nothing in the queue (§5) was started: each item needs JD's named go and its own session.
- No worktree or branch was removed. Left in place: `.claude/worktrees/rail-about-half` (branch `fix/rail-about-half`, merged) and `.claude/worktrees/right-rail-agentic-scoring-bbd3f1` (the merged #1015 branch).
- `/health` was not re-measured: no edge change.
- No browser check of the rendered rail in production. The proof is the `READY` production deployment plus the string in the served chunk. No production case was opened, so whether any existing case sits at exactly half is unknown.

## §8 Files in this docs change

- `SESSION_HANDOFF_2026-11-11_rail-about-half-shipped.md` (this file).
- `NEXT_SESSION_PROMPT.md`: rewritten for the next task.
- `CLAUDE.md`: the "Last verified" state line and the handoff reading order updated to name this file.

## §9 Next

In order, each its own session, each on JD's named go:

1. **Decide the macOS e2e failure** (§4): read-only measurement first (repeat runs on a fresh worktree off `main`, find whether the test opens the "Filter evidence" menu, compare with `fix/e2e-macos-flake`), then a proposal. This restores the only pre-merge e2e signal.
2. **#1009, then #1014** (retarget after #1009).
3. **#1016**, then the edge stack **#1017 → #1018 → #1019** with JD's rulings on #1018 and #1019.
4. **#1023** (rebase against this handoff's CLAUDE.md edit, or the reverse).

The opening prompt for item 1 is in `NEXT_SESSION_PROMPT.md`.
