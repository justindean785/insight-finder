# Session handoff — PR board triage (2026-10-31)

> Dated measurement, not a state. Taken 2026-10-31 ~13:55Z from `origin/main` `9218a8e1`. Nothing was merged, deployed or closed. Every action below needs JD's named go.

## 1. State re-measured

| Thing | Value |
|---|---|
| `origin/main` | `a753f56e` (#930, merged 13:53Z, verified via API) <- `9218a8e1` (#932 tests) <- `f52ab811` (#931) <- `b8bee003` (#927) <- `96f6bac6` (#903 docs) <- `6e8498ab` (#906) |
| live `osint-agent` `/health` | build `cb4c6a27` (the #923 FOFA stamp, **newer than the `6eb444f` CLAUDE.md names**), 61 checks, 0 not ok, `deepseek` / `glm-5.2` |
| undeployed edge runtime on `main` | none: `git diff 185afd8b origin/main -- supabase/functions` is empty. `185afd8b` is the #923 stamp commit that sets `BUILD_MARKER` to `cb4c6a27`; the live `/health` build matching that marker is the deploy proof, and the empty diff shows `main` has no edge runtime change since that stamp. #932 is tests only. |
| frontend | #927, #931 live via Vercel (Production success per the prior session) |
| baselines | vitest 3027/1/256 and e2e 102/13 on 2026-10-31 after #931 (prior session); edge 2821/0/6 |

Stale line to fix in CLAUDE.md later (docs PR, not now): "live = `6eb444f`" should read `cb4c6a27`.

## 2. Open board: 23 PRs when listed (22 now that #930 merged)

Conflicts measured with `git merge-tree` against `main` (GitHub reports UNKNOWN for most drafts). Channel: F frontend, E edge, S schema, D docs. CI is green on every PR except #804.

| PR | Ch | State | vs `main` | One line |
|---|---|---|---|---|
| #930 | F | **MERGED `a753f56e`** (13:53Z; the row below was true when the board was listed, it merged during this session) | - | Grace timer no longer kills next run's stream, finalize window named. Measured 3035/1/256 and e2e 101/13 on its own head. |
| #929 | E | draft | clean | Orchestrator writes English (rule in base prompt + every intermediate step). Edge 2829/0/6. Kill switch, proof key `checks.response_language`. |
| #926 | E | draft | clean | `markdown_extract` safeParse never throws on `<url>`. |
| #925 | E | draft | clean | `breach_check` accepts numeric phone. |
| #868 | E | READY | clean, 53 behind | `memory_save` entry aliases. Low value (7 failures in 10 days). |
| #928 | E | draft | clean | M1 tool-lesson brief. Waits on JD's Q1-Q10 and its own edge cycle. +1674 lines. |
| #912 | E | draft | clean | `record_artifacts` links evidence row to artifact. |
| #913 | F | draft | clean | Remove unused UI primitives and packages. Needs a build-size look before ready. |
| #914 | D | draft | clean | Handoff 10-30 "FOFA stamp pending". **Stale**: stamp #923 landed. |
| #799 | E | draft | clean | Jina 403 no longer suppresses Jina. |
| #801 | E | draft | clean | `media_leads` + geo workflow. |
| #800 | E | draft | CONFLICT `tool-cache-version.ts` | Wayback CDX parallel. |
| #821 | E | draft | CONFLICT `health-handler.ts` | Prompt tier words. |
| #701 | E | draft | CONFLICT `health-handler.ts` | LeakCheck probe, ships OFF. |
| #763 | E | draft | CONFLICT `health-handler.ts` | `apify_skip_trace`. |
| #738 | E | draft | CONFLICT 3 files | **Superseded by #831** (shipped 2026-10-26), per CLAUDE.md. |
| #613 | S | draft | CONFLICT `ci.yml` | Lineage schema, unapplied. 207 behind. |
| #516 | F/O/S | draft | CONFLICT `ci.yml` | Account deletion, dark. 402 behind. |
| #593 | F | draft | CONFLICT 3 files | Dedupe never donates authority. 110 behind. |
| #793 | D | draft | CONFLICT CLAUDE.md etc. | 10-18 code-review docs. 97 behind. |
| #804 | F | draft | CONFLICT, **CI red** | Cold Room register. 107 behind. |
| #882 | F | draft | CONFLICT 3 files | Chat/Workbench pivot queues. |
| #883 | F | draft | CONFLICT 3 files | Recorded-confidence explanations. |

12 conflict with `main`: #516 #593 #613 #701 #738 #763 #793 #800 #804 #821 #882 #883. The prior session's "~13" was an estimate.

Note: every edge PR adds one `/health` proof key in `health-handler.ts`, so after the first deploy each later edge PR needs a rebase.

## 3. The two loose ends (both already have PRs)

- **Output-language fix**: [#929](https://github.com/justindean785/insight-finder/pull/929), branch `fix/orchestrator-english-only`, head `07b8b256`, draft, CI green, merges clean. Blocked only on being marked ready, JD's go, and an `edge-deploy` cycle (stamp, surgical sync, Lovable deploy, `/health` shows `checks.response_language`). Its body asks to ship ahead of the approved edge queue because it is a production-visible defect (case `5663c718` closing report in Chinese).
- **ServerFollowPanel "panel-fix"**: [#930](https://github.com/justindean785/insight-finder/pull/930), branch `fix/server-follow-panel-compact`, head `8eb87e9e`, **READY**, CI green, merges clean. The figures that blocked it are now in the body (vitest 3035/1/256, e2e 101/13, typecheck clean). **Merged during this session as `a753f56e`; drop it from the candidate list.** Vercel Production deployment 7459486759 for that SHA reads `success`.

## 4. Recommendation for JD

**Next three merges, in order**

1. ~~#930~~ already merged (see §3). First candidate is now #929.
   Original reasoning for #930 (frontend, Vercel). Ready, clean, green, figures measured. Frontend only, so a revert is one Vercel rollback. Do first because it fixes the "Live view disconnected" bug on healthy runs.
2. **#929** (edge, own build). Fixes an observed production defect, 6 files, +151/-6, kill switch ships rule ON, adds nothing to the finalize window (it appends text to the per-cycle directive and the static prompt). Merge is inert until its deploy cycle; do merge and deploy as one step.
3. **#926** (edge, own build, after #929 is live). 62 lines, removes an uncaught throw. Then the approved queue continues #925, #868, #928.

**Edge draft that should be in flight: #929.** Merging several edge PRs before one deploy would put them all in one build (the mirror sync ships whatever is on `main`), which breaks the one-behaviour-per-build rule. So merge an edge PR only when its deploy cycle starts.

**Stale PRs to close (JD decides)**

- #738: superseded by #831.
- #914: describes a stamp that already landed (#923).
- #793: 10-18 docs, 97 behind, conflicts CLAUDE.md; any still-true content is cheaper to re-land than rebase.
- #804: red CI, 107 behind, conflicts ChatWindow and CSS; close or ask for a rebase.
- Hold, do not close without a decision: #516 (dark feature, 402 behind), #613 (unapplied schema), #593 (authority bug, needs rebase).

## 5. Standing decisions (unchanged)

GLM-5.2 primary / Anthropic backup. `RUN_LEASE_DISABLED=true`. `REVEAL_BREACH_DATA` on. Frontend-only work ships as one ready PR. At most one edge PR in flight. No merge, deploy or close without JD's named go.

## 6. Proof of anything merged

Nothing was merged by this session. #930 merged separately (`a753f56e`); Vercel Production deployment 7459486759 = success.
