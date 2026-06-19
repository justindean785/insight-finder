# Remediation audit — verify & close the loop (2026-06-19)

Standalone verification pass for Insight Finder / Swarmbot. Goal: prove the
remaining unproven items from the root audit, not redo the whole audit.

## Current state (as found)

- Branch: `claude/insight-finder-audit-verify-x7cmg6`.
- Source-of-truth repo `insight-finder` and the Lovable deploy mirror
  `seeker-spark-search-5362c57c` were compared.
- **Live edge marker:** `2026-06-19-status-aliases-tightened` (carried by the
  mirror, which is what Lovable actually deploys).
- **Source drift found:** `insight-finder` `index.ts` carried the older marker
  `2026-06-16-runtime-dorks-serus`. A byte diff of `osint-agent/index.ts` (local
  vs mirror) shows the **only** difference is the marker string — the runtime
  logic is identical. Reconciled the local marker to `2026-06-19-...` so source
  reflects what is live. (No backend deploy performed by this pass.)
- Network egress: the live Supabase host
  `skzqwbyvmwqarfgfvyky.supabase.co` is **not in this environment's allowlist**,
  so a live health hit and a real production investigation probe cannot run from
  here. Documented as an environment blocker + manual checklist for JD.

## Remaining tasks

- [x] **T1** Legacy NULL artifact `metadata.status` is safe (UI/report).
- [~] **T2** Two-user Realtime RLS negative test — cannot run live (no 2 auth
      accounts + host not allowlisted). Verified the real protection in source;
      produced a copy-paste manual checklist for JD.
- [~] **T3** Production investigation runtime probe — blocked by network egress.
      Verified equivalently against source (live code == source). Manual probe
      checklist for JD.
- [x] **T4** No remaining hard max-limit blockers.
- [x] **T5** Verification commands (build + vitest). Deno edge tests: blocked
      (no deno + install host 403); logic is mirrored into vitest and runs.
- [x] **T6** Deploy rules — no backend deploy needed (frontend-only change).

## Verification checklist

- [x] `record_artifacts` accepts array / stringified array / fenced / single
      object, then validates strictly (`coerceArtifactsInput`, the live
      preprocess) — unit-tested in vitest.
- [x] NULL/missing `metadata.status` never renders raw null, never reads as
      verified/confirmed, never crashes UI or report — 4 new tests added.
- [x] Runtime caps default to UNLIMITED; budget enforcement only fires when
      `STOP_ON_BUDGET_EXHAUSTED` is explicitly set; recording tools bypass caps;
      concurrency QUEUES (never final-fails) — unit-tested.
- [x] `npm run build` clean.
- [x] `npx vitest run` green (618 tests).
- [x] Real protection for the app's actual realtime usage (`postgres_changes`)
      is user-scoped table RLS on threads/messages/artifacts (in source).

## Results

### T1 — NULL artifact status is safe ✅
- The analyst-facing status is **derived** (`evidence-status.ts` →
  `labelForArtifact`, confidence/source-class driven). It **never reads
  `metadata.status`**. Grep confirms no component renders raw `metadata.status`;
  `buildReportMarkdown` doesn't read `.status` either.
- Backend `deriveStatus` treats a null/legacy `requested` status by falling
  through to evidence-based derivation — a missing status can never yield
  `verified`/`confirmed` (those require earned ≥90 + 2 independent classes).
- Added 4 explicit tests to `src/test/evidence-status.test.ts`: `metadata:null`,
  `metadata.status:null`, `status:undefined`, and rank-safety. All assert no
  raw `null`/`undefined` text and never a trusted (verified/probable) status.

### T2 — Realtime RLS ⚠️ needs JD's two-account live test
- The app's realtime hooks (`useThreadArtifacts`, `useThreadToolActivity`) use
  **`postgres_changes`** channels filtered by `thread_id`, NOT topic-based
  broadcast. Their security is enforced by **table RLS**
  (`auth.uid() = user_id` on `public.threads/messages/artifacts`) — present in
  `supabase/migrations/20260526140844_*.sql`. Under that RLS, User B cannot
  receive User A's artifact/message change events.
