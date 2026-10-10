# tasks/todo.md — remediation workstream (audit 2026-10-10)

Plan of record: `docs/plans/REMEDIATION_PLAN_2026-10-10.md`. This file is the checklist and the
running results. The previous contents (June UI/UX upgrade plan, all items shipped) were retired.

## Status: S1a SHIPPED (live build 2e0d3ee, 2026-10-10); next slice awaits JD

Baseline revalidated 2026-10-10 (details in the plan §1): `main` `811acf3`, live build `f9fc281`,
#724 merged and live, #613 schema still unapplied, 13 open PRs all draft.

## Plan

### S1 — run ownership (P0)
- [x] S1a admission lease (#730, live `2e0d3ee`): versioned conditional UPDATE, 409 on a live run, 503 on an unprovable claim, release on every startup exit, `RUN_LEASE_DISABLED`, `checks.run_lease`, `.github/ci/assert-run-lease.sql`
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

## Results
- 2026-10-10: plan written and revalidated; no code changed. Memory-axis work (S7) was read-only
  reconnaissance only.
- 2026-10-10: S1a built, reviewed (3 confirmed findings fixed, 1 narrowed, 1 answered), merged as #730,
  stamped #731, mirrored #110, deployed and verified live `2e0d3ee` with `checks.run_lease` ok, ledger #732.
  Edge suite 2232/0/6. Stated limit: time lease, not fencing (S1b).

## Blockers / decisions for JD
- S1b (fencing) needs the schema change `threads.run_generation` / `run_owner` through Lovable: approve the schema PR when ready.
- Historical `verified` rows on `7a2968e1` (F5): remediate through Lovable with an audit row, or leave and document.
- #612: supersede (recommended) or extend.
- Which providers to keep (OathNet, Opsis, FOFA, deepfind, reddit) — governs S6 wording.
