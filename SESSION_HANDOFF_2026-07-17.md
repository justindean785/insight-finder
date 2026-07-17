# Session Handoff — 2026-07-17 (prod audit + calibration milestone)

Pre-compaction handoff. Two PRs merged this session; the biggest open item is that
**two deploy steps have NOT been done** (edge-function deploy + prod DB migration).
Read §3 first.

---

## 1. TL;DR — current state

- **Merged to `main`:**
  - **PR #338** (`e078edd`, merge `fc268bb`) — honest tool-health taxonomy + provider error normalization + timeout/nudge fixes.
  - **PR #339** (`2a540b3`→`f24b634`, merge `2203dae`) — calibration + ground-truth capture (instrumentation-only).
- **Frontend of both PRs is LIVE** (Vercel ships `main` automatically).
- **NOT live yet (the two open deploy steps):**
  1. **PR #338 backend edge-function changes** (osint-agent classifier/timeout/nudge) — need the Lovable edge-function deploy recipe (CLAUDE.md). Build marker still old.
  2. **PR #339 DB migration** (`analyst_feedback_events`) — **not applied to the production Supabase DB**, so calibration collects nothing until applied.
- Working branch `claude/insight-finder-prod-audit-b3yddb` is reset to `origin/main` (both PRs already in main). Restart from main for any new work.

---

## 2. What shipped

### PR #338 — Tool health / provider errors / timeouts
Root-caused from **live production `tool_usage_log` data** (read-only via the Lovable
MCP `query_database`). The `failed` bucket conflated 6 different things (timeout,
cancelled, rate-limited, 403/451, config/bad-key, governance skips) + 137 opaque
null-error rows.

- **`src/lib/tool-outcome.ts`** — NEW canonical 11-category taxonomy
  (`success/empty/skipped/cancelled/timeout/rate_limited/http_denied/blocked/config_error/failed/unknown`),
  `needsAttention` (only config/failed/unknown), `normalizeProviderError` (no bare HTTP codes).
- **`src/hooks/useThreadToolHealth.ts` + `src/components/panel/ToolHealthPanel.tsx`** —
  re-derive the canonical category from the stored `error_msg`/`status_code`, so
  timeouts read Degraded (amber), governance Skipped, opaque Unknown — **and this
  fixes historical mis-stored rows at read-time**, so the analyst-facing "lying"
  is fixed by the FRONTEND alone (ships via Vercel, no backend deploy needed).
- **Backend `supabase/functions/osint-agent/tool-outcome.ts`** — fixed the skip
  regex (`already ran for this entity`, `guard not met`, `internal paid-call cap`,
  `internal throttle`) + added `classifyDetailedOutcome`/`normalizeProviderError`
  mirrors. Corrects the STORED coarse outcome + circuit breaker (ships on next edge deploy).
- **`cache.ts`** — `minimax_plan_pivots` given a 20s timeout (was 12s default → 10× timeouts).
- **`tool-registry.ts`** — correlate auto-fire nudge counter now resets in a `finally`
  on ANY attempt, so a timed-out `minimax_correlate` stops re-latching the nudge
  ("timed out 3× in one investigation").

### PR #339 — Calibration + ground-truth capture (instrumentation-only)
Changes NO live confidence/tier/cluster/orchestration behavior. Captures durable
analyst ground truth so confidence becomes measurable.

- **`supabase/migrations/20260717000000_analyst_feedback_events.sql`** — append-only,
  hash-chained event table; `record_analyst_feedback()` SECURITY DEFINER (analyst_id
  from `auth.uid()`, thread+artifact ownership, idempotency, advisory lock);
  RLS (own-rows read, write only via RPC, UPDATE/DELETE/TRUNCATE blocked for all
  roles); read-only `security_invoker` calibration views + `GRANT SELECT` to authenticated.
- **`src/lib/calibration.ts`** — pure Brier/ECE/reliability/precision-by-band/
  rate-by-group/false-confirmation/false-link, each with sample size + Wilson interval.
- **`src/lib/analyst-feedback.ts`** — `CONFIDENCE_MODEL_VERSION` + best-effort writer.
- **`src/lib/review.ts` + `EvidenceMatrixTab.tsx` + `ResourcesPanel.tsx`** — emit events
  on confirm/key/recheck/dismiss/wrong, **retract on reset**, and an implicit confirm
  when a note first reviews an artifact. Passes confidence/source so events land in
  band calibration.
- **`supabase/tests/analyst_feedback_events_test.sql`** — 17 behavioral assertions.

**Verified (PR #339):** 981/981 vitest; typecheck+eslint+build clean; migration
applies on real PG15; behavioral 17/17 (RLS both directions, immutability incl.
TRUNCATE, idempotency, 2-writer concurrency `chain_breaks=0`, hash chain, retraction);
rollback clean. All 4 CI checks green on `f24b634`.

---

## 3. WHAT'S LEFT — the two deploy steps (important)

### 3a. Apply the PR #339 DB migration to production
`analyst_feedback_events` is on `main` but **not in the prod Supabase DB**. Until
applied, the frontend writer's `record_analyst_feedback` RPC calls no-op (best-effort,
swallowed) and no calibration data accrues.
- Apply `supabase/migrations/20260717000000_analyst_feedback_events.sql` via the
  normal Supabase migration path, **or** directly via the Lovable DB connection
  (`query_database` on project `4ce11bc3-039d-4439-b293-acacca9e1e3a`). It is
  idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS) and additive.
- Verify: objects exist; `SELECT` on `v_calibration_by_band` works as authenticated;
  RLS confines rows. (End-to-end RPC test needs a real signed-in analyst — the
  admin/service connection has `auth.uid()=null` and will get "must be authenticated".)
- Rollback: the commented down block at the migration's tail (verified clean).

