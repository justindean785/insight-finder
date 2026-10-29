# Session handoff — queue merge, the wall-clock finalize measurement, and the three denominators (2026-10-29)

> Every number here is a dated measurement (2026-10-29, ~11:50–12:40 UTC, desktop + cloud session, JD present).
> Re-measure before relying on it. Session had zero compactions; it ends by JD's call at a clean spot.

## 1. State at hand-off

| Thing | Value |
|---|---|
| canonical `main` | `7db6614e` (#886) — after #884 `7d970d3e`, #885 `238ff262` merged this session; #880 and #891 not yet merged |
| live `osint-agent` (`/health`) | `f9eaaaa` (#831) — unchanged this session; 60 checks, 0 not ok |
| `deploy/live` | `f9eaaaa` |
| Vercel production | ships on merge; carries #884/#885/#886 |
| frontend baseline | **2947 passed / 1 skipped / 246 files** (`npx vitest run` on `fix/evidence-scope-labels` = main + #891) |
| edge baseline | **2786 passed / 0 failed / 6 ignored** (`npm run test:edge` on `238ff262` + #890) |
| e2e baseline | **95 passed / 13 skipped** (`npm run test:e2e`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, on #891's head). CLAUDE.md's 77/4 is stale. |
| open PRs | 20 (was 23). See §3. |

## 2. What happened, in order

1. **#885 (SEC-05 markdown-image exfil)** — reviewed; pushed hardening `3d8e3cd` (blocked-image disclosure shows raw target + title; CSP test asserts the exact `img-src` list). Merged `238ff262`. Follow-up not built: `[text](url)` links are the one-click half of SEC-05.
2. **#884 (e2e stale harness)** — reviewed; pushed `0e8b600` restoring `!process.env.CI &&` on `reuseExistingServer`. Merged `7d970d3e`. It also proves the "#875/#876 fail on main" claim in the 10-26 handoff was a stale server from another worktree.
3. **#886 (pivot Running/Completed strip)** — reviewed, three correctness defects fixed and pushed `df69158`: completion scoped to the pivot's own window via timestamped `useThreadQueriedCalls` (`useThreadQueriedTargets` now derives from it, one subscription); `pivotRunKey` folds artifact kinds through `KIND_TO_PIVOT` so a Recheck matches its card; `onError` withdraws a refused send's card. Merged `7db6614e`. **Not done:** the 1000-row-capped anchor (`useThreadArtifacts` initial limit) and the sheet→Evidence handoff bundled in the same PR; fix 3 has no unit test that fakes a 409 (covered by typecheck + suite only).
4. **Lovable "digest + coercion" prompt → Grok checklist → JD's stop.** Audited against `origin/main`: the digest is already built (`summarizeToolResultValue` + `capTotalToBudget`, 220k ceiling, `prompt_size_step` measured per step); `socialfetch_lookup` coercion is live (`checks.socialfetch_coercion`); auto-setting `allowMissingFirstName` contradicts #848 (`checks.indicia_person_opt_in`, `NEVER_REPAIR`). **JD's decisions:** no case-digest rewrite, no `indicia_person` change, no `allowMissingFirstName` auto-set, do not raise `FINALIZE_RESERVE_MS` / `MAX_ORCHESTRATOR_STEPS` / `TOTAL_PROMPT_CHAR_BUDGET`, do not wire `failedQueryFamilies`. Only §4 was approved →
5. **#890 (edge, draft→ready, green)** `fix/rapidapi-email-angle-brackets` @ `549bfef`: one enclosing `<…>` layer stripped on the `email` trim field only, around an `@`-bearing value; `a<b@c.com`, lone `<`, unmatched/doubled, `<not-an-email>` stay rejected; `name`/`query`/`handle` untouched. Coercion code `angle_unwrapped`; `checks.input_coercion` detail names it. Plus a test-only pin that `socialfetch_lookup` rejects `{query, platform}` (`lib/socialfetch-input.ts` unchanged). RED first (2 fails on `invalid_string`), then 48/48 + 16/16, full edge 2786/0/6. **JD must click merge** — the auto-mode classifier refuses a merge of a PR I authored ("merge without review"), twice. Then the `edge-deploy` cycle is a separate go.
6. **The forced-finalize measurement (decisive).** `orchestrator_invocations` ⋈ `orchestrator_step_metrics`, last 12 invocations (5 days): every `finalize_forced` run had **max per-step context 46k–95k chars** (budget 220k) and **7–11 steps** (cap 22); the largest contexts in the set (137k/step, 300k raw final) stopped *naturally*. `sum_step_wall_ms ≈ duration_ms` in every forced run (e.g. 130.4 s of 132.6 s). Mechanism: `orchestrator-finalize.ts:43` `FINALIZE_RESERVE_MS = 90_000`; the window opens at `ORCHESTRATOR_WALL_CLOCK_MS − 90 s = 90 s` (comment at `:397`). **The investigation phase of every run is 90 seconds.** JD's @port162 scan: 23 calls in 130 s, max step ctx 46,235. Lever = scheduling (don't start a slow tool that can't be collected before the reserve; run the per-platform username checks in parallel, not as a tail) — a scoped edge PR, not a constant change. Do not relitigate "digest".
7. **The @port162 scan (live production, 12:05 UTC)** surfaced four product findings — §4.
8. **PR triage of all open PRs** — §3. Then #880 (docs) read: accurate dated measurement; **merge blocked by classifier, JD to click**.
9. **#891 (PR A, frontend)** `fix/evidence-scope-labels`: Sheet "N items" → "N artifacts" with the population in its title; both unadjudicated-report notices read "Model-adjudicated findings this run: 0 — the model did not call `record_finding` … case-artifact authority was still computed" (F-1). Header already labelled (`describeEvidence`). Pinned in `src/test/evidence-scope-labels.test.tsx`. Full vitest 2947/1, e2e 95/13. Marked ready; CI was still running at hand-off.
10. **#881 (JD's, report registrations)** — reviewed; one real defect: rejection keyed by row id with dedupe after the filter, so an unreviewed duplicate of a dismissed `site|identifier` rendered clean. Fixed on its branch (`origin/main` merged in first, `cf0d517`; fix `8c8d4aa`): two-pass gate keyed on the table's own identity, null-result parity in `buildBreachExposure`, `lessons.md` ordering. RED 3 fails → 26/26, 82/82 case-report tests. Full vitest + e2e were running at hand-off — **push `8c8d4aa` only if both are green** (see §6 first step).

## 3. The queue (20 open) — triage verdicts (read-only pass, this session)

| PR | Channel | Verdict | Note |
|---|---|---|---|
| #891 | frontend | **mine, ready** | PR A. Merge when CI green. |
| #890 | edge | **ready, JD click** | next edge build after merge. |
| #881 | frontend | **fix pushed → merge** | after push + CI. |
| #880 | docs | **JD click** | conflicts with any later CLAUDE.md edit (this handoff's docs PR edits CLAUDE.md — merge #880 first, then rebase the docs PR, or accept a one-line conflict). |
| #883 | frontend | NEEDS-REVIEW | score popover: recorded score/cap only; body says "review only". A-adjacent. |
| #882 | frontend | NEEDS-REBASE | one case-scoped pivot queue; shares `ChatWindow`, `WorkbenchNext`, `useThreadQueriedTargets` (rewritten by #886). "Review only". |
| #873 → #874 | frontend | NEEDS-REVIEW, stacked | `useThreadPivotAttempts` is the per-(selector, tool) attempts record — **extend it for C, do not add a second one.** Rebase after #886. |
| #868 | edge | MERGE-READY | 2 files; 2nd edge build. |
| #799 | edge | MERGE-READY | 4 files; 3rd edge build. |
| #821 | edge | NEEDS-REBASE | 3 builds behind. |
| #800 | edge | NEEDS-REBASE | bumps `tool-cache-version.ts`. |
| #801 | edge | NEEDS-REVIEW | 916 lines, spend policy. |
| #763, #701 | edge | NEEDS-REBASE + test relocation | tests still at function top level (pre-#597 layout; `edge-deploy-bundle.test` would fail). |
| #613 | schema | HOLD | schema first, JD-applied. |
| #593 | frontend | NEEDS-REBASE (dirty, 23 files) | dedupe never transfers authority — still the correct fix shape; own session. |
| #516 | frontend | NEEDS-REBASE | account deletion, dark. |
| #793 | docs | NEEDS-REBASE | mostly superseded. |
| #738 | edge | CLOSE-CANDIDATE | superseded by merged #831. |
| #772, #804 | frontend | CLOSE-CANDIDATE | superseded by Stage 1; #804 CI red. |

Close candidates are JD's call only; none were closed.

## 4. Findings from the @port162 scan, and what is built vs not

| # | Finding | Status |
|---|---|---|
| 1 | Forced finalize on a 23-call username case | **Measured** (§2.6). Wall-clock. Scheduling PR is the lever. |
| 2 | Findings Table is prose: single-source `75 [CONFIRMED]`, "3 independent corpora clean" for a null result; `record_finding` never called | Known (CLAUDE.md "report layer bypasses the integrity engine"). Fix shape unchanged: server-side `{{FINDINGS_TABLE}}` from persisted rows; it would render an empty table here, which is the truth. |
| 3 | Header 17 / Sheet 14 / Report 15 on one screen | **Not a bug in the counts.** 17 = `evidence_log` custody rows (`pickEvidenceCount`), 14 = deduped artifacts (`buildCaseSheet` over `useThreadArtifacts` after `dedupeArtifacts`), 15 = raw rows (`lib/evidence-record.ts:285`, edge). Labels shipped in #891; the edge footer's "15 artifacts" wording is still edge-authored. |
| 4 | "NO BREACH HITS" / "NO STEALER LOG HITS" rows listed as Connections "unlinked candidates" and counted as evidence | **Not built. Ground truth read from production:** both rows are `kind=breach_exposure`, `source=breach_check` / `oathnet_stealer_search`, `confidence=60`, with `breach_check_result="0 hits"` and `serus_darkweb_result="0 hits, 0 breaches, 0 pastes"` as **strings**. `isNegativeResultArtifact` (`intel.ts:490`) needs numeric counters, a 4xx or a `lookup_status`, so it returns **false** for these rows; `isNullResultValue(value, source)` (`report-hygiene.ts`, the value-regex twin #881 uses) matches them. These are **model-authored via `record_artifacts`** and slip past `isZeroHitBreachRow` (`lib/breach-exposure-guard.ts:69-82`, wants "found" or a digit). |
| 5 | Next panel: 3 of the agent's 6 recommended pivots read "Suggestion needs repair" | Modelling gap: pivot identity is selector-only; `port162` is already queried, so Steam/NameMC/socialfetch-on-`port162` cannot be expressed. Hook: #873's `useThreadPivotAttempts`. Design call for JD before UI work: pivot identity = `selector` or `(selector, tool)`. |
| 6 | `username_sweep` accepted `giphy.com/port162` (search page) as a profile | Tool quality; the agent caught it; the URL still persisted as a `url` artifact. |

### B1 / B2 design (ready to build, not started)

- **B1 frontend (small):** in `src/lib/workbench-connections.ts` `connectionsView`, exclude from `isolated` any node whose `art` is a clean check — predicate `isNegativeResultArtifact(a) || isNullResultValue(a.value, a.source)` — and return `cleanChecks: number`; render "N clean checks (coverage, not candidates)" in `WorkbenchConnections.tsx` beside the `seedRecords` line (`:105-106`), and drop them from the `:96` "unlinked candidates" count. Consider the same predicate in `buildEntityGraph` node construction (`entity-graph.ts:274+`) only if the Graph tab should hide them too — JD's call; the Connections list is the clear case. Tests: `src/test/workbench.test.tsx` (Connections section), a new `connections-clean-checks.test.ts` with the fixture pattern from `entity-graph-seed-record.test.ts`. Rows stay in the table and the Evidence tab — quarantine is disclosure, not deletion.
- **B2 edge (one regex, own PR, own build):** extend `ZERO_HIT_VALUE` in `lib/breach-exposure-guard.ts` with `\bno\s+(?:breach|stealer(?:\s+log)?)\s+hits?\b` so the write guard refuses these shapes as `zero_hit_result`; pin in `supabase/tests/osint-agent/breach_exposure_guard_test.ts` (or wherever its tests live — grep). Proof key: extend the existing guard's `/health` detail.

## 5. Decisions made this session (JD)

- Edge: only the angle-bracket strip; the digest rewrite, indicia changes and `failedQueryFamilies` are refused; budget constants untouched.
- Merges: JD authorised merging green PRs; the auto-mode classifier still refuses merges of PRs this session authored. Three merged (#884, #885, #886); #880, #890 need JD's click (or a `.claude/settings.json` Bash allow rule for `gh api -X PUT …/pulls/*/merge`).
- Protected decisions unchanged: GLM-5.2 primary / Anthropic backup; `REVEAL_BREACH_DATA` ON; run lease OFF; `MAX_PAID_CALLS` bounded; no secret/flag changes; one edge PR per build; never close a PR without JD.

## 6. Subscriptions and check-ins to cancel or re-arm

- PR subscriptions held by THIS session: #890, #891 (and #881 is not subscribed). A new session must `subscribe_pr_activity` again for whatever it drives.
- `send_later` safety-net for #890: `trig_01B3SLDgfhxSwTta4Jqg3oyj`, fires 2026-10-29T12:57Z. **Delete it** (`delete_trigger`) from the new session, or let it fire harmlessly into this archived one.
- Local branches in the cloud checkout (all pushed except as noted): `fix/sec05-markdown-image-exfil`, `fix/e2e-stale-harness-server`, `feat/pivot-loop`, `fix/rapidapi-email-angle-brackets`, `fix/evidence-scope-labels`, `repair/report-subject-registrations` (**`8c8d4aa` push pending suites**).

## 7. The next three (ranked)

1. **Land the green queue.** JD clicks #880 and #890. Merge #891 and #881 when CI is green. Then `edge-deploy` for #890 (`.claude/skills/edge-deploy/SKILL.md`): proof is `/health` build moved off `f9eaaaa` and `checks.input_coercion.detail` naming `<…>`. Next edge builds after it: #868 → #799.
2. **B1** (frontend, small, designed in §4) then **B2** (edge, one regex) — clean checks are coverage, not candidates.
3. **Scheduling PR for the 90-second window** (edge): measure first which tools ran serially in the five forced runs (`orchestrator_step_metrics.tool_names` per step); then a bounded change — don't start a slow tool when `elapsed + its p50 > 90 s`, and parallelise the username-platform fan-out. No constant changes. Then the pivot-identity design call (§4.5) before any more pivot UI.

## 8. Opening prompt for the next session

> Read `CLAUDE.md` and `SESSION_HANDOFF_2026-10-29_queue-merge-wall-clock-and-the-three-denominators.md`. Re-measure first: `git ls-remote origin refs/heads/main refs/heads/deploy/live`, `gh api "repos/justindean785/insight-finder/pulls?state=open&per_page=50"`, one `/health` read (build must be `f9eaaaa` until #890 ships). Delete trigger `trig_01B3SLDgfhxSwTta4Jqg3oyj` if it is still pending. Confirm `8c8d4aa` is on `origin/repair/report-subject-registrations` (push it after a green `npx vitest run` + `npm run test:e2e` if not). Then work §7 item 1: merge #891 and #881 when green; after JD clicks #890, run the `edge-deploy` skill for it. Do not deploy, change flags or secrets, close a PR, or touch `FINALIZE_RESERVE_MS` / the digest without JD's explicit go.
