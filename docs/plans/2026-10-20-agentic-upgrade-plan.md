# Agentic upgrade plan — 2026-10-20 (Phase 0 deliverable, awaiting JD approval)

Source: JD's `insight-finder-agentic-upgrade-prompt.md`. Baseline: `docs/metrics/baseline-2026-10-20.md`.
**No code changes until JD approves this document.** Nothing here is deployed or merged.

## 0. Reconciliation results
- **No edge drift.** Live build `aae1152` is the marker from stamp commit `6c07f9f8` (#803). `git diff 6c07f9f8 HEAD -- supabase/functions` is empty; #805–#809 are frontend/docs (Vercel ships on merge).
- **"Not landed" verified absent** from src/functions/migrations: `load_dossier_section`, `memory_mode`, `dork_yield`, `workflow_outcome`, `pivot_queue`, `case_scores`, `case_hypotheses`, `propose_pivots`, `scoreCase`. `source_reliability`'s only hit is the static `TIER_SOURCE_RELIABILITY` map in `tiers.ts`; no learned kind exists, so Phase 3 builds new.
- **Reuse, don't rebuild** (CLAUDE.md "built and unwired"): `finding-synthesis.ts` + sweep (off behind `FINDING_SYNTHESIS_*`); `pivot-checklists.ts`; `shouldAllowToolCall` / `QUERY_FAMILY_NO_YIELD_LIMIT`; `circuit.applyBaselineDisables`; `memory_merge_candidates`; `isClusterIneligible` / `isExcluded`.
- **JD decisions (2026-10-20):** keep the Obsidian palette from #805 (no re-theme to `#0a0c0f`); finish the Obsidian queue (handoff 2026-10-19 §3) before these phases; Phase 5 builds on Obsidian tokens last.
- Prompt's test counts (680 vitest / 223 Deno) are stale; re-measure at Phase 1 start.

## 1. Rules that override the prompt
1. **A phase is a series of small PRs, then STOP for review.** Never mix frontend and edge; schema first (via Lovable, verified live), then code; one new `/health` proof key per behaviour-changing edge PR; one edge PR in flight; each edge PR runs stamp → surgical mirror sync → `verify:deploy` gate → Lovable deploy message → moved-SHA proof.
2. **C-1 / C-2 / evidence ranking are propose-only.** `scoreCase()` is additive, treats existing caps as hard ceilings, and never edits `confidence.ts`, tiers, `SourceClass` or `cluster.ts` without JD's written sign-off.
3. Settled, not reopened: `REVEAL_BREACH_DATA` on; `MAX_PAID_CALLS` bounded; no intent-from-prose; never gate finalize on evidence completeness; don't populate `seedTypes`; don't change `approxPromptChars`; `RUN_LEASE_DISABLED` stays true.
4. No per-artifact LLM calls; cost/run ≤ baseline ($0.203). Synthetic fixtures only; no subject data or thread ids in the repo.

## 2. Phases

### Phase 1 — One scoring truth
- **Edge:** pure `scoreCase()` module (shared with UI via parity test). Persist `case_scores` snapshots (schema PR first).
- **Adjudication = reuse the synthesis flags, NOT "just flip" (measured 2026-10-20):**
  - `synthesisEnabled()` is called only from `handleHealthProbe()` (`health-handler.ts:765`). The repo comment says pg_cron fires it every 60 s, but the live DB has **no pg_cron/pg_net extension** and the `edge-health.yml` workflow has no schedule. **Step (a): identify what actually hits the probe path in prod and how often** (edge-function request logs; external uptime monitor?) before relying on it.
  - **F-2 is OPEN live:** index `artifacts_synthesis_cluster_uniq` (migration `20260907000000`) does not exist in the live DB. Apply and verify it first (schema PR via Lovable).
  - **Probe trigger (resolved in code, verified 2026-10-20):** `ChatWindow.tsx:2610` calls `?health=1&maintenance=1` when a case with activity opens, every 30 s while a run is going, and at stream end. `edge-health.yml` is `workflow_dispatch` only and the live DB has no pg_cron, so the pg_cron comments in the F-2 migration and the sweep header are stale. **Consequences:** (1) synthesis only runs while a browser tab is open; (2) overlapping tabs make the F-2 read-then-write race realistic; (3) `maintenanceRequested(u)` (`health-handler.ts`) needs no authentication, so an unauthenticated GET can trigger sweeps. **Decide whether synthesis writes should wait for the authenticated `?probe=1` path** before enabling them; verify the gate itself, since I read only its comments.
  - **F-1 (sweep cursor re-scans the same 5 threads instead of recently completed ones) and F-3 (scoring-integrity defect):** their 2026-09-12 write-up is not in the repo and `git log` finds no fix for either; status as of 2026-10-20 is **unknown**, so check each against the code. **F-3 gets a diff review before any implementation.** The email-handle linkage fix also needs diff review (local part at least 8 chars, not in the generic-prefix denylist, lowercased exact match, no numeric-suffix normalization); status unknown, check `git log`.
  - **Verify with catalog queries, not the migration ledger:** `schema_migrations` stops at `20260825024640` (see the baseline doc).
  - **Sequence:** forward scope with `FINDING_SYNTHESIS_DRY_RUN` first → compare dry-run tiers against analyst labels offline → enable forward → backfill stays off until forward is validated.
  - Both origins are scored by the same engine chain (`lib/finding-row.ts`; `authoritative-findings.ts` treats every `kind='finding'` row as authoritative), so the 25 existing model-origin rows are engine-scored; synthesis adds *derived* findings that the orchestrator never asserted (0 so far). Synthesized findings appear after the next sweep, not at run end, so **the UI shows "synthesis pending" for that population, never "0 findings".**
- **Frontend:** read the snapshot; delete the recompute in `CaseReport.tsx` (`analystConfidence`, `computeRisk`, `buildAnalyticRadar`), `authority.ts` `tallyAuthority`, `ReportCardV2` `Independence`. Six-tier labels with "Analyst-reviewed" as a separate badge. **Obsidian Stage C1 owns the six-tier label map as one pure function (`tierFor`); `scoreCase()` consumes it later. Labels are built once, in C1.**
- **P4:** reproduce with synthetic fixture in `report-hygiene.ts` (`pickSubjectName` :540, `pickAllEmailsIdentity` :513), then fix, then lock with regression test; unresolved state renders "Subject not yet resolved".
- **Prose numbers:** post-process confidences in agent prose to tier word + engine row link; prompt update; test.
- **Propose only:** `docs/proposals/C2-scoring-v2.md`.
- **Kill switch / proof key:** env flag per edge PR; `checks.case_scores`. **Rollback:** flag off; UI falls back to prior reads until the client recompute is deleted (delete last).
- **JD sign-off:** snapshot schema; deletion of client recompute; C2 proposal.

### Phase 2 — Agentic loop, pivot queue, tiered context
- `pivot_queue` table + `propose_pivots` tool; deterministic gap detectors from `pivot-checklists.ts`; `extractRecommendedPivots` kept as flagged fallback with a metric.
- Autonomy L0/L1/L2 with budgets and saturation stop; audit table. **Ships together with the scope/purpose gate** (case purpose, subject class; relatives, residence, minors, financial always need approval). Replaces Auto-run ×3 in `run-controls.ts`.
- Tiered context (working set ≤25k + digest ≤8k, `load_dossier_section`, `query_case`), `case_hypotheses`, capped red-team call, deterministic importers, model routing A/B.
- **Gate (≥20 comparable runs):** avg initial context <40k (now 157k); forced-finalize <25% (now 51.9%); error <5% (now 15.2%); natural stop >60% (now 32.5%); median <200 s; cost ≤ $0.203.
- **Risk:** this is the termination-oscillation area; phase-aware only, per CLAUDE.md invariants I-1/I-2. **JD sign-off:** scope-gate taxonomy, autonomy defaults, any finalize-window change.

### Phase 3 — Memory v2
- `memory_mode` (Off/Smart/Full); `source_reliability`, `dork_yield`, `workflow_outcome` kinds; keyed by tool name (fixes the subject-only recall gap measured 2026-09-14); learning from `artifact_reviews` feeds EV ranking and circuit breakers; scoring priors only as proposals.
- "What the agent learned" panel with undo; `discovered_via` ids replace free-text subjects; **same for `artifacts.source` on finding rows, which holds free-text subject names, emails, phones and addresses**; dedupe/decay.
- **Cache (now 0.53% live):** TTL enforcement and sweep only **after** a payload store exists, since `tool_call_cache` is the only historical copy.
- **JD sign-off:** any scoring-prior change; cache sweep enablement.

### Phase 4 — Correlation v2
- Additive normalizers, link-score module with "why linked", typed edges, contradiction ledger feeding the queue — behind flags. **Clustering changes propose-only** in `docs/proposals/C1-correlation-v2.md`. Name seeds anchor on selectors.

### Phase 5 — Command Center UI (last, per JD)
- Built on the Obsidian tokens from #805/#806. Tier colors map 1:1 to the six tiers. Frontend-only PRs, one ready PR per CLAUDE.md frontend rule; before/after screenshots at 390 and 1440 px via the UI harness; AA contrast; `npm run test:e2e` by hand.

### Phase 6 — Evals and calibration
- Synthetic golden cases in CI; Brier/reliability script from `artifact_reviews`; pivot-yield metrics; regression gates for the Phase 2 targets.

## 3. Questions (1–2 decided 2026-10-20)
1. ~~Synthesis flags vs new hook~~ **Decided: reuse flags, conditional on the Phase 1 prerequisites above.**
2. ~~Scope-gate taxonomy~~ **Decided:** public figure / public-record subject / private individual / victim / possible minor / **non-person (domain, IP, wallet, org — not gated)** / unknown (**treated as private individual**). For **victim and possible minor, residence, relative and location pivots are hard-blocked, not approvable.**
3. Confirm the confirmed-negative `ok`-vs-`empty` check should be a Phase 1 prerequisite sample (not answerable from outcome counts).

## 4. Phase 0 limitations
- Baseline was run through the Lovable `query_database` tool (read-only SELECTs); no standalone runner script was written because Supabase REST cannot execute arbitrary SQL. `scripts/baseline-metrics.sql` is the repeatable artifact.
