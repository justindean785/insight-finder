# Release Triage & Beta Stabilization — 2026-07-14

Session goal: establish the exact repo / PR / mirror / deploy / DB state, audit the
combined #305/#307 release tree, establish DeepSeek deployment truth, and surface the
decisions only JD can make. **No merges, no migrations, no deploys were performed.**
Every claim below is labelled by evidence tier: `verified-live`, `executed-locally`,
`ci-green`, `read-only-prod`, or `code-read`.

---

## 1. Current-state matrix

| Surface | SHA / ref | Status | Prod? | Blocker |
|---|---|---|---|---|
| **GitHub `main`** | `8cbc34b` | canonical source of truth | source | — |
| **PR #304** (attachment-intake abort) | `3ab90ce` | open, **non-draft**, mergeable=`clean`, CI 4/4 green | no | none blocking — clean safety fix, **0 file overlap** with #305/#307 |
| **PR #305** (anchor-read + output gates) | `fbd1681` | open, **DRAFT**, mergeable=`clean` | no | **must NOT ship alone** — its dedup migration is destructive; superseded by #307 |
| **PR #306** (client_errors telemetry) | `9bc9c97` | open, non-draft, mergeable=`clean` | no | **2 unresolved security threads** (auth-token-in-URL P1; unrestricted `user_id` RLS P2) |
| **PR #307** (selector-scope dedup) | `8d5714f` | open, **DRAFT**, mergeable=`clean`, CI 4/4 green | no | stacked on #305; `fbd1681` is an ancestor of `8d5714f` → **#307 head IS the combined tree** |
| **DeepSeek branch** `feat/deepseek-orchestrator-hardening` | `87031da` (= `e6e24db` + `87031da`) | unmerged, unreviewed, **scope-mixed** | no | split DeepSeek-only (`e6e24db`) from OathNet/breach (`87031da`) |
| **Vercel production** | `8cbc34b` (per handoff, READY) | not re-verified this session | yes | none — follows `main`; no triage PR is merged, so prod frontend unchanged |
| **Vercel previews** | #307 preview built (`success`) | previews only | no | a READY preview proves only that it built |
| **Lovable mirror** `seeker-spark-search-5362c57c` | HEAD `0bdc5ed6`, `build-info` = **`4692afa`** | sync source; **partial DeepSeek**, no `checks.deepseek` | source-for-edge-deploy | mirror HEAD is *ahead of* the stamped short-SHA → **build marker is stale/unmoved** |
| **Live `osint-agent` /health** | **UNKNOWN** | egress-blocked (`403 CONNECT` to `skzqwbyvmwqarfgfvyky.supabase.co`) | yes | **cannot read the live build from this environment** — see §4 |
| **Production DB** (`skzqwbyvmwqarfgfvyky`) | dedup migration **NOT applied**; telemetry migration **NOT applied** | 6,889 artifacts / 457 reviews | yes | clean baseline; §3 has read-only impact |

### PR dependency graph
```
main (8cbc34b)
 ├── #304  fix/attachment-intake-abort (3ab90ce)      ── independent, 0 overlap
 ├── #305  claude/…collection-integrity (fbd1681)     ── DRAFT; destructive dedup; DO NOT SHIP ALONE
 │     └── #307  fix/artifacts-selector-scope-dedup (8d5714f)  ── rewrites #305's migration in place
 │              (fbd1681 is an ancestor of 8d5714f → combined tree == #307 head)
 ├── #306  fix/issue-67 (9bc9c97)                      ── independent; 2 security blockers
 └── feat/deepseek-orchestrator-hardening (87031da)   ── e6e24db (DeepSeek) + 87031da (OathNet/breach = contamination)
```

### Unresolved review threads
- **#306 · P1** (`src/main.tsx:29`) — `record.url = location.href` persists full URL incl. query+fragment; OAuth/recovery callbacks carry `code`/token material into `client_errors`. **Open.**
- **#306 · P2** (migration `:36`) — `WITH CHECK (true)` lets any anon-key caller insert rows with an arbitrary `user_id`; client-supplied `getSession()` id is not enforced. **Open.**
- #304, #305, #307 — one bot summary comment each; **no unresolved blocking review threads**.

---

## 2. P0 — Combined #305/#307 release tree audit  ✅ GREEN (executed locally)

