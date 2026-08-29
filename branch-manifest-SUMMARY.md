# Branch deletion manifest & decision inventory — `justindean785/insight-finder`

**Measured 2026-08-29.** Read-only audit. Nothing was deleted, pushed, merged or checked out;
the working tree stayed clean at `origin/main` = `0513782`.

> Like every other dated document in this repo, this is a **measurement, not a state**.
> Branch tips and PR state move. Re-run the join before acting on it.

---

## 1. Reconciliation — why the number is 375, not 382

| | count |
|---|---|
| `refs/remotes/origin/*` in the local checkout | **382** |
| minus local-only artifacts created by a previous audit agent | **−7** |
| **GitHub authoritative `refs/heads/*`** | **375** |

The 7 excluded refs are `pr-435`, `pr-491`, `pr-493`, `pr-502`, `pr-512`, `pr-513`, `pr-514`.
They are not GitHub branches — they are local fetch refs a prior pass created, one per **open PR**,
and they are the whole of the earlier 382 over-count. They appear in no output file
(verified: `grep -cE '^pr-(435|491|493|502|512|513|514)\b'` returns 0 in both TSVs).

All 375 GitHub branch tips were confirmed present locally with **0 SHA mismatches and 0 missing
objects**, so every git-side measurement below is against the same commits GitHub reports.

**PR corpus:** 467 pull requests (`GET /pulls?state=all`, 5 pages × 100, exhausted at page 6 = 0).
385 merged · 75 closed-unmerged · 7 open. 435 distinct head refs, all from
`justindean785/insight-finder` (no fork PRs, so a `head.ref` join is unambiguous).

---

## 2. Final counts

| bucket | count | file |
|---|---|---|
| **Certified deletable** | **283** | `branch-manifest-DELETABLE.tsv` |
| **Decide** (not certified, not an open-PR head) | **85** | `branch-manifest-DECIDE.tsv` |
|   ↳ `pr-closed-unmerged` | 58 | |
|   ↳ `no-pr` | 16 | |
|   ↳ `merged-but-tip-moved` | 11 | |
|   ↳ `unresolved` | **0** | |
| **Open-PR heads** (excluded from both files) | **7** | — |
| **Total** | **375** | |

283 + 85 + 7 = 375, and the union of the two TSVs plus the 7 open heads is **exactly** the
375-name capture with no duplicates (`diff` against the sorted capture is empty).
Nothing was left `unresolved`.

---

## 3. What certified 283 branches deletable

All four gates had to hold, each proven from a primary source:

1. **A merged PR exists** — `merged_at` non-null on the GitHub PR object.
   (Note: the *list* endpoint reports `merged: false` even for merged PRs — that field is only
   populated on the single-PR GET. `merged_at` is the reliable signal and is what was used.)
2. **Tip == that PR's final head SHA** — string equality between the 375-ref capture and `head.sha`.
3. **Zero commits after the merge** — `git rev-list --count <pr_head>..<tip>` returned `0` for
   **all 283**, measured, not assumed.
4. **Not disqualified** — not one of the 7 open-PR heads, not `main`, not `deploy/live`, not
   `test/e2e-playwright-smoke`, not protected (`GET /branches?protected=true` returns `[]` —
   this repo has **no branch protection rules at all**).

Three anomaly sweeps came back empty: no certified branch has a newer unmerged PR at the same tip
(0), a later unmerged PR at any SHA (0), or an open PR (0).

### Reading the `merge-tree` cross-check on deletable branches

Supplementary `git merge-tree --write-tree origin/main <branch>` on the 283:
**110 no-op, 171 conflict, 2 clean-add**. The 171 conflicts are **not** a warning.
This repo squash-merges — 211 of the 283 tips are not ancestors of `main` — so replaying an old
branch three-way against a `main` that has moved on re-conflicts by construction. The PR
`merged_at` + tip-equality gate is the authority; merge-tree is context only.

The 2 clean-adds were opened and read by hand, and both are replay artifacts, not lost work:

- `claude/fix-health-probe-response-leak` → would re-insert a **second, byte-identical copy** of
  `releaseBody()` into `supabase/functions/osint-agent/health-handler.ts`.
- `claude/indicia-backport-upstream` → would re-insert a duplicate `WEB_DB_SERVICES` /
  `HUDSONROCK_TYPES` / `inferHudsonRockType` block into `tools/indicia.ts`.

