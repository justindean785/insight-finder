# tasks/todo.md — remediation workstream (audit 2026-10-10)

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