- The topic-based `realtime.messages` policy from the audit (user:/thread:
  topics) is **defense-in-depth not currently exercised** by the frontend, and
  is **not in source control** (applied live only). It still needs JD's true
  two-user negative test. See manual checklist below.

### T3 — Production probe ⚠️ blocked by egress
- Could not hit `…supabase.co/functions/v1/osint-agent?health=1` (host not in
  allowlist) and could not run a live investigation. Verified equivalently:
  live `index.ts` is byte-identical to source except the marker, so the runtime
  caps / coercion / status logic proven by tests here is exactly what runs live.
- Manual probe checklist for JD below.

### T4 — No hard max-limit blockers ✅
- `runtime-policy.ts`: `runtimeLimits` defaults every cap to
  `Number.POSITIVE_INFINITY`; `stopOnBudgetExhausted` defaults `false`. `startCall`
  only refuses when budget enforcement is explicitly enabled AND the cap is finite
  AND exceeded, and the reason text explicitly says "internal throttle, not a
  provider limit". `record_artifacts`/`record_finding`/`record_report` are in
  `ALWAYS_ALLOW_TOOLS` → never throttled. Concurrency over `maxParallelTools`
  QUEUES with escalating backoff (`allow:true, waitMs>0`), never a final failure.
  Same-tool overflow → cooldown spacing, not refusal. Real provider 429 is the
  only thing labeled a rate limit.
- The `MAX_TOOL*` hits in `index.ts` are context-window char limits
  (`MAX_TOOL_RESULT_CHARS_*`), not call caps. Confirmed.
- Covered by `src/test/runtime-policy.test.ts` (unlimited default, essential
  bypass under exhausted budget, queue-not-fail concurrency).

### T5 — Verification commands ✅
- `npx vitest run` → **50 files / 618 tests pass** (was 614; +4 NULL-status).
- `npm run build` → clean (`✓ built in ~7s`).
- Deno edge tests: `deno` not installed and install host returns 403 (egress).
  The integrity-critical edge modules (`runtime-policy.ts`, `validation.ts`,
  `confidence.ts`) are env-guarded and imported directly into vitest, so their
  behavior is exercised in the JS test run above.

### T6 — Deploy ✅ no backend deploy needed
- Only changes: a frontend test + a backend **marker string** reconciliation.
- No osint-agent logic changed → no Lovable deploy required. Live function is
  already at `2026-06-19-status-aliases-tightened`. Frontend test ships to Vercel
  on merge with no runtime impact.

## Manual checklist for JD (user-side, requires 2 accounts)

### Realtime RLS two-user negative test
1. Account A: run an investigation; note its thread id `T` and uid `UA`.
2. Account B (separate browser/profile): authenticate.
3. In B's devtools console, attempt a `postgres_changes` subscribe to A's data:
   `supabase.channel('x').on('postgres_changes',{event:'*',schema:'public',table:'artifacts',filter:'thread_id=eq.<T>'},console.log).subscribe()`
   → **Expected: zero rows/events** (table RLS blocks A's rows for B).
4. If you also use broadcast/topic channels, subscribe B to `thread:<T>` and
   `user:<UA>` → **Expected: denied / no messages** (the `realtime.messages`
   topic policy).
5. Confirm B never sees A's artifacts/messages in the UI.
6. **Also: commit the `realtime.messages` RLS policy to `insight-finder`
   `supabase/migrations/` so it is reproducible** (currently live-only).

### Production runtime probe (run from an allowlisted network)
1. `GET …/functions/v1/osint-agent?health=1` → expect
   `build: "2026-06-19-status-aliases-tightened"`.
2. Run a harmless seed; confirm: run is not stopped by a 12 paid-call cap, no
   arbitrary max kills it, throttles queue/retry, `record_artifacts` succeeds,
   final report generates, free/local tools still run after paid tools stop,
   gated tools show as gated (not failed), failed providers aren't recorded as
   evidence, breach/username findings read as observed associations.
</content>
</invoke>
