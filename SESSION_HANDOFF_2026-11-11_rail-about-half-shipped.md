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

## §4 The local e2e failure: a macOS timing failure; no regression found

`e2e/stage1b-wcag.spec.ts`, "Evidence Ledger — quarantined row selected (release-gate visible)", failed locally on the macOS workstation at both viewports (1280x720 and 1440x900).

What was measured:

- **Locally (macOS, this session):** the violation is axe `color-contrast`, impact serious, on nodes inside the "Filter evidence" dropdown. The menu container has `data-state="closed"` and the reported contrast is 1.04 (foreground `#111214` on background `#0b0c0e`): text sampled while the menu fades out, not a resting colour. It failed on `3a7d15b` in the full run and again on `3c5daf1` with the #1024 change stashed (one rerun of that test alone). `PW_REUSE_HARNESS` was unset, so a stale harness server was not being reused (#884).
- **In a clean Linux environment (reported by JD's reviewing session, not re-run here):** the spec passed 15 of 15 at `48c250d` (before #1015) and 15 of 15 at `3c5daf1` (5 runs at each of 3 viewports).
- **CI (Ubuntu):** the push-to-`main` e2e job was success on `3c5daf1` and success on `9120a4c`.
- **The spec (read this session):** the test clicks "More filter", clicks the Quarantined item (which closes the menu), waits for the quarantined row and the inspector, then runs axe. It never waits for the menu to be hidden. `playwright.config.ts` does not disable animations.
- **#1015's reach (reported by the reviewing session):** in that dropdown it changed chip labels and hints only, no colour.

Conclusion: no regression was found, on #1015 or #1024. The evidence fits a timing failure in the test on this workstation: axe samples the dropdown during its close animation. Linux cannot reproduce a macOS-only failure, so this is "no regression found", not "flake proven". The local failure rate was not measured.

The e2e job skipping on pull requests is by design (`if: github.event_name == 'push'` in `.github/workflows/ci.yml`), not a fault. Its consequence stands: a local `npm run test:e2e` is the only e2e signal before a merge, and on this workstation it currently shows these two failures.

Option for later, low priority, JD's call: a test-only hardening PR that waits for the menu to be hidden before the axe scan. It must not disable the `color-contrast` rule or exclude the node.

The primary checkout at `/Users/dizosint/insight-finder` sits on an old local branch named `fix/e2e-macos-flake` (tip `750e885`, 124 commits behind `main`, no PR found for that head). It was not read.

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
- **"Fails without my change" is not "fails before the suspect change".** This session first compared `3c5daf1` with and without #1024, which cleared #1024 but said nothing about #1015. Clearing #1015 needed a run on `48c250d`, which the reviewing session did.

## §7 What was NOT done, and why

- The macOS e2e test (§4) was not hardened: out of scope for a one-behaviour PR, and low priority now that no regression was found.
- Nothing in the queue (§5) was started: each item needs JD's named go and its own session.
- No worktree or branch was removed. Left in place: `.claude/worktrees/rail-about-half` (branch `fix/rail-about-half`, merged) and `.claude/worktrees/right-rail-agentic-scoring-bbd3f1` (the merged #1015 branch).
- `/health` was not re-measured: no edge change.
- No browser check of the rendered rail in production. The proof is the `READY` production deployment plus the string in the served chunk. No production case was opened, so whether any existing case sits at exactly half is unknown.

## §8 Files in this docs change

- `SESSION_HANDOFF_2026-11-11_rail-about-half-shipped.md` (this file).
- `NEXT_SESSION_PROMPT.md`: rewritten for the next task (ship the one PR JD names from the ready queue).
- `CLAUDE.md`: the "Last verified" state line and the handoff reading order updated to name this file.

## §9 Next

No session is needed for the e2e failure: it is answered in §4. Each item below is its own session, on JD's named go:

1. **#1009, then #1014** (retarget #1014 to `main` after #1009 merges).
2. **#1016**, then the edge chain **#1017 → #1018 → #1019**, with JD's rulings on #1018 and #1019. The repo is squash-only and never deletes branches, so after #1016 squash-merges, #1017's base is still the old branch: retarget it to `main` and rebase by hand before it merges. The same holds down the chain. Each edge PR also needs a rebase on `health-handler.ts`.
3. **#1023** (rebase against this handoff's CLAUDE.md edit, or the reverse).
4. **Still JD's:** the upload-only stored-row proof for #1007 (run one upload-only case, then the counts-only query for threads created after 2026-11-11 06:25Z; want 0 leaking with at least 1 thread), and the `stale.yml` decision.
5. **Optional, low priority:** the test-only hardening in §4.

The opening prompt is in `NEXT_SESSION_PROMPT.md`.
