# tasks/todo.md — remediation workstream (audit 2026-10-10)

## Production audit 2026-11-13 — remediation (approved by JD 2026-11-13)

Source: the 2026-11-13 production audit and its deeper-trace addendum (kept outside the repo; they
describe a real case). Five stages, evidence integrity first. One PR per behaviour change; frontend,
edge and schema ship separately.

Baseline re-measured 2026-11-13 (not taken from the audit): `origin/main` `a913e0a`, CI on it
success, production deployment 7716608593 on the same SHA. Edge runtime and database were NOT probed.

- [x] Refresh main, production deployment and open-PR status
- [x] Review #882 and #1027 for overlap. #882 is a conflicting draft (last push 2026-10-26) touching
      pivot-queue files only; it matters for stage 3, not stage 1. #1027 touches `CaseSheet` and
      `assessment-sheet` only. Neither touches `CaseReport`'s subject picker.
- [x] Reproduce A01 through the real `CaseReport` with synthetic data
- [x] Stage 1, PR 1 (frontend) — A01, contact fields only: Email / Phone / Address in the Subject
      Profile require positive subject linkage. Branch `claude/insight-finder-audit-fixes-ef66dc`.
  - rule: `profileOwnership` in `src/lib/subject-linkage.ts`. In order: no assessment or
    `group === "quarantined"` → unresolved; `isSeed` → subject; `linkedToSeed` with a non-null
    `subjectLinkage >= SUPPORTED_LINKAGE_MIN` → subject; everything else → unresolved. It reads the
    existing agent assessment (`assessArtifacts`); it adds no linkage rule, and reads neither the
    review verdict nor the artifact's confidence.
  - surface: `buildSubjectProfile` in `src/components/panel/CaseReport.tsx`. An asserted field says
    its basis ("Supplied as the case seed" / "Linked to the subject · ownership not independently
    verified"). Contacts that fail the rule are listed apart under "Other contacts in this case ·
    ownership unresolved", capped at 8 with the remainder counted.
  - tests: `src/test/subject-linkage.test.ts` (12), `src/test/case-report-subject-profile-linkage.test.tsx` (10)
- [x] Stage 1, PR 2 (frontend) — A01, the subject's **Name**, on every surface that prints it.
      Branch `claude/insight-finder-evidence-name-12a354`. Rule v2, approved by JD 2026-11-13 after a
      replay review showed v1 (profile only) would blank typed names and leave the Identity panel,
      the case sheet and Connections naming strangers.
  - rule: `readSubjectName` in `src/lib/subject-linkage.ts`, read through `pickSubjectName`. A name
    is the subject's when the typed seed names it (whole seed, or every word of a two-word-plus name
    is a whole word of the typed seed; filenames never count) or when exactly one distinct name is
    the subject's by `profileOwnership`. A claim in the assessment's `conflict` group is never
    asserted and counts as a linked name (decision B). A released row with no seed link is unresolved
    (decision A). When the seed names a person only that name may be asserted. DOB / Age only from a
    row a shared selector joins to the seed.
  - surfaces: Subject Profile, Identity panel "Real name", the "No established subject name" notice,
    the rail's case sheet, Workbench Connections. Unasserted names stay listed in the profile by
    standing; with candidates and no name the field reads "Not established".
  - tests: `case-report-subject-profile-name.test.tsx` (39), `subject-linkage.test.ts` (17); seven
    older files that pinned "any unquarantined name is the subject" were re-anchored on a name the
    seed names or the evidence links; three e2e tests on a new harness scenario `names`.
- [ ] Stage 2 (frontend) — multiple-seed parsing. `seedForms` in `agent-assessment.ts` matches only
      the whole seed string, so a two-email seed recognises neither email as the seed.
- [ ] Stage 3 (frontend, then edge/schema only if needed) — shared pivot-history state for chat and
      rail, explicit loading/failed reads, completion tied to the invocation. Review #882 first.
- [ ] Stage 4 (frontend) — one definition each for corroboration, analyst confirmation, source
      independence and count scope (A02/A03/A06/A07). Do not collapse the three source metrics.
- [ ] Stage 5 (edge, then frontend) — shared-hosting attribution restriction on derived artifacts,
      selector-kind validation, compact pivot outcome.

### Results (PR 1, measured 2026-11-13 in this worktree with its own `npm ci`)

- typecheck (`npm run typecheck`): pass
- lint: 0 errors, 8 warnings; the same 8 as before the change (3 in `CaseReport.tsx` are the
  existing react-refresh warnings on exported helpers, shifted two lines by the new imports)
- vitest, full frontend: 295 files, 3462 passed, 1 skipped, 0 failed
- `npm run build`: pass; no `harness.local` in `dist/`
- `npm run test:e2e`: 128 passed, 12 skipped, 0 failed (same as the run before the fix)
- no baseline failures were observed in any gate