`fbd1681` (#305 head) **is an ancestor of** `8d5714f` (#307 head), so the exact combined
tree is **just #307's head** — no merge commit needed. Audited in worktree
`audit/combined-305-307` @ `8d5714f`.

**Frontend gates (executed locally, this session):**
- `npm run typecheck` → clean
- `npm run lint` → 0 errors (9 pre-existing shadcn `react-refresh` warnings)
- `npm run test:coverage` → **82 files / 970 tests passed** (matches #307's claim)
- `npm run build` → success (~10s)

**Migration gates — EXECUTED against a real local Postgres 16** (replicating CI's
`migrations` job exactly: shim → 39 migrations in order → 4 SQL suites → concurrent race →
idempotency):
- All **39 migrations applied cleanly**.
- `content-hash-compat-test.sql` → PASS (chain valid, dedup logs every custody observation)
- `artifacts-integrity-test.sql` → PASS (confidence bounds; source is NOT a scope; distinct platforms preserved)
- `artifacts-selector-scope-test.sql` (756 lines) → PASS (identity contract, reviews, lineage)
- `concurrent-dedup-test.sh` → PASS (two racing sessions, exactly 1 survivor on the uidx)
- idempotency re-run → PASS (re-apply newest migration + re-check chain)

**The 16 required dimensions — all asserted by the passing suites + grants query:**

| # | Dimension | Evidence |
|---|---|---|
| 1 | same value, distinct platforms → distinct | integrity + selector-scope Part F |
| 2 | same value, distinct subjects → distinct | selector-scope L140 `RAISE EXCEPTION '(3) distinct subject_id was collapsed'` |
| 3 | distinct breaches on one host → distinct | Part F (`breach:` outranks host; unnamed → per-observation md5) |
| 4 | same breach, different tools → merges | Part F ("same named breach from two tools still merges") |
| 5 | Twitter/X aliases canonicalize (only intended) | scope fn alias table; other platforms stay distinct |
| 6 | source name = provenance, not identity | integrity ("source is NOT a scope"); merge unions provenance |
| 7 | evidence repoints, hash chain byte-identical | content-hash-compat PASS; **prod: 0 evidence rows repoint** (§3) |
| 8 | matching verdicts preserve notes + lineage | Part G1 (both notes preserved, full lineage) |
| 9 | conflicting verdicts → recheck + lineage | selector-scope L171 `RAISE EXCEPTION` if not `recheck` |
| 10 | A+B then survivor+C keeps A,B,C | Part G2 (3-way keeps all triples, deterministic `[A,B,C]`) |
| 11 | second consolidation ≠ duplicate lineage | Part G2 append-only; idempotent re-run |
| 12 | ordering deterministic | Part G2 (`ORDER BY created_at, id`) |
| 13 | public/anon/authenticated cannot merge | grants query: `merge_artifact_into`, `artifact_consolidate_dupes` = **service_role only** |
| 14 | service_role can merge | grants query: both grant EXECUTE to `service_role` |
| 15 | cross-thread & cross-user merges fail | Part D L401-424 (both rejected, no partial mutation) |
| 16 | migration is idempotent | idempotency re-run PASS |

**Not runnable locally:** edge Deno suite (`deno` uninstallable — egress blocks `dl.deno.land`).
Relied on CI's **`Edge functions (deno test)` = success** on `8d5714f`.

**Survivor rule:** earliest `(created_at, id)` wins. **Postconditions abort/rollback the whole
migration transaction** if any dup group with count>1 survives, or if any `evidence_log` /
`artifact_reviews` row would dangle — a hard fail-safe.

---

## 3. P0 — Production read-only migration impact  ✅ (read-only-prod, via Lovable connector)

Live-health curl is egress-blocked, but the Lovable connector (project
`4ce11bc3…`, database `enabled`, stack `supabase`) reaches the production DB. All queries
below are **aggregate-only SELECTs** — no row-level PII extracted, no DDL, no temp objects,
no locks beyond ordinary reads. The dedup identity was reproduced by inlining the migration's
exact `artifact_selector_scope` expression + the index tuple.

| Metric | Production value |
|---|---|
| Total artifacts (before) | **6,889** |
| Distinct identity keys (after) | **6,387** |
| Rows that consolidate | **502** |
| Duplicate groups | **376** |
| Confidence < 0 / > 100 | **0 / 0** (NOT VALID constraint safe on existing rows) |
| NULL confidence | 83 (**allowed** — `BETWEEN` yields NULL, which a CHECK treats as satisfied) |
| Distinct platforms / subjects / threads | 197 / 269 / 154 |
| Analyst reviews on collapsing groups | **53** |
| — of which on a **loser** (repointed) | **1** |
| — of which on the **survivor** (untouched) | **52** |
| Reviews discarded | **0** |
| Evidence rows repointed (on losers) | **0** (of 6,396 total) |

**This independently reproduces the #307 simulation** (6,889 → 6,387; 502 across 376) and is
strictly *safer* than the PR table implied: only **1** review actually repoints and **0**
evidence rows move — the hash chain is literally untouched. The task said not to repeat the
sim figures as fresh proof "until you rerun the read-only audit"; this **is** that rerun.

**Prod migration state (read-only):** `merge_artifact_into`=absent, `artifacts_selector_scope_uidx`=absent,
`client_errors` table=absent → neither the dedup nor the telemetry migration has run in prod.

---

## 4. P0 — DeepSeek deployment truth  ⚠️ NOT PROVABLY DEPLOYED

**Cannot read the live build:** egress proxy returns an org-policy `403 CONNECT` for
`skzqwbyvmwqarfgfvyky.supabase.co` (a policy denial — not retried per proxy rules). So the
one true proof (a moved health build SHA) is **unavailable from this environment**.

**What is established from code + the Lovable message log:**
- Mirror `build-info.ts` (HEAD `0bdc5ed6`) = **`4692afa`**, unchanged since 2026-07-11. Mirror
  HEAD is *ahead of* that stamped short-SHA → **code moved without re-stamping** (drift trap).
- Mirror `health-handler.ts` has **no `checks.deepseek`** block (probes minimax/grok/gemini only;
  `version 1.2.2`). So the health endpoint could not confirm DeepSeek even if reached.
- Mirror `orchestrator_select.ts` **does** carry DeepSeek-first precedence
  (`pin > deepseek > minimax > grok/openadapter`) — matches the required precedence.
- Lovable edit history (read in full): `deepseek-chat` → `v4-pro` → `v4-flash` (commit
  `9335ccd`) → **`v4-pro` + `parallel_tool_calls:false` + `thinking:disabled`** (latest, **no
  commit SHA, no build stamp**). Deployed **directly** via the Lovable agent's
  `supabase--deploy_edge_functions`, **bypassing** the canonical stamp→mirror→verify recipe.
  `DEEPSEEK_API_KEY` + `ORCHESTRATOR_PROVIDER=deepseek` set; `DEEPSEEK_ORCHESTRATOR_MODEL_ID`
  **not** set (code default `v4-pro` governs). This matches the required canary config, BUT:
  - **No automatic Gemini fallback** for DeepSeek — a DeepSeek 5xx surfaces as a raw stream
    error (unbounded, unobservable). *(Lovable agent flagged, did not fix.)*
  - **No DeepSeek per-token cost accounting** — cost counters are still MiniMax-named.

**Two divergent DeepSeek implementations exist:**
1. **Lovable-editor version** — possibly live (secrets + direct deploy) but **unstamped,
   unverifiable, minimal** (no health diagnostic, no bounded fallback, no cost accounting).
2. **Git branch `e6e24db`** — more complete (adds `checks.deepseek`, env/orchestrator changes,
   tests) but **not merged, not deployed**, and its tip `87031da` adds **OathNet + breach-value**
   work (scope contamination).

**Verdict:** Do **not** claim DeepSeek is verifiably live. The build marker never moved; the
live endpoint is unreadable here; and the git-hardening branch is neither merged nor deployed.

---

## 5. PR #304 reassessment (P1)

- **0 file overlap** with #305/#307 (touches `attachment-intake.ts` + `providers.ts`; #305 touches
  `index.ts`/`anchor-intake.ts`/`tool-registry.ts`). Rebases cleanly onto main **or** the combined tree.
- The abort fix is **not** present elsewhere on main (verified against #305 file list).
- The 2 reported edge failures (`crash_resilience` T1, `gemini_parallel_pairing` L1) are
  **local-env/network flakiness** — #304's CI `Edge functions (deno test)` is **green**.
- Fix-4 recovery is a **one-shot** "read it yourself" directive (jina/gemini), **not** a retry
  loop — bounded worst case is one extra doc read. Low runaway risk.
- **Recommendation: keep — narrow, independently-mergeable backend safety fix.** (Merge is a
  frontend-no-op; it ships only via the backend mirror-sync + Lovable deploy path.)

---

## 6. P2 — remaining open-PR triage (report only, not actioned)

| PR | Title | Verdict |
|---|---|---|
| #119 | breach-metadata laundering guard in evidence caps | **requires user decision** — integrity-adjacent; likely superseded by later source-classification/threat_intel work; verify before keep |
| #198 | self-service account deletion (F14/F15) | **keep / rebase** — discrete; possible beta/GDPR requirement; not this session |
| #233 | beta demo video render scripts | **close or defer** — tooling only; a demo mp4 already exists in-repo |
| #242 | backport live `/mcp` edge fn from mirror | **keep / rebase, needs review** — backend backport; not beta-critical |
| #248 | OSINT pipeline **full refactor** | **HOLD / likely close** — broad refactor; explicitly must not enter the beta accidentally |
| #278 | grade evidence beyond `soft` (C-3) | **HOLD for separate review** — larger integrity feature; stacked with #279; not beta-critical |

---

## 7. Recommended sequencing (pending JD approval — nothing done yet)

**Merge order**
1. **#307 only** (it already contains all of #305). Merging #305 separately, or before #307
   folds in, would ship the destructive migration. Close #305 as *superseded-by-#307*, or
   retarget #307 → `main` and merge it as the single unit.
2. **#304** — independently, any time (no overlap).
3. **#306** — only after both security blockers are fixed + tested (§decisions).
4. DeepSeek — a **clean `e6e24db`-only PR onto main** (`cherry-pick e6e24db`), leaving OathNet/breach
   (`87031da`) as a separate reviewed change.

**Migration order (backend, after #307 merges to main — requires explicit DB approval):**
1. Stamp `build-info.ts` (`npm run stamp:build`) + commit.
2. Read-only re-confirm impact (§3 query) immediately pre-apply.
3. Apply `20260711130000_artifacts_confidence_bounds_and_dedup.sql` **inside its own transaction**
   — its postconditions self-abort on any dangling review/evidence. It takes brief
   `ACCESS EXCLUSIVE` on `artifacts` for the unique-index build; schedule off-peak.
4. Surgical mirror sync of the changed `osint-agent` files → explicit Lovable deploy → verify
   the health build SHA **moved**.

**Rollback plan**
- **Migration:** the consolidation runs in one transaction with self-aborting postconditions →
  a failed apply rolls back with **zero** persisted change. Post-apply, the merge is
  non-destructive at the evidence layer (0 evidence repoints in prod); reviews are repointed,
  not deleted. A full logical rollback of a completed dedup is **not** trivial (rows are merged),
  so the guard is *pre*-apply verification (§3) + the transaction boundary, not post-hoc revert.
  Take a DB snapshot/PITR checkpoint before applying.
- **Frontend:** revert the merge commit on `main` → Vercel redeploys the prior build.
- **Edge/DeepSeek:** re-deploy the last-known-good `osint-agent` via Lovable; set
  `ORCHESTRATOR_PROVIDER=minimax` (or unset `DEEPSEEK_API_KEY`) to fall back off DeepSeek instantly.

---

## 8. Decisions required from JD

1. **Combined #305/#307** — audit is green (local frontend + real-PG migration + read-only prod
   impact all confirmed). Approve merge-prep (retarget #307→main, close #305 as superseded), or hold?
2. **DeepSeek** — split a clean `e6e24db`-only PR onto main (recommended), audit the mixed branch, or hold?
   Separately: DeepSeek may be live-but-unverifiable as the beta orchestrator with **no bounded
   fallback** — accept for the canary, or revert to MiniMax until hardening (`checks.deepseek` +
   fallback) is merged?
3. **PR #304** — approve as an independent safety fix (rebase onto the release tree or land standalone), or hold?
4. **PR #306** — authorize the two security fixes (URL sanitize + RLS `user_id = auth.uid()` + size caps +
   tests), or hold?

**Nothing is merged, migrated, mirror-synced, or deployed. No production write occurred.**
