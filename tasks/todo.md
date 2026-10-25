# tasks/todo.md — remediation workstream (audit 2026-10-10)

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

## Blockers / decisions for JD
- **Re-enable the S1a lease?** Explicit authorization required; the kill switch stays `true` until then.
- Engine fixes (separate PRs, evidence-ranking, need sign-off): corroboration should filter through `NON_CORROBORATING_CLASSES`; add a `reputation` kind; negative lookups as coverage, not artifacts.
- S1b (fencing) needs the schema change `threads.run_generation` / `run_owner` through Lovable: approve the schema PR when ready.
- Historical `verified` rows on `7a2968e1` (F5): remediate through Lovable with an audit row, or leave and document.
- #612: supersede (recommended) or extend.
- Which providers to keep (OathNet, Opsis, FOFA, deepfind, reddit) — governs S6 wording.