- reproduction: on unmodified `a913e0a`, 4 of the first 5 assertions failed (associate email,
  address and phone all printed as the subject's)
- mutation check: removing quarantine precedence, the threshold, or the seed-link requirement each
  fails at least one test
- browser (harness, 1024×768, Report tab, read from the DOM): seed email carries the seed note, the
  record-joined phone carries the linked note, 8 unlinked contacts sit under "ownership unresolved"

### Known limits (measured, not assumed)

- **Composite seeds.** On a case whose seed holds two emails (the audited live case), no row is
  recognised as the seed until stage 2, so every contact reads "ownership unresolved". That is
  honest, but the profile is emptier there than it will be after stage 2.
- **Name field.** Unchanged, see above.
- **60 is a rung, not a probability.** `SUPPORTED_LINKAGE_MIN` is the app's "supported" threshold.
  A record-joined contact scores exactly 60 today; any change to cluster scoring moves this surface.
- **Other subject surfaces** (aliases, digital footprint, breach count, risk) still use the negative
  gate only. Not examined for A01-shaped errors in this change.
- **Exports.** The markdown/PDF export path was not inspected; this change covers the Report tab.
- NOT verified: the live case, production data, mobile layout of the new block, export contents.
  (Superseded in part by the review below.)

### Results (PR 2, measured 2026-11-13 on `c2bc34d`, same worktree)

- typecheck: pass. lint: 0 errors, 8 warnings, the same 8 as `main`
- vitest, full frontend: 296 files, 3514 passed, 1 skipped, 0 failed (`main` c8bc4ee: 295 / 3468)
- build: pass; no `harness.local` in `dist/`
- e2e: 130 passed, 12 skipped, 1 failed. The failure is `stage1b-wcag` "quarantined row selected";
  the same spec on unmodified `c8bc4ee`, same machine: 13 passed, 2 failed (both viewports). An
  earlier run of this branch failed it at both viewports too. Timing, not this change.
- reproduction: 16 of the first 20 Name tests failed on unmodified `c8bc4ee`
- mutation: 30 single-clause mutations (rule, pool gates, seed matcher, cross-surface wiring,
  display), 30 caught, 0 survived
- screenshots: `docs/pr-subject-name-screens/`, before and after at 1440x900 and 390x844 on the
  `names` scenario; horizontal overflow 0 px in all four

### Known limits after PR 2 (measured or read in code, 2026-11-13)

- **The Name will usually read "Not established".** Names never join a cluster by name, only through
  a record that carries a seed selector. A replay JD forwarded put it at 41 of 43 recent cases under
  v1; not re-measured here. The backend change that would fill the field (persisting which details
  share a source record) is edge plus schema and needs JD's go.
- **Decision B has no writer.** Only `metadata.conflict === true` (or a `*_conflict` kind) puts a row
  in the `conflict` group. Nothing in the server or the product writes that flag on a name row, and no
  analyst action clears one. The server's own dispute markers do not move the group.
- **Decisions A and B hold on the frontend only.** The edge's findings table and next-pivot brief
  treat a released row as restored and never read the conflict flag.
- **"Confirm linkage to subject"** is the release control's wording; decision A says a release does
  not establish that. Copy only, not changed here.
- **Other subject surfaces keep the negative gate:** the Identity panel's DOB / age / phone / region /
  email rows, "Analyst confidence", the Hunter's Note and risk triad, the markdown export.
- **Contact fields** (Email / Phone / Address) do not apply decision B yet.
- **Name spellings.** "Sam Example" and "Samuel Example" are two names; neither is asserted.
- **Name seeds.** A row is the seed when its text equals the seed, so a namesake's record can be the
  asserted row. Its DOB is withheld; its name is the seed's own. The seed cluster is the first
  seed-equal row's cluster.
- **Connections** opens with nothing selected when no name is established (before: it opened the
  strongest name). Left for the graph redesign.
- **Upstream dedupe** (`useThreadArtifacts`) still merges same-value rows with later metadata winning
  (#593, open). The report tests bypass the hook.
- NOT verified: the live app, production data, the PDF print, the markdown export's contents.

### Review of PR #1028 (2026-11-13, requested by JD; reviewer is also the author)

State: `origin/main` `a913e0a` = merge base; PR head was `53f143b`, mergeable, no review decision.
No other open PR touches the profile code except #593 (conflicting draft, dedupe authority).

- [x] Wider reproduction through the real `CaseReport`, run on `a913e0a` and on `53f143b`
      (16 synthetic scenarios plus four arrival orders; probe not committed)
- [x] Audit of the diff against the existing gates
- [x] Fixes for what the review found in this PR's own code (second commit, see below)
- [x] Cross-surface read: rail, markdown export, print/PDF
- [x] Gates re-run on the second commit; browser at 1440×900 and 390×844
- [ ] JD's ruling on the two rule questions below

Baseline (`a913e0a`) in the wider probe: an unrelated phone, a similar-domain email, a
"no breach hits" row, a "no results found" row and a rejected-derived phone were each printed as the
subject's Email or Phone. Email and Phone also changed with arrival order.

Found in `53f143b` and fixed in the second commit (all inside `buildSubjectProfile`):
- a "no results found" row was listed as an unresolved *contact* → pool applies `isNullResultValue`
- a contact derived from an analyst-rejected selector was asserted when it also joined the seed →
  pool applies `rejectedDerivedIds`; such a row is in neither list, like a rejected row
- a linked email with a higher score displaced the seed email → seed ranks first
- two linked contacts on equal confidence were picked by arrival order → value is the tie-break
- `topByConfidence` is back to its `main` signature; the Name path is byte-for-byte untouched
- `subject-linkage.ts`: rule unchanged; the comment no longer claims a release reaches ownership
- 6 tests added (16 in the component file); each new gate fails exactly one test when removed

Open, needs JD's ruling (both change the rule JD dictated, so neither was changed):
- **Released quarantine.** A row released with "Confirm linkage to subject" (`linkage_confirmed`)
  that has no cluster link to the seed reads "ownership unresolved". Raised by Devin Review;
  reproduced. Pinned by a test named as current behaviour.
- **Conflict flag.** A row with `metadata.conflict === true` that joins the seed is asserted as
  "Linked to the subject". The rule excludes only `quarantined`. No frontend or edge code writes
  that flag on a contact row (only the dev mock, on location/contradiction rows); whether production
  rows carry it was not measured.

Not blockers, unchanged from `main`:
- **Name field.** `topByConfidence(["name","person"])`: an unrelated same-kind row can be the
  profile's Name (labelled "Candidate — needs review"), and a tie is settled by arrival order.
- **Composite seed.** Reproduced: with a two-email seed, both emails read unresolved and no Email
  is asserted.
- Two different people's records that both carry the seed email put both phones in the seed
  cluster; one is shown as linked, the other is in Evidence only.

Gates on `efacd2f` (the second commit), with wall time:
- `npm run typecheck`: pass (11 s)
- `npm run lint`: 0 errors, 8 warnings, the same 8 as `main` (8 s)
- `npx vitest run`: 295 files, 3468 passed, 1 skipped, 0 failed (55 s)
- `npm run build`: pass, no `harness.local` in `dist/` (6 s)
- `npm run test:e2e`: 128 passed, 12 skipped, 0 failed (152 s). PR CI skips this job.
- browser, harness Report tab: 1440×900 and 390×844 after a reload, block inside the viewport, no
  horizontal scroll; a 162-character selector wraps inside the block at 390 px. Screenshots taken
  at both sizes, not committed. A resize without a reload gave a false 86 px reading.

Cross-surface:
- rail: reads the same `assessArtifacts`; in the harness it reports 1 linked finding and the profile
  asserts the same 1 phone
- markdown export (`buildReportMarkdown`): names the subject by the seed selector only; no profile
  contact fields found by grep, so no contradiction of this kind. Read by grep, not by running an export.
- print/PDF: prints `CaseReport` as displayed, so it carries the fix
- Evidence ledger, inspector, Graph, Overview: not compared row by row

---

## Adaptive evidence workflow — Stage 1 (approved 2026-10-25)

Base: `origin/main` `70766fce`. PR #872 (Table inspector) is untouched and still Request Changes.

- [x] Capability map of correlation, pivot, synthesis, feedback and confidence code (discovery)
- [x] JD approval of Stage 1 and the integrity decisions, as proposed (2026-10-25)
- [x] Stage 1 — explained adaptive ranking, read-only. Commit `266894ce` on `claude/adaptive-pivot-explain-stage1`
  - prior attempts from `tool_usage_log` (SELECT-only, thread-scoped): `src/hooks/useThreadPivotAttempts.ts`, `src/lib/pivot-attempts.ts`
  - explanation (question, previous attempts, cost = unknown, factors): `src/lib/pivot-rationale.ts`, shown in `NextSteps` best-pivot card
  - ranking terms (priority only): repeated same-tool lead −60 among searched leads; source row in `conflict` +150 for a new lead
  - tests: `src/test/pivot-adaptive-stage1.test.ts` (9)
- [x] Integrity decision 1 — every pivot opens its review before it can run. Commit `e61e7079` on `claude/pivot-preview-before-run` (stacked on Stage 1)
- [ ] Integrity decisions 2–7 are constraints or later stages: pivot priority never changes confidence or authority (held in Stage 1); correlation calls count toward the paid cap plus a per-case counter (Stage 2/3); yield baselines shown as display only; dismissals stay case-scoped; lineage (#613) before Stage 2
- [ ] Stage 2 — persisted AI correlation assessments with evidence IDs and versions (edge + schema, separate PRs, after lineage)
- [ ] Stage 3 — bounded, analyst-triggered AI reconciliation, separately accounted
- [ ] Stage 4 — analyst feedback as calibration inputs; estimated scores labelled as such

### Results (Stage 1 on `e61e7079`, measured 2026-10-25 in this worktree)

- typecheck: pass
- eslint on changed files: 0 errors; the 2 warnings are in `ChatWindow.tsx` (react-refresh, unused disable directive), which this change does not touch
- vitest, full frontend: 228 files, 2849 passed, 1 skipped
- `npm run build`: pass
- `npm run test:e2e` (Playwright, cached Chromium 1234): 83 passed, 7 skipped, on the final head. One earlier full run failed `case-integrity › 2b`; it passed 3 of 3 isolated repeats and on the next full run. Recorded as a flake, not hidden.
- screenshots at 1440×900, 894×617 and 390×844, harness on `origin/main` (before) and on this branch (after): `/private/tmp/claude-501/stage1-shots/before/`, `.../after/` (Stage 1 only), `.../after-preview-contract/`
- NOT verified: long-list scrolling in the Table inspector (PR #872 not merged, so the inspector is not on this branch); the rationale is shown only in the Next-steps card, not in the Table lens

### Known limits (measured, not assumed)

- Exhaustion ("ran it twice, nothing came of it") cannot be measured: `tool_usage_log` records success, not what a call returned, and no artifact is linked to the run that produced it. Stage 1 uses a repeat signal instead (two live ok runs, one tool). Yield needs lineage (#613).
- Duplicate-only returns cannot be measured for the same reason.
- Cost and latency are always shown as unknown.
- "New since last review" is deferred: no durable last-review timestamp was verified on main.

Not done: no edge, schema, flag, or paid-call change; graph pivots, finding synthesis and cache sweep stay OFF.

---

Plan of record: `docs/plans/REMEDIATION_PLAN_2026-10-10.md`. This file is the checklist and the
running results. The previous contents (June UI/UX upgrade plan) are preserved verbatim in
`docs/archive/TODO_2026-06_workspace-ui-plan.md`; its 20 unchecked items belong to retired sub-sections, not current work.

## Status: S1a is IMPLEMENTED and DEPLOYED (live `811929c`) but enforcement is DISABLED (`RUN_LEASE_DISABLED=true`)

Four states, kept apart on purpose: **implemented** (merged) → **deployed** (`/health` build moved) → **enabled** (enforcing in production) →
**production-verified** (exercised live with enforcement on). S1a is the first two and neither of the others. Re-enabling needs JD's explicit authorization. Handoff: `SESSION_HANDOFF_2026-10-10_s1a-admission-lease-and-the-heartbeat-incident.md`.

Audit baseline revalidated 2026-10-10 (plan §1, historical): `main` `811acf3`, live build `f9fc281`, #724 merged and live, #613 schema
unapplied, 13 open PRs all draft. **Current (2026-10-11T06:43Z):** `main` `88f853e`, live `811929c`, `deploy/live` `811929c`, mirror `8d59968`.

## Plan

### S1 — run ownership (P0)
- [x] S1a admission lease (#730): implemented and deployed (`2e0d3ee`): versioned conditional UPDATE, 409 on a live run, 503 on an unprovable claim, release on every startup exit, `RUN_LEASE_DISABLED`, `checks.run_lease`, `.github/ci/assert-run-lease.sql`
- [x] Frontend 409 correction (#733): `beginInvestigation` no longer stamps `status`/`last_heartbeat_at`; implemented and deployed (Vercel, on merge)
- [x] Six-minute server guard (#734): a heartbeat is live only with `run_started_at` within `RUN_LEASE_MAX_RUN_MS` (6 min); implemented and deployed (`811929c`)
- [ ] **Lease enforcement: DISABLED.** Per JD (2026-10-11) S1b fencing (Option A, shipped dark) comes BEFORE re-enable; then lease and fencing are enabled together in one separately authorized, controlled test. Verification: `/health` no longer `LEGACY` and names the 6-minute wall, one real send succeeds, a deliberate double-send on a test thread gets a truthful 409. **Not yet exercised in production with enforcement on.**
- [ ] S1b schema: `threads.run_generation`, `threads.run_owner` (through Lovable, verified live)
- [ ] S1c fenced heartbeat / finalize / persistence writes; cause vocabulary; `/health` `checks.run_fencing`
- [~] regression fixtures: stateful-fake race and finish-between-read-and-write covered (15 Deno tests + Postgres predicate assertion); a two-session Postgres concurrency test and refresh/stop/crash end-to-end fixtures remain for S1b

### S2 — tool contracts (P1)
- [ ] review #698 for merge
- [ ] authorized read-only query of `sent_keys` for the 82 rejected calls
- [ ] `tool_input_contracts_test.ts` table-driven valid/invalid fixtures per changed tool
- [ ] `/health` `checks.tool_input_contracts`

### S3 — lineage (P1)
- [ ] #613 rebase; add `messages.run_id`; apply through Lovable; verify `to_regclass`
- [ ] writer behind `ARTIFACT_LINEAGE_DISABLED`; `/health` `checks.artifact_lineage`

### S4 — spans and context (P1)
- [ ] schema: `orchestrator_invocations.spans/build/request_bytes/post_trim_chars`, `orchestrator_step_metrics.prompt_terms`
- [ ] writers; salvage bound by `abortSignal`; supersede #612
- [ ] oversized-input fixture with defined bounded behaviour

### S5 — authority-safe dedupe (P0 authority, frontend)
- [ ] rebase #593 on `main`; contract in PR body; `npm run test:e2e` by hand

### S6 — source outcome taxonomy (P2)
- [ ] eight outcome classes on the edge; bounded recheck; #702/#703 wording after verifying codes; #701 stays OFF

### S7 — memory tool axis (P2, no schema)
- [ ] `tool:<name>` tags at `memory_save`; recall every run; bounded backfill; `MEMORY_TOOL_AXIS_DISABLED`; `/health` `checks.memory_tool_axis`

### S8 — payload store, then cache sweep (P2)
- [ ] table keyed by `call_id`; sweep enabled only after coverage proof

## Report-integrity investigation (2026-10-13, read-only; no app code changed)

Case: `coresint.xyz`, two runs on 2026-10-12 (first report generated 23:44:03Z; follow-up ~00:11Z 10-13). Plan below awaits JD approval; nothing here is implemented.

- [x] **R1 WITHDRAWN (JD, 2026-10-13).** Rewriting `[CONFIRMED]` to `[UNADJUDICATED]` changes the label, not the assertion; "same operator", ownership language and invented confidence numbers would survive. At most a temporary display mitigation. Replaced by the plan in "Revised plan" below.
- [ ] **R2 (separate edge PR):** gate `memory_save` of ownership/operator/identity conclusions that cite no evidence ids. The memory phase
      runs BEFORE the report phase (per the 2026-10-13 code read of `orchestrator-finalize.ts`; re-verify), so R1 alone cannot stop memory contamination.
- [ ] **R3 (frontend PR):** `badgesFor` ("Multi-source corroborated") counts raw source strings; count independent source CLASSES instead.
      `dedupeArtifacts` takes max confidence and unions source strings, which inflates that count. Contradiction rows get no `kind` guard in `labelForArtifact`.
- [ ] **R4 (edge PR):** `applyMemoryContext` only strips sources starting with `memory`; a recalled claim restated under a real-looking label is not flagged.
- [ ] **T1 (edge PR):** `indicia_web_dbs` defaults to all services incl. `snusbase`, but the provider requires `snusbaseType` and the code never sends it (live HTTP 400). Needs the provider's allowed values before any fix.
- [ ] **T2 (edge PR):** `shapeJinaBody` returns `ok:true` for empty, whitespace-only and challenge-page bodies; add an empty/challenge check (keep #696 semantics).
- [ ] **T3:** `lib/tool-input-failure.ts` prints `(unspecified)` for an InvalidToolInput error with no zod issues, and the `unparsable_input` branch is unreachable for that error name. Cause of the live `minimax_correlate (unspecified)` is NOT reproduced; needs the row's `sent_keys`.
- [ ] **U1 (Lovable frontend, not canonical):** mirror `ThreadSidebar.tsx` discards the `get_thread_sidebar_metrics` RPC error (silent zero); mirror has `/timing` with no nav link. Neither exists in canonical.
- Not changed, by design: reddit_user stays enabled (settled operator decision); direct-Gemini-first fallback is intended (`resolveFallbackProvider`).

### Cross-run propagation (static trace 2026-10-13; prompt lines verified by me, the rest from a subagent read of the code)
How an unsupported run-N claim becomes a run-N+1 premise. None of these paths is the DB trace; which one fed the follow-up run is NOT yet established.
- [ ] **P1 history replay:** `index.ts:272` `convertToModelMessages(messages)` resends prior assistant prose (tags, "same operator") verbatim; trims are by size only. No "prior/unverified" label.
- [ ] **P2 prompt grants authority:** `system-prompt.ts:145` tells the model to cite recalled memory as "[MEMORY] previously corroborated"; `tool-registry.ts:5957` `memory_hint` says "incorporate confirmed connections ... Do NOT re-investigate". Both raise model-authored memory to corroborated status.
- [ ] **P3 planner memory:** `tool-registry.ts:1288-1296` injects top-8 `agent_memory` rows as "PRIOR MEMORY (weight these ... confirmed links)".
- [ ] **P4 memory_save:** a single-subject unsupported claim passes both gates and returns at its saved confidence (default 60, ratcheted by GREATEST).
- [ ] **P5 investigation_cache:** replays the prior report prose to a later thread for the same seed (7 days).
- [ ] **P6 tool_call_cache (corrected):** `cache.ts` wraps every tool not in `NO_CACHE_TOOLS` (mutators only); TTL is `DEFAULT_TOOL_TTL_MS` = 24h unless listed in `TOOL_TTL_MS`; a result is written only when `ok && isCacheableToolResult`. So `minimax_correlate`/`minimax_extract`/`gemini_deep_dork` ARE eligible at 24h. Replay needs an identical input hash, so a carried inference is low-probability for correlate (artifact list changes) and higher for gemini_deep_dork (seed+kind+focus). UNVERIFIED as an actual carrier; the screenshots show Cached 3 of 33 and 3 of 64, i.e. no new replays between views (assuming one thread).
- Evidence the memory path was live: the first report's rows for the operator email, `floeintel.com`, `l5e.io` and the sitemap routes carried source "case memory recall".
- Proposed (not started): R5 reword P2 so recalled memory is labelled prior/unverified, never "corroborated"; R6 label replayed prose.

### Regression cases run against real functions (scratchpad, not committed)
Pass: repetition adds no authority (stays 50); four providers = 1 independent class; sitemap-derived profile caps at 50; single vendor verdict caps at 65.
Fail: relationship-bearing rows scored 60-80 (a score alone does not show wrong relationship semantics; the violated invariant still has to be stated and tested at claim level); "never archived" value persisted at 70 (the #693 negative rule reads source labels, not value text). Case 8 is NOT an end-to-end reproduction: `hasReportShape` is the completion contract (`resolveTerminalState`/recovery decide complete vs Interrupted), not an authority check, so it proves only that it does not enforce adjudication.
Spec only: no count reconciler exists in app code ("20 routes" vs 9 + 12).

## Queue status — six stages, tracked separately (verified 2026-10-13T00:54:41Z)

documented → implemented → tested → merged → deployed → production-verified. A documented, green-but-open or draft change is NOT shipped. Every open PR below is a DRAFT; none is reviewed (no formal reviews or threads on #700-703). CI badges are from Oct 6 heads against the OLD base `8039235` (37 commits behind `main` `c4bd432`); the "tested" column for them is MY run on the PR merged onto current `main`, local only. Frontend PRs reach production on merge (Vercel); edge PRs need the separate stamp -> mirror sync -> `verify:deploy` -> Lovable deploy -> moved `/health` build cycle, one at a time.

| Item | Kind | documented | implemented | tested (on current main, local) | merged | deployed | prod-verified | Blockers / notes |
|---|---|---|---|---|---|---|---|---|
| #737 docs | docs | yes | n/a | n/a | no | n/a | n/a | records the investigation; fixes no behaviour |
| #738 PR A memory authority | edge | yes | yes | yes: edge 2257/0/6, vitest, typecheck, 24 new tests | no | no | no | not a complete integrity fix |
| PR B report boundary | edge + frontend | design only | no | no | no | no | no | needs approval of the design |
| #700 area-code warning | frontend | yes | yes | yes: 15 files/241 targeted, full vitest 190/2397+1 skip, typecheck, e2e 52+2 skip | no | no | no | clean vs main; no review |
| #702 LeakCheck 403 wording | frontend | yes | yes | yes: 32 targeted, full vitest 189/2395+1 skip, typecheck, e2e 52+2 skip | no | no | no | clean vs main; no review |
| #593 dedupe authority | frontend | yes | yes | yes: full vitest 189/2400+1 skip, typecheck, e2e 52+2 skip | no | no | no | clean vs main; covers the dedupe half of R3 only |
| #703 Opsis 402 hint | edge | yes | yes | yes: edge 2244/0/6 | no | no | no | live Opsis contract NOT run (needs JD's key); Opsis unused in coresint |
| #701 LeakCheck key probe | edge | yes | yes | scratch-resolved only: edge 2255/0/6 | no | no | no | CONFLICTS with main (health-handler imports); OFF by default; valid-key/no-quota assumption UNVERIFIED |

Overlap with current work: #593 vs R3 (dedupe done there; the `badgesFor` raw-source-string count is NOT touched); #666 touches the report builder for zero-hit lookups (report layer only; the write-side value-text claim is separate); #698 changes catalog names for 5 other tools, not jina/gemini_deep_dork/minimax_correlate. Pairwise merge-tree: no conflicts among #593, #666, #698, #699, #695, #700, #702, #703 and #738. #701, #667, #613, #516 already conflict with `main`.

## Revised plan (2026-10-13, awaiting JD approval; no application edits made)

### PR A (edge): stop prompt/history authority escalation. One behaviour change + kill switch + one new `/health` key.
Demonstrated escalations: `system-prompt.ts:145-146` ("INCORPORATE ... CITE as \"[MEMORY] previously corroborated\""), `tool-registry.ts:5957` `memory_hint` ("incorporate confirmed connections ... Do NOT re-investigate values already covered"), `tool-registry.ts:1292` planner header ("weight these ... confirmed links"), `index.ts:272` history replayed unlabeled.
- A1 wording: recalled memory is prior-run context whose positive claims are leads to re-verify; cite as "[MEMORY - prior run, unverified]". Keep "do not re-investigate" ONLY for analyst-rejected values and existing dead-target memory.
- A2 read-time provenance on recall output (`memory_recall`, `memory_hits`, planner rows), computed from existing signals only, no stored data changed: `analyst_false_lesson` (`isAnalystFalseLesson`), `superseded` (existing), else `model_authored_unreviewed`. agent_memory has NO provenance column and the only analyst writer is the false-positive lesson; analyst CONFIRMATIONS live in per-thread review state (`analystDecisionsBlock`), not in agent_memory. Cross-investigation analyst-confirmed memory therefore has no representation today (decision for JD; would need a schema change through Lovable).
- A3 label earlier assistant text as historical model output, not independent evidence. Open check: confirm the budget trims (`orchestrator-budget.ts`) keep the head of a text part so a prefix survives; otherwise use a system-prompt statement instead.
- Files: `system-prompt.ts`, `tool-registry.ts` (3 sites), new `lib/memory-provenance.ts`, new `lib/history-label.ts`, `index.ts` (one call), `health-handler.ts` (`checks.memory_authority`), `env.ts` kill switch `MEMORY_AUTHORITY_WORDING_DISABLED`.
- Tests (Deno, real functions): forbidden phrases absent from the assembled prompt and `memory_hint`; mixed rows through the real `memory_recall` with a stubbed client; analyst FALSE lessons keep confidence 95 and still supersede; superseded rows unchanged; `analystDecisionsBlock` text for confirmed/rejected rows byte-identical (snapshot); history labeling leaves tool parts and the in-progress turn untouched and survives the trims; existing `memory_supersession_test`, `memory_context_test`, `reviews_wiring_test`, `system_prompt_*_test` still pass.
- Limits: no schema change, no change to scoring/caps/finalization/dispatch, no frontend, no historical-record edits. Acceptance: edge suite 2233+N / 0 failed; `/health` key present after the normal stamp/sync/deploy cycle; one controlled scan ONLY with JD approval to confirm the model cites the new wording.

### PR B (separate; design first): report-authority boundary
- Facts: the Evidence Record is MERGED into the last text part of the model message as plain markdown (`evidence-record-persist.ts:65-74`, kept there so the thread preview still reads the report), so narrative and record are one text part and only a regex (`narrativeIsUnadjudicated`) separates them. The Report tab re-shows the latest assistant summary as "Analyst narrative" (`CaseReport.tsx:1225`). `investigation_cache.assistant_parts` replays prose to later threads. `evidence-export` reads `threads` and `evidence_log`, not prose (confirm PDF content before relying on it).
- Three states to distinguish structurally: adjudicated with findings; adjudicated with zero findings (explicit `finalize_no_findings`, `hasNoFindingsDecision`); adjudication unavailable/failed (`retrieval`/`reviews` unavailable). Today "no rows" conflates the second with "never called".
- Direction (not claim detection): label the whole narrative by the absence/presence of a structural engine marker; a nonempty findings table covers only its rows. No keyword or tag rewriting, no silent edits to stored messages; legacy messages render as "no engine record". Streaming: any assistant message without the engine marker is labelled unadjudicated by structure, not by scanning prose. Invented confidence numbers in prose: displayed as AI narrative, never as scores. Separate edge and frontend PRs; must not gate or add work in the finalize window (CLAUDE.md termination invariants).
- Open design question for JD: a structural marker needs a part-level field or a separate part, which touches the preview constraint above.

### Not concluded / unresolved
- Which stored memory rows were retrieved in either run, and which path fed the follow-up run: needs the rows.
- The 85/65 persisted scores vs 80/60 from the policy function: unresolved until the exact stored rows and inputs are available.
- No blanket relationship caps and no keyword negation rules; claim-level semantics (claim meaning, supporting evidence, authority) must be specified and tested per invariant before any relationship change.

## Read-only DB trace (2026-10-13, thread 4595c1b0; SELECT only, no text/values/subjects/content read)

Established (query results; flags and counts are diagnostic, not proof of claim meaning):
- One thread (created 2026-10-01) holds THREE runs: run 1 23:40:43-23:44:06Z (14 steps, 33 tools, `finalize_forced`), run 2 00:05:43-00:07:09Z (4 steps, 9 tools, `natural_stop`), run 3 00:08:09-00:11:07Z (9 steps, 22 tools, `finalize_forced`). 33+9+22 = 64 = header tool count. Artifacts 33+6+12 = 51 = the "51 artifacts" footer.
- Final assistant text parts: run 1 13,474 chars / 20 `[CONFIRMED]` / has `[MEMORY]` (pos 2,804) / has "same operator" (pos 9,937); run 2 5,505 chars / 4 / no phrase; run 3 9,949 chars / 14 / has phrase (pos 7,459). All three messages carry the zero-row Evidence Record footer.
- History path is POSSIBLE, not proven: run 1's final text part sits inside the 16,000-char recent window for runs 2 and 3. Run 2's report lacks the phrase and run 3's has it.
- Memory rows about this case exist from 2026-10-09 04:07 (written by an earlier thread b5d26018, an Oct 9 run). Rows created by THIS thread's `memory_save`: 23:43:19 (`identity` 74 on the email subject, `connection` 60) and 00:10:17 (`connection` 70, `lesson` 74). Two Oct-9 rows now show this thread as `source_thread_id` because the live `save_agent_memories` upsert overwrites it, ratchets confidence with GREATEST, keeps the LONGER content and bumps hit_count/last_used_at (verified against the live function). So `hit_count`/`last_used_at` are NOT evidence of recall.
- Run 1's first `memory_recall`, `whois_lookup` and `wayback_cdx_search` were served from the user-level cache, created 5-9s before this thread's first message by ANOTHER thread (6d55b8da, seed type url, `stopped` at 23:41:03) that started 15s earlier. `memory_recall` is cacheable (24h default TTL).
- Artifacts flagged `context_from_memory` (writer `applyMemoryContext`, verified in code; other writers not enumerated): 4 `memory_only`/`needs_review` at 45-50 (email, floeintel.com domain, l5e.io, sitemap routes) and 4 that kept a real tool label and persisted `observed` at 65-75, including the organization row at 65.
- Contradiction row: confidence 85, status `needs_corroboration`, same batch insert as a breach row, not memory-flagged. Still UNEXPLAINED against the policy function (80).
- Tool failures: `minimax_correlate (unspecified)` had `sent_keys=[]` AND `invalid_fields=[]` at 0ms (a parsed-but-empty input produces named zod issues, so the arguments probably never parsed as an object; raw input not stored). The 24s was ONE successful call (23.8s). `gemini_deep_dork` sent `seed`+`dork_focus` (no `kind`, wrong name for `focus`). `jina_reader_scrape` `maxChars` wrong type (value not stored). All three schema failures were followed by deadline-skipped retries. `indicia_web_dbs` HTTP 400 (`snusbaseType`).

NOT established: which memory rows `memory_recall` returned (tool outputs are not stored in `tool_usage_log`); whether history, memory or both fed run 3; who authored the Oct-9 rows. Coverage limit: the memory candidate filter (subject/related_values/source_thread_id) misses inherited memory about other selectors.

## PR A (draft #738, edge only) and PR B (design only)
PR A shipped as a draft: recall wording, read-time provenance tags (`unreviewed` / `analyst_marker_pattern`, authorship inferred from wording only), historical-output label surviving real trimming (elision fix), kill switch `MEMORY_AUTHORITY_WORDING_DISABLED`, `checks.memory_authority`. 24 new edge tests; suite 2257/0/6.

PR B design (backward compatible, preview-preserving, additive; separate edge and frontend PRs):
- Emit ONE additive non-text part `data-evidence-record` ({state, finding_count, record_version}) beside the unchanged text. The thread preview reads the last TEXT part, so it is unaffected; the existing markdown record in the text stays for legacy readers. Old clients ignore the unknown part.
- States (note FOUR, not three): `adjudicated_findings`; `adjudicated_zero` (explicit `finalize_no_findings`); `adjudication_not_performed` (no rows and no decision); `adjudication_unavailable` (retrieval/review unreadable).
- UI renders the model narrative inside a labelled container chosen by state or, when the part is absent (streaming, legacy, replay), by structure: "AI narrative - not adjudicated". With findings: "The engine record covers the N listed findings; the rest of this narrative is unadjudicated." Model-written confidence numbers and tier tags are displayed as narrative, never as scores; no stored text is altered.
- Streaming: live assistant text has no engine part, so it is labelled unadjudicated by absence. Final persistence: the part is added in `composePersistedParts`. Exports: `evidence-export` reads `evidence_log`, not prose (confirm PDF content). Replay: `investigation_cache.assistant_parts` carries the part; replays show the state and "replayed from <date>". Historical rows unchanged.
- Must not add work to or gate the finalize window. Kill switch + a new proof key; frontend and edge never mixed.

### Reproduction status (run by me unless noted)
- Edge baseline on `c4bd432`: 2233 passed / 0 failed / 6 ignored.
- Synthetic repro against REAL functions (scratchpad, not committed): memory-restatement and zero-row-CONFIRMED-prose cases FAIL as expected;
  two breach tools classify to ONE independent class; schema failures for jina/gemini reproduced; `shapeJinaBody` blank/challenge -> `ok:true` reproduced.
- NOT reproduced: the 85 persisted on the model-authored `contradiction` row (real policy capped the synthetic row at 80); `minimax_correlate (unspecified)`.
- Untested: frontend (vitest) badge/dedupe cases; lifecycle/lease Tasks 4-5 (no run, code not yet traced); PG17 DB behavior.
- Access gaps: loveable connector `list_investigations` failed on every attempt, so thread, artifact and memory rows were never read;
  `/health` NOT called (GET `?health=1` runs stale-thread recovery writes, sweeps and provider pings).

## Results
- 2026-10-10: S1a incident. #730 live as `2e0d3ee` returned 409 on every send (client heartbeat stamp). Rolled back by kill switch, no redeploy. Fixed by
  #733 (client) and #734 (server guard, live `811929c`, stamp #735, mirror #111, ledger #736). Lease remains OFF.
- 2026-10-10: plan written and revalidated; no code changed. Memory-axis work (S7) was read-only
  reconnaissance only.
- 2026-10-10: S1a built, reviewed (3 confirmed findings fixed, 1 narrowed, 1 answered), merged as #730,
  stamped #731, mirrored #110, deployed and verified live `2e0d3ee` with `checks.run_lease` ok, ledger #732.
  Edge suite 2232/0/6. Stated limit: time lease, not fencing (S1b).

## Deep audit: pivot workflow and analytical language (2026-10-24)

Audit report: `docs/AUDIT_2026-10-24_pivot-workflow-and-language.md`  
Baseline: `main` at `70766fce` · CI status not independently verified

### Checklist
- [x] Read audit prompt and lessons
- [x] Verify GitHub SHA (`70766fce`); CI status not independently verified
- [x] Audit 1: pivot execution contract (WorkbenchNext docstring vs `requiresPreview`)
- [x] Audit 2: runner/busy state (WorkbenchNext → NextSteps `busy` prop, ChatWindow listener scope)
- [x] Audit 3: pivot explanation provenance (`explainPivot` claims vs actual evidence)
- [x] Audit 4: source/corpus semantics (four counting systems identified; two overstate)
- [x] Audit 5: narrative integrity / DOB display gap (code gap confirmed; narrative path unverified)
- [x] Audit 6: collision language (area-code generic warning overstatement)
- [x] Audit 7: HIBP semantics (occurrence count mislabeled as corpus count — 6-file propagation)
- [x] Audit 8: continuity/regression (cross-case state leak via missing `key={threadId}`)
- [x] Enumerate all manual pivot dispatch surfaces (4 + 1 programmatic)
- [x] Trace `explainConfidence` callers (ConfidenceExplain.tsx, EvidenceMatrixTab.tsx)
- [x] Trace `computeEffectiveSourceCount` callers (CaseReport, ReportCardV2, report-serializer)
- [x] Verify ChatWindow mounting scope (always mounted in workspace — no dispatching-to-nobody gap)
- [x] Check `buildSubjectProfile` DOB/age independence (no check found — Finding 5)
- [x] Write audit report and implementation plan

### Results

**8 findings** ranked by severity. Evidence classes are calibrated per-finding (see full report).

| # | Finding | Severity | Evidence class | Status |
|---|---------|----------|---------------|--------|
| 4 | Source-counting drift: "independent sources" counts provider tokens | High | code path confirmed; drift hypothesized | Open |
| 5 | DOB/age from single-source name displayed as fact | High | code path confirmed; metadata writer untraced | Open |
| 1 | Pivot contract says Preview-first; code dispatches directly | Medium | code path confirmed | Open |
| 7 | HIBP occurrence count mislabeled as corpus count | Medium | code path confirmed | Open |
| 2 | Busy state not shown in Workbench controls; silent refusal | Low-Med | code path confirmed | Open |
| 6 | Area-code collision triggers generic "different people" | Low-Med | code path confirmed; downstream hypothesized | Open |
| 8 | Cross-case stale display (missing `key={threadId}`) | Low-Med | code path confirmed; transient confirmed | Open |
| 3 | Pivot explanation copy could be hedged | Low | code path confirmed; impact hypothesized | Open |

**Two frontend PRs + one edge PR proposed** (consolidated per JD's one-frontend-PR preference). All await JD approval.

**Unverified:** Live-case narrative path for Finding 5 (no authenticated access); `metadata.dob` writer; narrow-screen rendering; Evidence-to-Connections handoff detail.

**Decision needed from JD:** Should Workbench pivots always go through Preview (enforce the docstring), or should the docstring match the code (clean pivots dispatch directly)?

## Blockers / decisions for JD
- **Re-enable the S1a lease?** Explicit authorization required; the kill switch stays `true` until then.
- Engine fixes (separate PRs, evidence-ranking, need sign-off): corroboration should filter through `NON_CORROBORATING_CLASSES`; add a `reputation` kind; negative lookups as coverage, not artifacts.
- S1b (fencing) needs the schema change `threads.run_generation` / `run_owner` through Lovable: approve the schema PR when ready.
- Historical `verified` rows on `7a2968e1` (F5): remediate through Lovable with an audit row, or leave and document.
- #612: supersede (recommended) or extend.
- Which providers to keep (OathNet, Opsis, FOFA, deepfind, reddit) — governs S6 wording.

## 2026-10-25 — Stage 1 (frontend workspace redesign) — scope correction

Stage 1 (branch `claude/insight-finder-frontend-design-5859d5`):
- DONE: `WorkspaceUIStateProvider` (per-thread selection + note drafts, scoped inside the existing `key={threadId}` boundary).
- DONE: `ArtifactInspector` lifted from PR #872 with notes hoisted to context and an explicit Close + focus restoration.
- DONE: Workbench Sheet becomes dual-mode (case summary ↔ inspector); auto-switches to Sheet on selection.
- DONE: Evidence row-click publishes selection to the shared workbench.
- DONE (**scope correction, previously mis-deferred**): Compact Evidence ledger (`EvidenceLedgerTab`) is the default/primary Evidence view. Board / Table / Clusters / Timeline / Pivots remain reachable through the lens switcher.
- DONE: Fast-Refresh warning on the provider resolved (hook split into `src/hooks/useWorkspaceUIState.ts`).
- DONE: Breakpoint comment corrected to `xl: 1280px` (was mis-labelled 1024px).
- DONE: Save-flow + cross-case isolation + ChatPage integration tests.

Deferred to Stage 1B:
- Chat `[R-nnn]` reference → open the referenced finding in the shared workbench.
- Connections-node → selection into the shared workbench.
- Composer / progress state restyle in the Investigate tab (keep existing stream behavior intact).

Pending (JD-driven, not fork-driven):
- Harness screenshots at 390 × 844, 894 × 617, 1440 × 900 — primary ledger, selected inspector, empty Sheet state, long-content scrolling.
- Manual workspace e2e against the harness URL.

PRs #872 / #873 / #874 untouched; branch not pushed; no PR opened; no merge.


## Sensitive Registrations repair — 2026-10-25

Scope: one authority leak only. Other audit findings remain backlog. No merge/deploy or production writes.
Base: `750e885cffb0574290abec77bb406d7c2e673927`, verified against remote main.
Branch: `repair/report-subject-registrations`; draft PR #881.

- [x] Read AGENTS.md, CLAUDE.md, tasks/lessons.md; inspect status/remotes/current HEAD.
- [x] Inspect overlapping #593/#873/#874 via fetched refs and GitHub API. Their branches are untouched; #593 changes radar/dedupe, not the registrations builder.
- [x] Trace artifacts → buildRegistrationRows → Sensitive Registrations; compare subjectBreaches and export predicates.
- [x] Run failing rendered-table tests before changing behavior: 2 failed / 19 passed.
- [x] Reuse forSubject/isSubjectAuthorityEligible, rejectedDerivedIds and isNullResultValue before registration deduplication.
- [x] Cover active quarantine even with analyst confirmation, dismissal/rejection, rejected-derived, negative results, positive eligible registrations, legacy collision/false-positive and explicit linkage release with rejection precedence.
- [x] Assert raw fixtures remain identical and excluded rows remain in Excluded / Collision Clusters.
- [x] Relevant report/authority/provenance regression suite: 52 passed / 0 failed.
- [x] Signed-in harness before/after, synthetic fixtures only, desktop 1440×900 and mobile 390×844. Before: 6 registrations including four ineligible rows. After: only EligibleFixture and ReleasedFixture. Quarantined original retained in excluded section. No page errors or Vite overlay.
- [x] Final typecheck and production build pass; lint passes with 15 warnings / 0 errors.
- [x] Review diff for unintended changes and real case data; update lessons; focused draft PR.

### Results

Root cause: buildRegistrationRows iterated raw artifacts and used only kind/reputation checks; sibling subjectBreaches already applies authority, rejected-provenance and negative-result gates. The repair adds those same gates before rows are built. No threshold, release rule, raw evidence, or persistence change.

Adjacent inspection (not expanded into this patch): profile/aliases/footprint use subject eligibility, but their rejected-derived coverage is a separate follow-up. buildReportMarkdown already cascades rejected provenance; audit serializer formats supplied clusters/sources and has no registrations producer.

Validation baseline: 2894 frontend tests passed / 1 skipped; existing harness e2e 95 passed / 13 skipped. Canonical edge suite subsequently completed 2781 passed / 0 failed / 6 ignored after network access became usable; the generated lockfile-only changes were restored. Edge code is unchanged by this repair. Skipped/ignored checks are not claimed as passed.

Evidence (outside repository): /tmp/registration-before.log, /tmp/registration-final-targeted.log, /tmp/registration-browser-before.log, /tmp/registration-browser-after.log, /tmp/registrations-{before,after}-{desktop,mobile}.png.

No authenticated production case inspection, paid scan, merge, or deployment. Deployed frontend SHA is not established; no attribution of this defect to the redesign is claimed. Separate pivot investigation was paused and preserved only on local branch repair/case-pivot-queue (ea082f1); it is not included in this PR.

Remaining UI limitation observed during this eligibility check: the unchanged mobile registrations table wraps source labels and identifiers tightly. This is a separate layout defect, not fixed or claimed resolved here.

## Wave 1 review pass — #935 merge failure, #937 repair, #936 at 5169043 (2026-11-01)

- [x] Merge #935 on JD's named go; squash `d26742c`. **This was done without reading the
      review BODY**, which already named two of its three defects. See lessons.md 2026-11-01.
- [x] Verify the three #935 defects against source before fixing (not taken on trust).
- [x] Ship #937 (account reset, paged step-token read, thrown-read handling); merged `e42373a`.
- [x] Confirm #937 reached production, not merely merged: Vercel deployment
      `dpl_HEYQztuBqrsMJjZyV15aaUhpitmG`, `target: production`, `state: READY`,
      `githubCommitSha e42373ad50f65969570a4591ba65d222d4ca43db`.
- [x] #936: merge `main` twice with merge commits (never rebase) — `bfce57c`, then `e42373a` in.
- [x] #936 finding 1 (stale observations on account change) — fixed `e94cb1a`.
- [x] #936 finding 4 (no-outcome rows create ghost tools) — fixed `6f67f42`, mutation-checked.
- [x] #936 finding 5 (order spec snapshots DOM without waiting) — fixed `6f67f42`.
- [x] #936 finding 3 (error text outranks explicit status) — **reversed my own "preference"
      call** and fixed in `5169043` after `500 + "upstream quota service unavailable"`
      reproduced as `credential_plan`. Mutation-checked; FOFA HTTP-200 fallback pinned.
- [x] #936 finding 2 (loading forever when `userId` undefined) — traced unreachable:
      `src/pages/BrainGlobalPage.tsx:320` returns `<Navigate to="/auth" replace />` on `!user`.
- [x] Reply on and resolve all three Graphify coupling threads (no code change).
- [x] Verify the salvage `providerOptions` claim from source rather than repeating it.
- [ ] **Codex review of #936 — has never run at any head.** Not clearance until it does.
- [ ] Re-measure the production `180 of 436 input_rejected` figure; `classifyFailure` changed.

### Outstanding decisions for JD

1. **Harden finding 2, or leave it?** Unreachable today only because of the `!user` redirect
   guard in `BrainGlobalPage`. One line (`loading: false` when there is no user) makes the
   exported hook correct standalone; leaving it keeps the diff minimal. The same question
   applies to `useRunEconomics`, already merged, which would need its own follow-up PR.
2. **Re-measure 180/436 before it is cited again?** It is computed by `classifyFailure`,
   which `5169043` changed, and it is the stated rationale for Wave 2. `query_database`
   is available again this session, so a counts-only aggregate is now possible.
3. **What ships next** — W1-C brain growth (JD's standing order) vs #887/#888 honest source
   counts (both external audits rank these first). Not started either way.

### Evidence

- #936 head `5169043943ec0593a06de9f8b93117a21f51a443`; base `origin/main` `e42373a`.
- Graphify review body (the only one, on `4170c45`):
  https://github.com/justindean785/insight-finder/pull/936#pullrequestreview-5726227010
- Graphify review body on #935, posted 02:48Z, merged 03:07Z:
  https://github.com/justindean785/insight-finder/pull/935#pullrequestreview-5726151473
- #936 CI run on `5169043`: https://github.com/justindean785/insight-finder/actions/runs/41272554995
- Salvage call site without `providerOptions`: `supabase/functions/osint-agent/index.ts:2177`;
  main stream with them: `:1555`.

### Results

The failure this pass corrects is procedural, not a coding error. #935 was green, mergeable and
had every inline thread resolved; its defects were sitting in the review body I never opened. The
same bot had filed the same class of finding on #936, which is how the pattern became visible.

Local gates on `5169043`: vitest 3147 passed / 1 skipped / 263 files; typecheck clean; lint 0
errors / 15 pre-existing warnings; build clean with no `harness.local` in `dist/`; e2e 118 passed
/ 13 skipped. CI on the same head: Edge and Migrations green, Frontend in progress at time of
writing, Workspace e2e **skipped by repository policy** (`ci.yml` runs it on push to `main` only),
so the browser contract for this PR is covered **only** by the local run above — stated, not
claimed as CI-passed.

Two claims corrected rather than defended: the #935 user-switch defect is hardening, not a
reachable production path; and an external audit's attribution of findings to Graphify, which I
had wrongly called a misattribution, was correct.

Not done, deliberately: no merge, no deploy, no DDL, no flag or secret change, no roadmap work
(salvage `providerOptions`, request modes, `{{FINDINGS_TABLE}}`, Wave 2 schema, TRUNCATE revoke).
The salvage omission is confirmed at source; its causal link to the 61.8s p50 salvage tail is not,
and is not asserted.