In both cases the text is already on `main` verbatim. Nothing is missing.

---

## 4. ⛔ Flagged for preservation

**`test/e2e-playwright-smoke`** (`9a90430`) — **this is the repo's only Playwright suite, and
no equivalent exists anywhere on `main`.** Confirmed two ways against `origin/main`:
`git ls-tree -r --name-only origin/main | grep -iE 'playwright|\.spec\.(ts|js)$|e2e'` returns
**nothing**, and `package.json` on `main` contains no `playwright` dependency and no `test:e2e`
script (matching CLAUDE.md's own note that there is no `test:e2e`). The branch is 1 commit ahead
and carries 258 insertions across 6 paths:

```
A  playwright.config.ts
A  tests/e2e/public-smoke.spec.ts
A  tests/e2e/authenticated-investigation.spec.ts
M  package.json  ·  M  package-lock.json  ·  M  .gitignore
```

It has **never had a PR**, so it is classified `no-pr` — but deleting it destroys the only
end-to-end coverage the project has ever had. It should be landed or explicitly retired by a
human, not swept.

**`main`** (`0513782`) — default branch. **`deploy/live`** (`cf06cbb`) — the deploy ledger ref the
CLAUDE.md release recipe reads and writes; its tip is the recorded live `osint-agent` build.
Both are in the DECIDE file for completeness, both marked DO NOT DELETE.

**The mirror is out of scope.** `lovable-sync-1784512454` lives in
`justindean785/seeker-spark-search-5362c57c`, a separate Lovable-owned project. It is not among
these 375 refs and **nothing here touches the mirror**. Handle it separately, and remember the
mirror is writable by a second agent whose edits this repo never sees.

---

## 5. Decision inventory (85 branches)

### No PR ever existed (`no-pr`) — 16

Never went through review. Three of these are structural and must never be deleted (flagged **PRESERVE** below). Two (`chore/stamp-wave1-20260722`, `copilot/review-prs-and-branches`) are already 0 commits ahead of `main` and merge to a no-op — they are safe in content terms but are *not* certified here because no PR proves it. `claude/loveable-backend-audit-cswjln` is this session's own working branch.

| branch | tip | PR | ahead of main | what_would_be_lost |
|---|---|---|---|---|
| `chore/stamp-wave1-20260722` | `90d2585c` | — | 0 | **no-op** — merge result == `origin/main^{tree}`; nothing on main is missing |
| `claude/breach-values-unmasking-uk2v2b` | `f7d40bfd` | — | 240 | **conflicts** in 65 path(s): `index.html`, `package-lock.json`, `package.json` (+62 more) — needs a manual rebase to assess |
| `claude/loveable-backend-audit-cswjln` | `5495889e` | — | 1 | **clean add**, 1 path(s) (1 new): `AUDIT_2026-08-29_state-and-merge-plan.md` |
| `copilot/review-prs-and-branches` | `7188a2f6` | — | 0 | **no-op** — merge result == `origin/main^{tree}`; nothing on main is missing |
| `cursor/fix-insights-account-race` | `87f820a2` | — | 1 | **conflicts** in 1 path(s): `src/hooks/useInsightsData.ts` — needs a manual rebase to assess |
| **⛔ PRESERVE** `deploy/live` | `cf06cbbb` | — | 0 | **no-op** — merge result == `origin/main^{tree}`; nothing on main is missing |
| `deploy/reconcile-310-311-deepseek-obs` | `fb7b0ddd` | — | 235 | **conflicts** in 64 path(s): `index.html`, `package-lock.json`, `package.json` (+61 more) — needs a manual rebase to assess |
| `feat/deepseek-orchestrator-hardening` | `87031da4` | — | 2 | **conflicts** in 4 path(s): `supabase/functions/osint-agent/env.ts`, `supabase/functions/osint-agent/health-handler.ts`, `supabase/functions/osint-agent/index.ts` (+1 more) — needs a manual rebase to assess |
| `feat/workspace-ui` | `f0f101e1` | — | 1 | **conflicts** in 2 path(s): `PRODUCT.md`, `src/components/workspace/WorkspaceTabs.tsx` — needs a manual rebase to assess |
| `fix/breach-value-persistence` | `3a6c4adb` | — | 241 | **conflicts** in 65 path(s): `index.html`, `package-lock.json`, `package.json` (+62 more) — needs a manual rebase to assess |
| `fix/deterministic-early-finalize` | `50567988` | — | 2 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/orchestrator_finalize_test.ts` — needs a manual rebase to assess |
| `fix/evidence-intelligence-core-calibrated` | `eb8ef1ee` | — | 4 | **conflicts** in 5 path(s): `src/lib/intel.ts`, `src/lib/report-hygiene.ts`, `supabase/functions/osint-agent/index.ts` (+2 more) — needs a manual rebase to assess |
| `fix/infra-artifact-extraction` | `67d6f571` | — | 2 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/auto-persist-findings.ts`, `supabase/functions/osint-agent/infra_artifact_extraction_test.ts` — needs a manual rebase to assess |
| **⛔ PRESERVE** `main` | `0513782b` | — | 0 | **no-op** — merge result == `origin/main^{tree}`; nothing on main is missing |
| `safety/wip-ui-recovery-20260616` | `aa06a88f` | — | 5 | **conflicts** in 30 path(s): `.gitignore`, `index.html`, `src/components/ChatWindow.tsx` (+27 more) — needs a manual rebase to assess |
| **⛔ PRESERVE** `test/e2e-playwright-smoke` | `9a90430b` | — | 1 | **conflicts** in 1 path(s): `.gitignore` — needs a manual rebase to assess |

### PR closed without merging (`pr-closed-unmerged`) — 58

Someone opened a PR and decided not to land it. 44 conflict with today's `main`; 13 still merge cleanly and carry content `main` genuinely lacks (mostly design docs and handoffs, but also real edge-function code in `claude/insight-finder-stabilization-ivm4rx`, `cursor/critical-bug-management-1993`, `cursor/critical-bug-management-99da` and `fix/gemini-vision-timeout-leniency`). One (`fix/evidence-export-500`, #82) is a no-op — its content reached `main` another way.

| branch | tip | PR | ahead of main | what_would_be_lost |
|---|---|---|---|---|
| `chore/hourly-edge-health` | `9b86687e` | #484 (closed) | 1 | **conflicts** in 1 path(s): `.github/workflows/edge-health.yml` — needs a manual rebase to assess |
| `claude/awesome-lumiere-1719bc` | `ff47a2ed` | #84 (closed) | 4 | **conflicts** in 10 path(s): `src/components/panel/AuditTab.tsx`, `src/components/panel/ClustersTab.tsx`, `src/components/panel/KeyFindings.tsx` (+7 more) — needs a manual rebase to assess |
| `claude/chat-column-readable-width-gsi1ga` | `5aded4e2` | #330 (closed) | 1 | **clean add**, 1 path(s) (0 new): `src/index.css` |
| `claude/confidence-display-cap` | `0517729d` | #427 (closed) | 1 | **clean add**, 2 path(s) (0 new): `src/lib/confidence.ts`, `src/test/confidence.test.ts` |
| `claude/deterministic-finalize-gate` | `0b8081fb` | #381 (closed) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/index.ts` — needs a manual rebase to assess |
| `claude/findings-table-provenance` | `30b58bb6` | #454 (closed) | 4 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/index.ts` — needs a manual rebase to assess |
| `claude/insight-finder-repo-review-zjk0bt` | `38507833` | #280 (closed) | 1 | **conflicts** in 6 path(s): `supabase/functions/osint-agent/capabilities.ts`, `supabase/functions/osint-agent/catalog.ts`, `supabase/functions/osint-agent/source-classification.ts` (+3 more) — needs a manual rebase to assess |
| `claude/insight-finder-stabilization-ivm4rx` | `74888de9` | #425 (closed) | 5 | **clean add**, 4 path(s) (2 new): `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/run-telemetry.ts`, `supabase/functions/osint-agent/run_telemetry_test.ts` |
| `claude/oathnet-ip-breach-reveal` | `b96569d4` | #341 (closed) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/oathnet_test.ts` — needs a manual rebase to assess |
| `claude/osint-agent-collection-integrity-ci2ft5` | `fbd1681b` | #305 (closed) | 8 | **conflicts** in 8 path(s): `.github/workflows/ci.yml`, `src/lib/intel.ts`, `src/lib/report-hygiene.ts` (+5 more) — needs a manual rebase to assess |
| `claude/pr-390-recovery-claim-0b4yfo` | `bbe2053f` | #419 (closed) | 2 | **conflicts** in 2 path(s): `IMPLEMENTATION_CHECKLIST.md`, `INSIGHT_FINDER_CONTEXT.md` — needs a manual rebase to assess |
| `claude/release-triage-beta-stabilization-2ol3m7` | `b124c9a1` | #308 (closed) | 2 | **conflicts** in 1 path(s): `tasks/todo.md` — needs a manual rebase to assess |
| `codex/ui-command-center-20260803` | `7e97399c` | #411 (closed) | 14 | **conflicts** in 4 path(s): `src/components/AppNav.tsx`, `src/components/workspace/WorkspaceTabs.tsx`, `src/index.css` (+1 more) — needs a manual rebase to assess |
| `cursor/beta-demo-video-scripts-a896` | `fa5ac19a` | #233 (closed) | 1 | **clean add**, 4 path(s) (4 new): `scripts/build-demo-video.sh`, `scripts/render-beta-demo-fast.py`, `scripts/render-beta-demo-v2.py`, `scripts/render-beta-demo.py` |
| `cursor/critical-bug-management-1993` | `5452b4de` | #412 (closed) | 4 | **clean add**, 4 path(s) (0 new): `supabase/functions/osint-agent/orchestrator-finalize.ts`, `supabase/functions/osint-agent/orchestrator_finalize_test.ts`, `supabase/functions/osint-agent/recovery.ts`, `supabase/functions/osint-agent/recovery_race_test.ts` |
| `cursor/critical-bug-management-5363` | `63a21fac` | #377 (closed) | 1 | **conflicts** in 5 path(s): `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/cache_budget_race_test.ts`, `supabase/functions/osint-agent/index.ts` (+2 more) — needs a manual rebase to assess |
| `cursor/critical-bug-management-99da` | `34449226` | #420 (closed) | 9 | **clean add**, 6 path(s) (0 new): `src/components/workspace/WorkspaceHeader.tsx`, `src/test/workspace-evidence-count.test.ts`, `supabase/functions/osint-agent/auto-persist-findings.ts`, `supabase/functions/osint-agent/auto_persist_findings_test.ts` (+2 more) |
| `cursor/harden-provider-error-surface-b5b8` | `4cad7d5d` | #227 (closed) | 1 | **conflicts** in 3 path(s): `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/stream-error-classify.ts`, `supabase/functions/osint-agent/stream_error_classify_test.ts` — needs a manual rebase to assess |
| `cursor/pipeline-phase0-tool-routing-8324` | `95e54c70` | #248 (closed) | 3 | **conflicts** in 12 path(s): `src/components/panel/ReportTab.tsx`, `src/hooks/useInsightsData.ts`, `src/lib/intel.ts` (+9 more) — needs a manual rebase to assess |
| `cursor/session-handoff-2026-07-21-cf62` | `3a019625` | #371 (closed) | 1 | **clean add**, 1 path(s) (1 new): `SESSION_HANDOFF_2026-07-21_pr369-deploy-emergency-rollback.md` |
| `cursor/tighten-dork-harvest-relevance-b5b8` | `3b8eeb39` | #225 (closed) | 1 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/dork_relevance_test.ts`, `supabase/functions/osint-agent/tool-registry.ts` — needs a manual rebase to assess |
| `design/automatic-slices` | `396ce002` | #408 (closed) | 4 | **clean add**, 2 path(s) (2 new): `docs/design/automatic-slices-rev2.md`, `docs/design/automatic-slices.md` |
| `design/evidence-provenance` | `e43c9f81` | #402 (closed) | 1 | **clean add**, 1 path(s) (1 new): `docs/design/evidence-provenance.md` |
| `design/name-normalization` | `6a96329a` | #404 (closed) | 1 | **clean add**, 1 path(s) (1 new): `docs/design/name-normalization.md` |
| `diagnostic/promote-boundary-repro` | `77ca3741` | #447 (closed) | 2 | **conflicts** in 1 path(s): `src/test/promote-boundary.test.ts` — needs a manual rebase to assess |
| `docs/agent-learning-loop-spec` | `abaaefff` | #379 (closed) | 1 | **clean add**, 1 path(s) (1 new): `docs/superpowers/specs/2026-07-21-agent-learning-loop-design.md` |
| `docs/session-handoff-2026-08-03` | `2f96ccdf` | #409 (closed) | 2 | **clean add**, 1 path(s) (1 new): `docs/SESSION_HANDOFF_2026-08-03.md` |
| `feat/analyst-feedback-loop` | `7c54ba77` | #279 (closed) | 2 | **conflicts** in 2 path(s): `src/lib/review.ts`, `supabase/functions/osint-agent/index.ts` — needs a manual rebase to assess |
| `feat/backport-mcp-server` | `423ec6a1` | #242 (closed) | 2 | **conflicts** in 3 path(s): `CLAUDE.md`, `src/lib/mcp/tools/get-investigation.ts`, `tsconfig.app.json` — needs a manual rebase to assess |
| `feat/evidence-classification` | `168aaf8b` | #278 (closed) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/index.ts` — needs a manual rebase to assess |
| `feat/orchestrator-budget-env` | `63c33ea8` | #331 (closed) | 2 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/build-info.ts`, `supabase/functions/osint-agent/orchestrator-budget.ts` — needs a manual rebase to assess |
| `feat/structured-pivot-loop-clean` | `bd432693` | #326 (closed) | 1 | **conflicts** in 1 path(s): `package.json` — needs a manual rebase to assess |
| `feat/structured-pivot-loop-types` | `ef32396b` | #325 (closed) | 2 | **conflicts** in 1 path(s): `package.json` — needs a manual rebase to assess |
| `fix/acc-corroboration-independence` | `1c52ce47` | #199 (closed) | 1 | **conflicts** in 3 path(s): `src/lib/intel.ts`, `supabase/functions/osint-agent/record_finding_corroboration_test.ts`, `supabase/functions/osint-agent/tool-registry.ts` — needs a manual rebase to assess |
| `fix/account-deletion` | `94442028` | #198 (closed) | 1 | **conflicts** in 1 path(s): `src/pages/Settings.tsx` — needs a manual rebase to assess |
| `fix/analyst-feedback-migration-reconcile-ci-parity` | `147f0f79` | #347 (closed) | 1 | **conflicts** in 2 path(s): `.github/ci/supabase-platform-shim.sql`, `.github/workflows/ci.yml` — needs a manual rebase to assess |
| `fix/artifacts-selector-scope-dedup` | `8d5714f3` | #307 (closed) | 14 | **conflicts** in 10 path(s): `.github/workflows/ci.yml`, `package.json`, `src/lib/intel.ts` (+7 more) — needs a manual rebase to assess |
| `fix/atomic-budget-early-finalize` | `8c664129` | #383 (closed) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/index.ts` — needs a manual rebase to assess |
| `fix/audit-followup-crashfix-riders` | `b59f782d` | #189 (closed) | 1 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/tool-registry.ts` — needs a manual rebase to assess |
| `fix/deploy-ledger-marker-field` | `0e7e4d1a` | #458 (closed) | 2 | **conflicts** in 4 path(s): `scripts/lib/deploy-provenance.d.mts`, `scripts/lib/deploy-provenance.mjs`, `scripts/record-deploy.mjs` (+1 more) — needs a manual rebase to assess |
| `fix/display-confidence-invariant` | `327d6250` | #461 (closed) | 1 | **conflicts** in 1 path(s): `src/lib/intel.ts` — needs a manual rebase to assess |
| `fix/evidence-combolist-noise` | `98268276` | #386 (closed) | 1 | **conflicts** in 2 path(s): `src/components/ResourcesPanel.tsx`, `src/components/workspace/GraphTab.tsx` — needs a manual rebase to assess |
| `fix/evidence-export-500` | `9fb9b70c` | #82 (closed) | 2 | **no-op** — merge result == `origin/main^{tree}`; nothing on main is missing |
| `fix/evidence-integrity-audit` | `0fc04a53` | #319 (closed) | 2 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/tool_timeout_caps_test.ts` — needs a manual rebase to assess |
| `fix/gemini-vision-timeout-leniency` | `43357f13` | #401 (closed) | 1 | **clean add**, 2 path(s) (1 new): `supabase/functions/osint-agent/circuit.ts`, `supabase/functions/osint-agent/gemini_vision_circuit_test.ts` |
| `fix/health-probe-doubled-path` | `7b055639` | #83 (closed) | 1 | **conflicts** in 3 path(s): `src/components/ChatWindow.tsx`, `src/lib/functionsUrl.ts`, `src/test/functions-url.test.ts` — needs a manual rebase to assess |
| `fix/indicia-contract-and-normalization` | `26595b20` | #378 (closed) | 1 | **conflicts** in 3 path(s): `supabase/functions/osint-agent/catalog.ts`, `supabase/functions/osint-agent/indicia_test.ts`, `supabase/functions/osint-agent/tools/indicia.ts` — needs a manual rebase to assess |
| `fix/issue-69` | `cfdade8f` | #246 (closed) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/tool-registry.ts` — needs a manual rebase to assess |
| `fix/oathnet-victim-reveal` | `676253be` | #343 (closed) | 1 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/oathnet.ts`, `supabase/functions/osint-agent/oathnet_test.ts` — needs a manual rebase to assess |
| `fix/osint-agent-runtime-reliability` | `5497c382` | #121 (closed) | 1 | **conflicts** in 2 path(s): `supabase/functions/osint-agent/index.ts`, `tasks/todo.md` — needs a manual rebase to assess |
| `fix/osint-artifact-integrity` | `2ce8e178` | #119 (closed) | 1 | **conflicts** in 5 path(s): `supabase/functions/osint-agent/compound_source_caps_test.ts`, `supabase/functions/osint-agent/confidence.ts`, `supabase/functions/osint-agent/source-classification.ts` (+2 more) — needs a manual rebase to assess |
| `fix/report-integrity-mechanical` | `ae14e63a` | #410 (closed) | 19 | **conflicts** in 3 path(s): `src/components/panel/CaseReport.tsx`, `src/lib/intel.ts`, `src/lib/review.ts` — needs a manual rebase to assess |
| `fix/restore-intermediate-toolchoice` | `0d20bca3` | #382 (closed) | 1 | **conflicts** in 3 path(s): `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/intermediate_step_plan_test.ts`, `supabase/functions/osint-agent/orchestrator-budget.ts` — needs a manual rebase to assess |
| `fix/scan-accuracy-gates` | `c7376263` | #460 (closed) | 1 | **conflicts** in 3 path(s): `supabase/functions/osint-agent/artifact_hygiene_test.ts`, `supabase/functions/osint-agent/lib/artifact-hygiene.ts`, `supabase/functions/osint-agent/tool-registry.ts` — needs a manual rebase to assess |
| `fix/transactional-auto-persistence` | `f23874b9` | #321 (closed) | 16 | **conflicts** in 11 path(s): `.github/workflows/ci.yml`, `package.json`, `src/lib/intel.ts` (+8 more) — needs a manual rebase to assess |
| `fix/ui-caseview-state` | `18ad2cb3` | #281 (closed) | 1 | **conflicts** in 2 path(s): `src/components/workspace/WorkspaceHeader.tsx`, `src/components/workspace/WorkspaceTabs.tsx` — needs a manual rebase to assess |
| `fix/ui-infra-pivots` | `c954713e` | #185 (closed) | 1 | **conflicts** in 1 path(s): `src/components/ChatWindow.tsx` — needs a manual rebase to assess |
| `reconcile/beta-stopfix02-backport` | `4cc365c3` | #328 (closed) | 9 | **conflicts** in 10 path(s): `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/capabilities.ts`, `supabase/functions/osint-agent/catalog.ts` (+7 more) — needs a manual rebase to assess |

### Merged, but the tip moved afterwards (`merged-but-tip-moved`) — 11

The PR landed, then commits were pushed to the branch afterwards, so the tip is no longer the merged head. The post-merge commits are unreviewed and unmerged. Four merge cleanly and would add real files; the other seven conflict.

| branch | tip | PR | ahead of main | what_would_be_lost |
|---|---|---|---|---|
| `claude/beta-release-deployment-d4eo2m` | `78056492` | #323 (merged, +3 after) | 2 | **conflicts** in 3 path(s): `supabase/functions/osint-agent/circuit.ts`, `supabase/functions/osint-agent/circuit_inflight_test.ts`, `supabase/functions/osint-agent/circuit_timeout_test.ts` — needs a manual rebase to assess |
| `claude/docs-session-notes-oi0urm` | `5961bff7` | #503 (merged, +1 after) | 3 | **conflicts** in 1 path(s): `mem/index.md` — needs a manual rebase to assess |
| `claude/gemini-vision-indicia-jina-p58sqs` | `6cb23345` | #250 (merged, +2 after) | 6 | **conflicts** in 10 path(s): `supabase/functions/osint-agent/attachment-intake.ts`, `supabase/functions/osint-agent/attachment_intake_test.ts`, `supabase/functions/osint-agent/build-info.ts` (+7 more) — needs a manual rebase to assess |
| `claude/insight-finder-beta-release-ygvppa` | `63fc1524` | #322 (merged, +2 after) | 1 | **clean add**, 1 path(s) (1 new): `HANDOFF_2026-07-15_beta-release.md` |
| `claude/insight-finder-prod-audit-b3yddb` | `e5d938c9` | #339 (merged, +3 after) | 1 | **clean add**, 1 path(s) (1 new): `SESSION_HANDOFF_2026-07-17.md` |
| `claude/loveable-preview-sync-z8lm5h` | `0525e249` | #33 (merged, +2 after) | 1 | **clean add**, 1 path(s) (1 new): `HANDOFF_2026-06-13_EOD.md` |
| `claude/new-session-k2g0ua` | `5bc3011c` | #387 (merged, +6 after) | 4 | **clean add**, 4 path(s) (3 new): `docs/adaptive-tool-selection.md`, `supabase/functions/osint-agent/cache.ts`, `supabase/functions/osint-agent/tool_yield_test.ts`, `supabase/migrations/20260727200000_tool_yield_stats.sql` |
| `claude/osint-agent-perf-hardening-8wk6d3` | `4f6b17fe` | #211 (merged, +10 after) | 2 | **conflicts** in 6 path(s): `supabase/functions/osint-agent/auth_body_size_test.ts`, `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/models.ts` (+3 more) — needs a manual rebase to assess |
| `claude/ui-frontend-audit-prs-59n7bi` | `8b69fb6f` | #429 (merged, +2 after) | 1 | **conflicts** in 1 path(s): `supabase/functions/osint-agent/system-prompt.ts` — needs a manual rebase to assess |
| `docs/handoff-20260630` | `1b016e0e` | #184 (merged, +8 after) | 9 | **conflicts** in 24 path(s): `src/components/BrainPanel.tsx`, `src/components/ChatWindow.tsx`, `src/components/ConfidenceExplain.tsx` (+21 more) — needs a manual rebase to assess |
| `fix/orchestrator-message-wedge` | `ad79249b` | #172 (merged, +1 after) | 2 | **conflicts** in 3 path(s): `src/components/ChatWindow.tsx`, `supabase/functions/osint-agent/index.ts`, `supabase/functions/osint-agent/message-sanitize.ts` — needs a manual rebase to assess |

---

## 6. Open-PR heads — excluded from both files (7)

Not deletable and not "decide": they are the live heads of open pull requests.

| branch | PR | state | head |
|---|---|---|---|
| `claude/address-seed-google-dork-fix-uhc2is` | #491 | ready | `9bdfeb92` |
| `claude/audit-claims-verify-oi0urm` | #502 | ready | `0896e003` |
| `claude/cache-sweep-maintenance` | #513 | draft | `a140310b` |
| `claude/deploy-gate-precondition` | #514 | draft | `ae04cc29` |
| `claude/new-session-h8pxov` | #512 | draft | `aa4d653a` |
| `fix/paid-call-accounting` | #435 | ready | `90474c5a` |
| `fix/tool-outcome-empty-classification` | #493 | ready | `d6ba36ff` |

Per CLAUDE.md, `draft` is the thing to look at here: **3 of the 7 are still drafts**
(#512, #513, #514), and a draft PR cannot merge no matter how correct it is.

---

## 7. Limits of this audit

- **Deletability is proven from PR metadata, not from content identity.** A squash-merged branch's
  commits are not reachable from `main`; what is certified is that GitHub recorded the merge and
  that the branch has not moved since. That is the correct gate, but it is not a byte-level
  proof that every line survived the squash.
- **A `(#123)` commit subject on `main` was never used as evidence.** Subject-matching is what
  over-counted a previous pass; it appears nowhere in the certification path.
- `git merge-tree --write-tree` wrote loose objects into `.git/objects` (harmless, no ref, index
  or worktree change). No other write of any kind was performed.
- `what_would_be_lost` for conflicting branches is deliberately unresolved — a real answer needs
  a manual rebase, which is out of scope for a read-only pass.
