# Session handoff — state audit, finalize window measured, two PRs closed (2026-11-01)

> Dated measurement, not a state. Taken 2026-11-01 ~00:40Z from `origin/main` `5743177`. Everything here was re-measured this session unless it is marked "attributed" (someone else's number) or "inference".
> Nothing was deployed. Changed this session: #738 and #914 closed, #933 merged, this docs PR opened.

## 0. SESSION CLOSE (2026-11-01 ~03:10Z) — read this first; it supersedes §7's ordering and §10

JD asked to stop at an easy place and continue in a fresh session. Sections 1-9 below are the earlier audit and are still accurate as dated measurements.

### Where everything stands (measured 03:10Z)
| Thing | State |
|---|---|
| `origin/main` | `5743177` (#933). Nothing merged since. |
| **#935** W1-A, real per-run credit economics on `/brain → Credits` | **READY**, head `96105c9`, CI **green**, mergeable clean. Codex raised 2 P2s (stale "today" spend; "last run" borrowing an older run's cost): **both verified and fixed**, replied, resolved. Graphify's 3 inline coupling notes: traced, replied, resolved, no code change. **CORRECTION (03:10Z): the earlier claim that all Graphify findings were resolved was WRONG.** Graphify's review BODY also lists 2 advisory findings I had not read; both are real, and I found a third defect myself. See "CORRECTION" below. **Do not tell JD #935 is merge-ready until those are fixed.** |
| **#936** W1-B, what works / what doesn't for every tool (Sources tab) | **DRAFT**, head `73a9205`, CI **running** at last read (Migrations green; Frontend and Edge in progress). **Next session: mark READY once CI is green**, then read Codex AND Graphify threads. |
| **#934** this docs PR | **DRAFT**, head `2db386f` (+ this section), CI green on the previous head. Waiting on JD to say ready. Not merged, so a fresh clone of `main` does NOT contain this file: read it with `git fetch origin claude/project-audit-next-steps-onxj6h && git show origin/claude/project-audit-next-steps-onxj6h:SESSION_HANDOFF_2026-11-01_audit.md`. |
| closed this session (JD's word) | #738, #914. Merged: #933. |

Branches (all pushed, working tree clean): `claude/project-audit-next-steps-onxj6h` (#934), `claude/run-economics-onxj6h` (#935), `claude/tool-observations-onxj6h` (#936). JD approved one new branch per PR, named `claude/<topic>-onxj6h`.

### CORRECTION (03:10Z) — #935 and #936 have unaddressed, verified defects in their hooks
I read Graphify's three inline threads on #935 but not its review BODY (review 5726151473), which lists two more advisory findings. Verified against the code on `claude/run-economics-onxj6h`:
1. **Stale data after the user changes** (`src/hooks/useRunEconomics.ts`, `useEffect`): it begins `if (!userId) return;` and never resets state, so a previous user's figures stay on screen when the id changes or goes away. **The same pattern is in `src/hooks/useToolObservations.ts` on #936.** Fix: reset to the loading/empty state at the top of the effect, including when `userId` is undefined.
2. **`.limit(2000)` on the step-token read** (`useRunEconomics.ts`): PostgREST caps a response at 1,000 rows whatever `limit` says. Unreachable today (12 runs x at most 22 steps, `MAX_ORCHESTRATOR_STEPS` = 22, is about 264 rows) but it would silently truncate totals. Fix: use `.limit(1000)` and treat a read that hits it as "token totals unavailable" (leave the map empty so the row shows "tokens —"), or page it with `fetchAllPages`.
3. **No `try`/`catch` in `useRunEconomics`** (found by me, not Graphify): a THROWN read leaves the Credits tab on "Loading…" forever and leaks an unhandled rejection. I caught and fixed exactly this in `useToolObservations` (#936) with a test written first and never ported it back to #935. Fix: wrap the async body, set `{ loading: false, error: message }` in the `catch`, mirror `src/test/use-tool-observations.test.tsx`.
Do each test-first on its own branch's PR (#935 for 1-3, #936 for 1), with a reply on the review thread or a PR comment ending in the attribution footer. Lower priority, noted in Graphify's prose and NOT verified: `fetchAllPages` uses offset paging over a newest-first order, so a row inserted mid-read could shift a page boundary (de-duplicating by `id` would close it; irrelevant while a window fits one 500-row page), and its `pageSize` is unguarded (a value <= 0 would loop). Both PRs carry identical copies of that file; change them identically.

### Subscriptions and check-ins (they do NOT carry over)
- This session was subscribed to **#934, #935, #936**. It unsubscribes at close so the new session can take over. **The new session must `subscribe_pr_activity` on all three.**
- One-shot check-in `trig_01WXvqbd1tUHqS32FB7eftF9` (was due ~03:26Z, bound to the old session) is **deleted** at close. The new session re-arms its own (`send_later`, ~50 min, then ~4 h; stop after 3 empty check-ins). `trig_019Uirv3aFDd6Sz7o24Dc316` already fired.

### JD's standing decisions (this session)
- **Memory program first**; "make the upgrade extensive": real data, credit usage, a brain that shows what works and what doesn't. Approved plan: `/root/.claude/plans/audit-current-state-and-effervescent-hammock.md` (local to the old container and may be gone; its substance is in §7's M1-M7 table and in the two PR bodies).
- "Go" is read as approval to **build Wave 1 (frontend only) under the repo's rules**. It is NOT a go to apply schema, deploy an edge build, change credential masking, flip a secret/flag, or auto-activate lessons. Each keeps its own named go.
- Chinese output "was already fixed": #929 stays a kill-switched draft, no deploy.
- Closing PRs: only #738 and #914 were authorized.
- No merge without JD's named go. Standing: GLM-5.2 primary / Anthropic backup; `RUN_LEASE_DISABLED=true`; `REVEAL_BREACH_DATA` on; `MAX_PAID_CALLS` bounded.

### What was built (details are in the PR bodies; do not re-derive)
- **W1-A #935:** `src/lib/run-economics.ts`, `credit-account.ts`, `fetch-all-pages.ts`, `src/hooks/useRunEconomics.ts`, `src/components/brain/RunEconomicsPanel.tsx`; reads `orchestrator_invocations` / `orchestrator_step_metrics` (owner-scoped SELECT policy checked in production). Key honesty rules: null cost is "not recorded", never $0; internal meter, not an invoice; finished runs only; no tool-vs-model split until `invocation_id` exists. A real-data check caught that the owner has **355 runs in 30 days**, so the first 200-row read would have mislabelled 17 days as 30 (now paged, relabels itself when capped).
- **W1-B #936:** `src/lib/tool-observation-classes.ts`, `src/hooks/useToolObservations.ts`, `src/components/brain/ToolObservationsPanel.tsx`. **Deviation from the memory plan §4.8:** `input_rejected` is split out of "other" (41% of failures, 180 of 436); 62% of failed calls carry no `status_code`, so kinds are read from the redacted `error_msg` (a heuristic, stated on screen). Flag = plan thresholds over 14 days (>=5 attempts, >=60% failed, >=2 cases). `fofa_search` is flagged only for failures that predate the #908 fix (0 calls since); the PR says so. `fetch-all-pages.ts` and its test are **byte-identical copies** of #935's, so either merge order is clean.
- Both PRs touch `src/pages/BrainGlobalPage.tsx` and `src/dev/supabase-mock.ts` in different regions. **After #935 merges, bring #936 up to date with a MERGE COMMIT, never a rebase**, then re-run its checks.
- Baselines on the PR branches, all measured locally (CI's Frontend job also passed on #935; I did not read its count): #935 vitest 3075/1/259, e2e 108/13; #936 vitest 3095/1/260, e2e 108/13. `main` is 3037/1/256 and 102/13.

### Exact next steps, in order
1. Re-measure (below), `subscribe_pr_activity` on #934/#935/#936, re-arm one check-in.
2. #936: when CI is green, mark READY; wait for **Codex AND Graphify**; read every thread explicitly; fix only what you can verify; reply on each thread with the footer; resolve. Never merge.
3. Tell JD #935 (and then #936) are ready for his "merge". After he merges #935, merge `main` into #936 and re-run `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.
4. Then **W1-C, brain growth** (Overview + Memories, frontend only, reads `agent_memory`): memories added per day (30 d), mix by kind, most re-used memories, copy that says "stored memory, not verified knowledge". New branch `claude/brain-growth-onxj6h` from `origin/main`. Test first; harness fixtures relative to now; e2e figures derived by hand; before/after screenshots at 1280 and 375; real-data expected figures from a read-only aggregate (counts only).
5. Then W1-D QoL (one small PR each): alias-twin note; "target unreachable" label (JD picks the wording); the redaction fix for `PASSWORDS_LIST_RE` (deletes neighbouring cells including **Source**; credential masking is integrity-critical: **build it, leave it DRAFT until JD signs off**).
6. Wave 2 (schema -> `invocation_id` stamping -> aggregator -> review UI) needs JD's answers to Q6, Q9 (thresholds), Q10 and a named go per step; see §7's M1-M7 table. **Do not start it unprompted.**

### Open questions for JD
- Merge #935? Mark #934 ready? (Both need his word.)
- **Security observation, untouched:** in production `anon` and `authenticated` hold the full default privilege set (including TRUNCATE) on `orchestrator_invocations` and `orchestrator_step_metrics`, although the migration granted only SELECT. RLS does not cover TRUNCATE and the web API exposes no TRUNCATE verb, so it looks like defense-in-depth only. Chase it or leave it?
- DNS-failure label wording; redaction-fix sign-off.

### Observed in a run JD pasted at close (unverified: from the pasted text only, no stored artifacts read)
An investigation of the handle `lild6x` ended with "**7 independent breach/credential-exposure sources queried — all clean**" and "the handle is a dead end". Worth a look by whoever next touches report language, against CLAUDE.md's rule that a lookup that found nothing is a result, not corroboration: (a) Snusbase, OathNet and Cloudsint are all breach aggregators with overlapping corpora, so "independent" overstates; (b) zero hits on a bare username says little about a person; (c) the same run reported LeakCheck 403 and Indicia 400 (matching the tool failures W1-B surfaces), then retried Indicia. The output was **English** (consistent with JD's "Chinese is fixed"), and the `[HISTORICAL MODEL OUTPUT]` labels from #831 were visible in it. Not investigated further; no action taken.

### Opening prompt for the new session
> Read `CLAUDE.md` and this handoff: `git fetch origin claude/project-audit-next-steps-onxj6h && git show origin/claude/project-audit-next-steps-onxj6h:SESSION_HANDOFF_2026-11-01_audit.md` (section 0 first). Re-measure before anything else: one `/health` read (build should still be `cb4c6a27`), `git ls-remote origin refs/heads/main refs/heads/deploy/live`, and `list_pull_requests` (look at `draft`). Then `subscribe_pr_activity` on #934, #935 and #936 and re-arm one check-in. **Do not merge, deploy, run DDL, change flags or secrets, close a PR, or touch credential masking without JD's explicit named go.** Then follow "Exact next steps" in section 0: mark #936 ready once its CI is green and read Codex and Graphify, then build W1-C on a new branch `claude/brain-growth-onxj6h`.

## 1. State re-measured

| Thing | Value | How |
|---|---|---|
| `origin/main` | `5743177` (#933 handoff, docs only) <- `a753f56` (#930) | `git ls-remote` |
| live `osint-agent` | build `cb4c6a27`, 61 checks, **0 not ok**, `glm-5.2` pinned, `run_lease` LEGACY, `reveal_breach_data` true | `/health` |
| undeployed edge code | none: `git diff 185afd8 origin/main -- supabase/functions` is empty (`185afd8` = #923 stamp) | local diff |
| `deploy/live` / ledger | `cb4c6a27`; last ledger row `cb4c6a27`, mirror `a451ff2` | `ls-remote`, `deploy-log.jsonl` |
| mirror | edge tree equals canonical (only `mcp/` extra, expected). The two newer mirror commits are Lovable docs (`.lovable/plan/...deep-dive...md`) | `diff -rq` |
| frontend | Vercel production READY on `a753f56` (checked before #933 merged; #933 is docs only) | Vercel MCP |
| baselines | see §8 | |

## 2. Decisions this session (JD)

- **"Chinese replies were already fixed, it's not doing that anymore."** Cause not established: no edge code changed since the live build and `/health` has no `response_language` key, so it was not #929. Counts-only recurrence check in §4. **#929 stays a kill-switched draft; no deploy.**
- **Closed #738** (superseded by the shipped #831) **and #914** (describes a stamp that already landed as #923). No closing comments; this is the record. Only these two.
- "Do what's best" was read as covering docs, the read-only measurement and unblocked frontend work. It was **not** read as authority to deploy, change credential masking, or touch a secret/flag.
- Merged #933 (squash, pinned to head `c492574d`).

## 3. Finalize window — the 10-30 handoff §4.2 measurement

Source: `orchestrator_invocations` rows with `unfinished_steps IS NOT NULL` (the recorder writes it whenever timing is on) joined to `orchestrator_step_metrics`, bucketed with the same arithmetic as `reconcileTimeline` (`telemetry.ts:333`). SELECT only; metadata columns only (ms, enums, counts; never `input_json`, never message text). **32 timed runs, 2026-10-30 05:34Z to 2026-11-01 00:26Z.**

| Measure | Value |
|---|---|
| stop reasons | 10 `finalize_forced`, 21 `natural_stop`, 1 `stream_error` (57 ms, no steps) |
| duration | p50 125.8 s, p90 163.6 s, max 190.1 s; 1 run over 180 s |
| `unfinished_steps >= 1` | 0 of 32 |
| residual (`unattributedMs`) | 0 ms in 31 runs, -20 ms in 1 |
| first step offset | 48-135 ms |
| time between steps (whole run) | 0-733 ms |
| time after the last step (before persist) | at most 5 ms |
| runs where salvage ran | 16 of 32 (14 `ok`, 2 `error`) |
| `salvage_ms` (n=16) | p50 61.8 s, p90 89.3 s, range 36.5-90.1 s |
| `persist_ms` minus `salvage_ms` (n=16) | 1.7-8.4 s |
| `cluster_ms` | p50 2.1 s, range 0.5-7.6 s |

What this shows:

1. **The telemetry closes.** Residual ~0 on every run and no unfinished steps in completed runs, so the timeline is trustworthy for runs that reach `finish()`.
2. **Scheduling and per-step overhead are nil.** First step, gaps between steps and the tail after the last step total under a second per run. There is nothing to win by changing scheduling. (JD's 10-29 rule held: nothing was optimised before measuring.)
3. **The 10-29 "unattributed time" hypothesis is confirmed: it is report salvage.** Salvage is a second model call outside the step meter (`index.ts:2177`, `generateText`), and `persist_ms` is salvage plus 2-8 s of persistence and clustering.
4. **Salvage mostly follows `natural_stop`, not `finalize_forced`:** 13 of 21 natural stops vs 3 of 10 forced. `needsReportSalvage` (`orchestrator-finalize.ts:901`) returns true when the last assistant text has no report shape and the run did any work, so **`natural_stop` does not mean the model wrote a report**. Half of all runs spend 37-90 s regenerating one.
5. **Two run classes.** *Loop-bound:* 7 forced runs with no salvage, 106-175 s, all time inside steps, persist under 3 s. *Salvage-bound:* 16 runs with steps of 30-119 s plus salvage of 37-90 s, 86-190 s in total. The longest run (190.1 s) is 97 s of steps plus 92.7 s of persist.
6. **Two salvage failures landed at 90.1 s** (`salvage_ms` 90,121 and 90,104; outcome `error`). That looks like a ~90 s ceiling, **but I did not find its source in the code.** It is not `FINALIZE_RESERVE_MS = 90_000`, which is the loop's finalize window. Unconfirmed.

What it does **not** show:

- Runs killed before `finish()` leave no row (run `06175985`, CPU-limit death). This table is the survivors only; the real long tail is worse than it looks. That is #903's problem.
- Why the last text lacks report shape in so many natural stops. That is a prompt/termination question.
- Whether `record_artifacts` payload size matters inside step time. These columns cannot separate it; per-call durations in `tool_usage_log` could.
- A rate. 32 rows over about two days. Lovable's 14-day read (attributed, not re-run: 142 invocations, 79 forced, 58 natural, 18 over 180 s) covers a window starting 10-18 and is not comparable.

**Decision for JD, not a change.** The lever is the first-pass final message, not tools or scheduling. Anything that makes the model write a report-shaped final text is in the termination area (CLAUDE.md I-1/I-2, and the two `toolChoice` oscillations). So the next artifact is a short design note, **not code**. #903's four decisions (A-min vs A-full; drop `NOT NULL` on `finished_at`/`duration_ms`; measure first, now done; recovery stamp) are still open.

## 4. Chinese-output recurrence check (counts only, no message text read)

Assistant messages created since 2026-10-31 12:00Z with any CJK character (`[一-鿿]`), as share of the stored `parts` text:

| Thread | Created (UTC) | CJK chars / total | Share |
|---|---|---|---|
| `f8957d75` | 10-31 13:22 | 40 / 46,275 | 0.09% |
| `5663c718` | 10-31 13:14 | 256 / 86,476 | 0.30% |

- No CJK-bearing assistant message after 10-31 13:22Z. The window includes six runs started 11-01 00:09-00:26Z.
- Both hits are under 0.5% of a `parts` blob that includes tool output, which is consistent with quoted evidence values, not narration drift (inference; I did not read them).
- **I did not locate the original Chinese closing message** from the 12:46Z run (`5663c718`) with this filter. A Chinese report would carry thousands of CJK characters. Either it was replaced or regenerated, or it is stored differently. I did not read content to find out.
- Drift was a single observed incident (#929's data note: 1 CJK `agent_memory` row of 1,674), so a handful of clean runs is weak evidence. JD reports it fixed; that is the stronger signal.

## 5. Findings carried from the audit

1. **Cost meter** (Lovable's read-only deep dive, mirror `.lovable/plan/insight-finder-agent-cost-and-execution-deep-dive-read-only-2026-10-31.md`). Code claims verified in canonical: `index.ts` ~1903-1909 uses a flat `[0.3,1.2]` (primary) / `[0.3,2.5]` (fallback) µUSD per token whatever the model, with no cached-token bucket; `if (!inTok && !outTok) return;` drops steps with no usage silently; `clearRuntime(threadId)` (`index.ts:401`) resets per-request caps. No `usage-normalize` module exists, so its proposed Change 1 (usage normalisation plus a model-aware **shadow** estimate, log-only, debits unchanged, new `/health` key) is not built-and-unwired. The 89:1 input:output ratio is Lovable's, unverified. Best-evidenced next edge build.
2. **#926 vs #925:** #926's body says "deploy bundled with #925"; the 10-31 handoff says separate builds in order. One-behaviour-per-build says separate. #926 is fix + test only, so it has no new `/health` key; the moved build SHA is its only proof.
3. **#928 (M1 memory brief, +1674 lines) is inert today:** its own body reports 0 `agent_memory` rows with a `tool:` subject. Hold until a lesson exists and JD answers Q1-Q10.
4. **#882 is probably superseded by #915** (merged 10-30; its message cites #882's "Chat 3 / Workbench 2"). Needs a diff check; not closed.
5. **Frontend scan-QA defects, still unstarted** (10-30 handoff §4.3): (a) `PASSWORDS_LIST_RE` in `src/lib/report-export-gate.ts` masks neighbouring cells and deletes the Source cell, a provenance loss; credential masking is integrity-critical, so it needs JD's explicit sign-off; (b) a DNS failure on the target renders as a tool fault (`src/lib/tool-outcome.ts`; JD picks the label); (c) "93 artifacts" vs "95 collected" lacks an "N alias twins folded" note.
6. **Stale, not authorized to close:** #793, #804 (red CI), mirror #117. **Hold:** #516, #613, #593.

## 6. Board after this session

20 canonical PRs open plus this docs PR; mirror has 1 (#117). Unchanged since the 10-31 triage except: #738, #914 closed; #933 merged. 11 conflict with `main` (12 before #738 closed): #516 #593 #613 #701 #763 #793 #800 #804 #821 #882 #883. Edge PRs that merge clean: drafts #925 #926 #928 #929 #912 #799 #801, plus ready #868. (Per the 10-31 handoff's `git merge-tree` measurement; not re-run.)

## 7. Next steps (ranked)

**JD's priority (2026-11-01, after asking where the "new memories tab" went): the memory program goes first.** Only its Stage 1 has shipped: #927 / PR-F1 (merged 10-31 12:48Z, live) made every number on `/brain` name its population. The rest is in `docs/plans/2026-10-31-intelligence-memory-plan.md`: PR-F2 (lesson review UI) and PR-F3 (learning-loop pane) have no code and no PR, and `tool_lessons` exists nowhere in `src/` or `supabase/migrations`. #928 (M1 brief) is a draft and inert (0 `tool:` rows in `agent_memory`).

**The ordering below is my proposal and departs from the plan's §3 order; it needs JD's confirmation (plan Q2).** The plan puts #926, #925, #868 and the M1 deploy (PR-E4) ahead of schema. I put the observation clock first. Why: candidates need `invocation_id` on `tool_usage_log` rows (PR-E5) to count distinct invocations, so **nothing the review UI would show can exist until PR-E5 is live and data has accrued**. M1 (#928) does nothing until PR-E6 reads active lessons, so deploying it early spends an edge cycle for one `/health` key. The independent bug fixes (#926, #925, #868) are not prerequisites (plan §1.2), so they fill the unavoidable waiting window.

| # | PR | Channel | Who acts | What you can see afterwards |
|---|---|---|---|---|
| M1 | **Decisions:** confirm Q6 (`invocation_id` + `tool_lessons`; Q11 already approved the single-table shape), accept Q10 (exposure is lost for runs that die before `finish()` until #903 PR B), accept Q9's initial thresholds (5 attempts / 3 invocations / 2 threads / 60% / 14 d), and the order itself (Q2) | none | JD | nothing |
| M2 | **PR-S1** migration: `tool_usage_log.invocation_id` + the `tool_lessons` table + `.github/ci/assert-tool-lessons.sql` (§4.6). Additive. Do not bundle #613 lineage | schema | Claude writes, **JD applies and verifies first** | nothing yet |
| M3 | **PR-E5** stamp `invocation_id` on every new log row (§4.7; kill switch `OBSERVATION_IDENTITY_DISABLED`; `checks.observation_identity`). Touches `cache.ts` and `index.ts`, so full edge-deploy cycle, own build | edge | Claude, deploy on JD's go | `/health` key; the data clock starts |
| M4 | **Waiting window, edge slots reused:** #926 -> #925 -> #868, then PR-E4 (#928 hardening, re-read U1 right before deploy) | edge, one build each | Claude, JD's go each | the fixes; M1 brief present but inert |
| M5 | **PR-S1b** aggregator in **dry-run**; JD reads what candidates it *would* create from real data | schema | Claude writes, JD applies | the first real list of would-be lessons |
| M6 | **PR-F2** review UI (frontend; can be built against fixtures right after M2 and ships on merge, showing an empty state until M5 produces candidates) | frontend | Claude | **the new Memories/learning queue: approve / reject / revoke** |
| M7 | **PR-E6** M1 reads active lessons, then PR-S2 -> PR-E8 (attribution; Q8) -> **PR-F3** learning-loop pane | edge/schema/frontend | JD's go each | lessons reach runs; exposure and outcomes visible |

Not promised: dates. The review UI shows nothing real until M3 has been live long enough for a key to meet the thresholds. Lessons only change which tool is tried; they are never a source or corroboration (#721, #928).

Everything after this line is the earlier ranking, now behind the memory program, except items that run on other channels in parallel (frontend scan-QA, read-only reviews).

1. **JD: answer #903's four decisions** and say whether the salvage finding warrants a termination design note (§3). No code before that.
1a. **Read-only / offline, no go needed (from Lovable's audit, §9):** review #912 against current `main` (the evidence-row to artifact link; trace insert -> per-item linkage -> report/export, duplicate values across sources, partial insert failure, analyst rejection, unchanged hashes and authority), and write a **failing offline test** for the checkpoint marker (`index.ts:594` advances before the RPC result; a mocked failure then finalization must keep the exact unpaid delta; do not blind-retry a non-idempotent increment). Any fix PR is edge, its own build, and needs JD's go.
2. **Frontend scan-QA PRs**, one each, frontend only, ready not draft: alias-twin label first; the redaction fix built with tests and **left draft until JD signs off**; the DNS label after JD picks wording. Needs its own branch per PR. `npm run test:e2e` by hand before merging anything under `src/`.
3. **Next edge build, on JD's go, one build each:** usage-meter shadow log (new) before #926 -> #925 -> #868. #929 only if Chinese output recurs. #928 held.
4. **Board hygiene, JD decides each:** #793, #804, #882, mirror #117.

Standing decisions unchanged: GLM-5.2 primary / Anthropic backup; `RUN_LEASE_DISABLED=true`; `REVEAL_BREACH_DATA` on; `MAX_PAID_CALLS` bounded; no deploy, merge or close without JD's named go.

## 8. Baselines

| Suite | Result | Where measured |
|---|---|---|
| frontend `npx vitest run` | **3037 passed / 1 skipped / 256 files** | local, `main` `5743177`, 2026-11-01 |
| edge `deno test` | **2828 passed / 0 failed / 6 ignored** | CI push run 41207567752 (`Edge functions (deno test)`), `main` `a753f56`; `5743177` adds only a docs file. No Deno in this sandbox, so CI is the instrument. |
| `npm run test:e2e` | **102 passed** | same CI run (`Workspace e2e`). The log tail I read carries only the passed line; the 13 skipped is attributed to the 10-31 handoff and not re-read. |

The earlier figures (edge 2821, vitest 2965/247, e2e 95/13 on `6596812`) are stale. The older dated figures further down CLAUDE.md's edge/frontend/e2e bullets are historical and keep their own dates.

## 9. Cross-check of Lovable's own 2026-11-01 audit

Lovable (mirror side) wrote an independent read-only audit at ~00:39-00:42Z and JD forwarded it. It is an input, not evidence. Source claims were re-read in canonical code; its database figures were **not** re-run by me.

**Confirmed against canonical code**

| Lovable claim | What I read | Result |
|---|---|---|
| `index.ts:586-603`: checkpoint marker advances before the RPC reports success | `lastCheckpointMicroUsd = runCostMicroUsd` at `:594`; the `increment_thread_cost` RPC at `:599`; failure only `console.warn`s (`:601-602`). The final write (`:2389`) is inside `if (assistant)` (`:2381`) and uses the already-advanced marker, so a failed checkpoint delta is never recovered. The code comment at `:2385-2387` accepts under-counting. | Mechanism CONFIRMED. Impact is a HYPOTHESIS until a failed-RPC test runs. |
| Same area: do not blindly retry | `increment_thread_cost` is an additive RPC, so a retry after a lost response would double count | CONFIRMED by reading; agreed. |
| Planner menu includes Hunter, omits Opsis/FOFA | `baseToolList` (`tool-registry.ts:1150-1207`) has `hunter_*`, no `opsis_*`/`fofa_search` | CONFIRMED. It only shapes the `minimax_plan_pivots` helper's suggestions; the main orchestrator sees the full registry (Opsis was called 3 times in Lovable's sample). Whether the omission is deliberate for paid tools is UNKNOWN. |
| A plain `/health` is not side-effect-free | `health-handler.ts:408-411` calls `checkDeepseek()` and `checkMinimax()` on every request; `checkDeepseek` POSTs a 4-token `chat/completions` ping (`:193-206`); MiniMax is skipped only if healthy within 60 s | CONFIRMED. **I made 2 such calls this session.** Cost is negligible (the browser already fires one per open case every 30 s), but "read-only" was loose wording. CLAUDE.md now says so. |
| 97/97 new evidence rows have no `artifact_id` | #910's commit message measured 17,575/17,575 on 10-30, so this is the same known gap | Consistent. #912 is the fix; I have not reviewed it. |

**Independent agreement:** the 00:24 persist of 55.559 s including 53.769 s of salvage is the same row as my `92832117`. The 20 open PRs match my count before #934 opened. Main `5743177`, marker `cb4c6a27` and mirror HEAD `4169da6` match.

**One nuance it blurs.** The checkpoint defect affects `threads.cost_micro_usd` only. The user's credit debit (`debit_user_credits`, `index.ts:571-584`) runs inside `onCost` on every call, independent of the checkpoint, so a failed checkpoint does not change what a user is debited.

**Not verified by me:** its memory-supersession findings (`lib/memory-supersession.ts`, `lib/cross-case-reviews.ts`), every database figure (8-invocation baseline, Opsis $0.90, tool failure classes, token and cost totals), and the claim that Hunter was never selected.

**Where it differs from this handoff.** It ranks "review #912, then reproduce the checkpoint defect offline" first; I ranked the finalize-window measurement and docs first. These do not conflict: both are read-only/offline and both precede any edge deploy. It lists #929 as a candidate; JD has since said the Chinese output is fixed. It did not have the salvage finding in §3, which bears on its "closeout variability" point: the variability is salvage (16 of 32 runs), not persistence.

## 10. Opening prompt for the next session (SUPERSEDED by section 0 above)

> Read `CLAUDE.md`, `SESSION_HANDOFF_2026-10-31_pr-board-triage.md` and `SESSION_HANDOFF_2026-11-01_audit.md`. Re-measure first: one `/health` read (build should still be `cb4c6a27`), `git ls-remote origin refs/heads/main refs/heads/deploy/live`, and `list_pull_requests` (look at `draft`). **Do not deploy, run DDL, change flags or secrets, close a PR, or touch credential masking without JD's explicit go.** Then do the step JD names from §7 of the audit handoff.