### 3b. Deploy the PR #338 backend edge-function changes
The osint-agent changes (`tool-outcome.ts`, `cache.ts`, `tool-registry.ts`) are on
`main` but **not deployed** to the Lovable-owned Supabase edge function. Follow the
CLAUDE.md recipe: `npm run stamp:build` + commit `build-info.ts` → surgical mirror
sync of the 3 changed files to `seeker-spark-search-5362c57c` → **explicit Lovable
deploy** (send to project `4ce11bc3-...`) → verify `/health` `build` SHA moved.
- **Note:** the analyst-facing tool-health "lying" is ALREADY fixed by the frontend
  (Vercel), which re-derives from stored columns. This edge deploy only lands the
  STORED-outcome + circuit-breaker refinement (correct classification at write time
  + the plan_pivots timeout + the correlate nudge fix). Lower urgency, but needed
  for the circuit/timeout fixes to take effect.

---

## 4. How the built systems work

- **Canonical tool outcome:** ONE taxonomy (`src/lib/tool-outcome.ts`, mirrored in
  the edge `tool-outcome.ts`). The health panel refines the coarse stored
  `outcome` + `error_msg` + `status_code` into the 11 categories; "needs attention"
  is only config/failed/unknown. Timeouts/rate-limits/denials are Degraded, not red.
- **Calibration capture:** analyst action → `useReviewStates.set/setNote` (unchanged
  display state in `artifact_reviews`) → best-effort `recordAnalystFeedback` → RPC
  appends an immutable event → `v_analyst_feedback_resolved` (DISTINCT ON latest seq,
  never mutates history) → `v_analyst_feedback_clean` (excludes unresolved/
  contradictory) → `src/lib/calibration.ts` computes Brier/ECE/precision-by-band.
  Confidence is untouched — this only measures.

---

## 5. Audit backlog (documented, NOT implemented) + next milestone sequence

Full audit: **`docs/PROD_AUDIT_2026-07-17.md`** (all 12 original issues, prod
evidence, next-PR sequence). Confidence deep-dive: **`docs/CONFIDENCE_ENGINE.md`**.
Calibration design: **`docs/CALIBRATION_MILESTONE.md`** (§11 = the deferred
prediction/context snapshot spec).

Agreed next-milestone order (owner-approved):
1. **Username-merge integrity fix** — wire the DEAD `merge_guard.ts` + `isGenericHandle`
   into the live `lib/cluster.ts` merge (a shared common username can currently
   merge unrelated people). Use PR #339's `falseLinkRate` as before/after.
2. **Server-authoritative confidence consolidation** — FIRST task = the authoritative
   prediction + investigation-context snapshot at backend scoring time
   (`docs/CALIBRATION_MILESTONE.md §11`); then collapse the four parallel confidence
   systems into one log-odds engine with analyst-confirmation as a **Bayesian source
   whose reliability is read from calibration**, not the current `+20` (which is also
   explained as `+15` — a real bug). Fix the numeric-tier independence gate + the
   `meta.reviewed`→CONFIRMED hole (verify write path first).
3. **Confidence implementation + migration** (bump `CONFIDENCE_MODEL_VERSION`).
4. **Tool reward + EIG instrumentation** (all EIG inputs already exist: `gradeConfidence`,
   `auditCoverage`, `distinctSourceClasses`, `costForTool`).
5. **Strategy learning + cross-investigation memory.**

Also open from PR #338's audit: circuit 1-strike suppression is too aggressive
(→ 2-strike + per-investigation persistence); p95-driven adaptive timeouts; report
Tool-Reliability/Recommended-Next-Pivots sections; risk model is harm-narrow.

---

## 6. Environment / verification constraints (for the next session)

- **Network:** egress policy blocks `*.supabase.co` (curl → 403 CONNECT). Can't hit
  the live edge/health endpoint or run live investigations from the sandbox.
- **Production DB IS reachable** read/write via the Lovable MCP `query_database`
  (project `4ce11bc3-039d-4439-b293-acacca9e1e3a`) — this was the source of prod evidence.
- **`deno` binary download is blocked** — verify edge pure functions by compiling with
  esbuild (`node_modules/esbuild`) and running the output; CI's deno job is the real gate.
- **Local PostgreSQL 15 IS available** for migration proof: run as the `postgres` OS
  user via `runuser -u postgres`, short socket dir (e.g. `/tmp/pgs`), apply
  `.github/ci/supabase-platform-shim.sql` then all `supabase/migrations/*.sql` in
  `sort -t_ -k1,1` order, then `supabase/tests/analyst_feedback_events_test.sql`.
- **Edge-function deploy is gated** by Lovable ownership (see CLAUDE.md deploy topology).

---

## 7. Key files
- Audit/docs: `docs/PROD_AUDIT_2026-07-17.md`, `docs/CONFIDENCE_ENGINE.md`, `docs/CALIBRATION_MILESTONE.md`.
- Tool outcome: `src/lib/tool-outcome.ts`, `src/hooks/useThreadToolHealth.ts`, `src/components/panel/ToolHealthPanel.tsx`, edge `supabase/functions/osint-agent/tool-outcome.ts`.
- Calibration: `src/lib/calibration.ts`, `src/lib/analyst-feedback.ts`, `src/lib/review.ts`, `supabase/migrations/20260717000000_analyst_feedback_events.sql`, `supabase/tests/analyst_feedback_events_test.sql`.
- Confidence (backlog): `supabase/functions/osint-agent/confidence.ts`, `tiers.ts`, `source-classification.ts`; `src/lib/intel.ts`, `review.ts`, `confidence-tier.ts`.
- Cluster (backlog): `supabase/functions/osint-agent/lib/cluster.ts`, `merge_guard.ts` (dead), `graph.ts`.
