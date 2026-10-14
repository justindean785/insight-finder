# Insight Finder — Limited-Beta Sign-Off — 2026-06-27

**Branch:** `chore/limited-beta-signoff-20260627` (off `origin/main` @ `34057df` / #138)
**Verdict:** ✅ **GO for limited beta — conditional on the operator deploy actions below.**
The code baseline is green, integrity systems verified intact, and every open
non-gated blocker is fixed or flagged. The telemetry fixes only take effect once
`osint-agent` is **redeployed via Lovable** (the central drift finding), so GO is
contingent on that redeploy + applying pending DB migrations.

---

## 1. Re-proven baseline (HEAD `34057df`, then `3074bcf` after fixes)

Toolchain: Node 22.22.3, Deno 2.7.14. All output captured live.

| Check | HEAD baseline | After fixes (`3074bcf`) |
|---|---|---|
| `npm run typecheck` | ✅ 0 errors | ✅ 0 errors |
| `npm run lint` | ✅ **0 errors, 8 warnings** | ✅ 0 errors, 8 warnings |
| `npm run test` (vitest) | ✅ **750 / 750** (63 files) | ✅ 750 / 750 |
| `npm run build` | ✅ success | ✅ success |
| `npm run test:edge` (deno) | ✅ **287 / 0** | ✅ **293 / 0** (+6 new) |
| `deno check index.ts` | ✅ **39 diags, 0 TS2304** | ✅ 39, 0 TS2304 |

**Lint-conflict resolved:** TRUE HEAD lint = **0 errors / 8 warnings**.
`BETA_READINESS_AUDIT.md`'s "305 errors" is **stale**; `SESSION_HANDOFF_2026-06-05`
("288 → 0, 8 react-refresh warnings") was correct. The 8 warnings are all
`react-refresh/only-export-components` on shadcn/ui kit files.

**deno-check note:** a *cold* deno npm cache reports 172 diagnostics (implicit-any
from the `npm:ai@6` `tool()` generic); once the cache is warm it is **39** — matching
the brief's "~39" baseline and CLAUDE.md's "12–157 pre-existing, not a gate". CI uses
`--no-check`. TS2304 = 0 throughout; my changes add **0** diagnostics.

---

## 2. `osint-agent-audit` — 5-dimension report (verified at HEAD)

| Dimension | Verdict | Evidence |
|---|---|---|
| **D1 Observability** | ✅ PASS | `wrapToolsWithCache` logs `tool_usage_log` in try/catch (warns, never throws); `cost_micro_usd` from `costForTool(name)` (cache.ts:275, 298–320). |
| **D2 Artifact quality** | ✅ PASS | `record_artifacts` is a **batch** tool (no per-row floods); kind validation/`inferKind`; confidence caps + source classes delegated to gated `source-classification.ts`/`confidence.ts` (single source); collision dedup; `source = a.source ?? null` (never `""`/`"agent"`). |
| **D3 Cost tracking** | ⚠️→✅ FIXED | Atomic increment via `increment_thread_cost` RPC per-call + per-step orchestrator metering; cached=0 & free=0 (cache.ts:295). **Gap: 21/82 tools were uncosted → Fix 6.** |
| **D4 Memory quality** | ⚠️ DRIFT | Upsert/dedup/normalize logic correct in source. **Live error = migration not applied (drift) → Fix 1 / operator action.** |
| **D5 Investigation stability** | ⚠️→✅ FIXED | Per-tool try/catch returns `{error}` (never throws — edge tests confirm); MiniMax→Lovable/Grok fallback wired. **Gaps fixed: skip misclassification (Fix 2), fetchRetry (Fix 3), dead/negative providers (Fix 4), step budget 28→50 (Fix 3). leakcheck/hunter 400 flagged (Fix 5).** |

---

## 3. Telemetry-failure appendix mapped to fixes

Source: `tool-failure-analysis_2026-06-27.md` — **583 calls / 98 failures = 16.8%** (7d).
Treated as ground truth (operator-supplied); each endpoint independently probed where possible.

| Telemetry finding | Count | Disposition | Status |
|---|---|---|---|
| `synapsint_lookup` disabled-in-config | 7 | Now classified **skipped**, not failure (Fix 2) | ✅ code |
| `ipqualityscore` / `deepfind_profile_analyzer` missing-key | 8 | Now **skipped** (Fix 2) | ✅ code |
| `emailrep` (unauth API disabled, 429) | 9 | Require `EMAILREP_API_KEY`; else **skipped** (Fix 4, probed) | ✅ code |
| `gravatar_profile` (404 "not found") | 7 | 404 = legitimate **negative** (`found:false`), not failure (Fix 4, probed) | ✅ code |
| `socialfetch_lookup` (404 "not found") | 7 | 404 = legitimate **negative**; live key + API healthy (Fix 4, probed with key) | ✅ code |
| `crtsh_*`, `wayback_*`, `whois`, `deepfind_reverse_email` (5xx/timeout) | ~19 | Now **fetchRetry** (backoff on 429/5xx/network) (Fix 3) | ✅ code |
| `memory_save` ON CONFLICT error | 2 | Fix present in source (`20260612`), **not deployed** → drift (Fix 1) | ⚠️ operator |
| `stolentax_footprint` | 6 | Needs live key to reproduce | ⚠️ operator-verify |
| `hunter_domain_search` (400) | 2 | Likely invalid-domain input; needs live key | ⚠️ operator-verify |
| `leakcheck_lookup` (400) | 6 | v2 `type=auto` query-format; needs live key | ⚠️ operator-verify |
| `bosint_phone_lookup` (timeout) | 7 | Already degrades to `{skipped:true}` (no change) | ✅ pre-existing |
| `ransomwarelive_lookup` | 0 | Resolved (key saved) — not flagged | ✅ |

**Projected effect (after redeploy):** ~38 failures are reclassified out of the
failure metric (15 intentional skips + 23 negatives/disabled), ~19 transient calls
gain retry coverage, leaving a small genuine-error tail (stolentax/hunter/leakcheck,
~14) pending operator key verification. Expected genuine fail-rate well under half of
16.8% — **to be confirmed against live telemetry after the Lovable redeploy.**

---

## 4. Deploy-drift — root cause + fix

- **Root cause:** `osint-agent` is deployed by **Lovable** from the mirror repo
  `seeker-spark-search-5362c57c`; `supabase functions deploy` 403s (Lovable owns the
  project). CI is test-only by design. The `/health` build marker was a **hardcoded
  string** (`2026-06-19-probe-hardening`) untied to any commit → drift was invisible.
  The `memory_save` migration drift (§Fix 1) is the same root cause on the DB side.
- **Fix (shipped):** `/health` `build` now derives from the git short SHA
  (`scripts/stamp-build.mjs` → committed `build-info.ts`, read by `health-handler.ts`;
  `npm run stamp:build`). `docs/REDEPLOY_RUNBOOK.md` documents the Lovable-sync channel,
  the parity check, and the migration-drift note. **No CI deploy job** (per operator —
  Lovable owns deploy). One-commit stamp offset documented; sufficient for drift detection.

---

## 5. Integrity systems — verified intact (read-only, never edited)

`deno test safety_test.ts compound_source_caps_test.ts threat_intel_test.ts` → **17 / 0**.
Minor-safety/DOB detection, compound source caps, source classification, and threat_intel
caps all behave as specified. No gated file was modified.

---

## 6. Deps / OAuth disposition (documented, not re-applied)

- `ai@^6.0.191` / `zod@^3.25.76` — confirmed the intended resting state (matches HEAD).
- The reverted OAuth/deps bump left **no orphaned residue**. The `signInWithOAuth` calls
  in `src/integrations/lovable/index.ts` and `src/pages/Auth.tsx` are the **existing,
  intended** Supabase/Lovable auth path, not half-applied bump artifacts.

---

## 7. Secret hygiene

- No tracked `.env` files. No hardcoded API-key patterns in tracked files (`build-info.ts`
  holds only a git SHA). API keys shared during this session were used for **transient
  probes only** and never written to the repo, docs, or commits.

---

## Operator actions (required for fixes to take effect)

1. **Redeploy `osint-agent` via Lovable** (sync to mirror → merge → auto-deploy), then
   verify `/health` `build` matches the shipped short SHA. See `docs/REDEPLOY_RUNBOOK.md`.
2. **Apply pending DB migrations** to the live Supabase (esp. `20260612_memory_save_dedup_batch.sql`)
   — fixes the `memory_save` ON CONFLICT error (Fix 1, drift).
3. **Optional:** set `EMAILREP_API_KEY` in Supabase secrets to re-enable emailrep (else it
   cleanly skips). Confirm `SOCIALFETCH_API_KEY` remains set (verified valid this session).
4. **Verify** `stolentax_footprint`, `hunter_domain_search`, `leakcheck_lookup` 400s with
   their live keys (Fix 5) before any breaker change.

## Requires JD sign-off (flagged, not touched)

- **WIP not in audited surface:** uncommitted edits on `fix/remediation-hardening`
  (`~/insight-finder`, 26 files incl. **gated** `SourceBadge.tsx` + `osint-agent/index.ts`)
  and dirty gated work in `insight-finder-tier0` (`fix/tier0-evidentiary-integrity`).
  Decide separately whether to preserve/PR. Touch gated files → JD required.
- **Breaker discrepancy:** telemetry implied `leakcheck` 400 "took out `breach_check`",
  but `circuit.ts` shows **no coupling** (independent breakers; only `hunter_*` share a
  group). Likely coincidental (both hit the 3-fail threshold). No code change made.
- **Overlapping open PRs** (kept independent; recommend): close **#121** (step-budget,
  stale base) as superseded by Fix 3; review **#119** (artifact-integrity — check gated)
  and draft **#90** (marker-reconcile/safety) against this branch.

## Remaining risks

- Telemetry improvement is **projected, not yet observed** — must reconfirm post-redeploy.
- `stolentax`/`hunter`/`leakcheck` 400s unresolved pending live-key repro.
- shadcn react-refresh warnings (8) retained deliberately (fixing = cross-file refactor,
  out of P2 scope); dev-velocity-only, 0 errors.

## Follow-ups (out of sign-off scope — net-new tooling)

- GHunt / Holehe and Spider Cloud scraping: only addable behind an HTTP microservice +
  `tool-registry.ts`/`catalog.ts` entry + key; post-beta feature work, not a blocker.

## Commits (P0/P1 and infra separated)

```
3074bcf feat(osint-agent): git-SHA build marker + redeploy/drift runbook   (Phase 4)
5328794 fix(osint-agent): retry transient external calls + raise step budget 28->50 (Fix 3)
69d7209 fix(osint-agent): classify emailrep/gravatar/socialfetch failures correctly (Fix 4)
42ac92b fix(osint-agent): stop counting intentional skips as failures in tool_usage_log (Fix 2)
0639c60 fix(osint-agent): cost the 21 registered tools missing from costs.ts (Fix 6)
```
