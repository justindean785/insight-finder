# Insight Finder — Extensive Audit (Static + Config Path)

Date: 2026-06-04
Auditor: Hermes
Scope: frontend (`src/**`), Supabase edge function (`supabase/functions/osint-agent`), DB migrations (`supabase/migrations/**`), project config.

> Method note: this audit is grounded in source inspection and config checks. Runtime E2E execution was not possible in this environment due missing Node runtime, so dynamic findings are listed as validation steps.

---

## 1) Executive verdict

**Overall status:** `CONDITIONALLY READY`  
**Primary blocker category for “can’t scan”:** auth/function invocation path and backend secret readiness, not UI rendering.

### Highest-probability failure chain
1. User not authenticated or expired session → edge returns **401 Unauthorized**.
2. Thread mismatch/not owned by user → edge returns **403 Forbidden**.
3. Orchestrator keys missing (`MINIMAX_API_KEY` and `LOVABLE_API_KEY`) → runtime error before successful scan completion.
4. Function URL misconfiguration (project-id-only construction) could silently point to wrong host in some setups (patched in this audit).

---

## 2) Confirmed findings (with evidence)

## Critical / High

### F-01 — Scan requires auth header; no auth = hard 401 (expected, but user-facing ambiguity)
- **Evidence:** `supabase/functions/osint-agent/index.ts:1439-1450`
- Function rejects requests missing `Authorization` and rejects invalid session.
- **Impact:** User sees “can’t scan” when auth expired/not present.
- **Confidence:** High
- **Recommended control:** show explicit frontend toast when function returns 401/403; route to `/auth` on 401.

### F-02 — Thread ownership enforcement returns 403 on mismatch
- **Evidence:** `supabase/functions/osint-agent/index.ts:1458-1466`
- `threadId` must exist and belong to `auth.uid()`.
- **Impact:** stale/deleted/copied thread IDs fail all scans.
- **Confidence:** High
- **Recommended control:** if 403, prompt “thread not owned or missing” and auto-create fresh thread fallback.

### F-03 — Orchestrator hard dependency: MiniMax or Lovable key must exist
- **Evidence:** `supabase/functions/osint-agent/index.ts:5089-5097`
- If MiniMax unavailable and Lovable fallback unavailable, function throws.
- **Impact:** scan cannot run at all despite valid UI/auth.
- **Confidence:** High
- **Recommended control:** startup health check endpoint/tool that reports orchestrator readiness before first scan.

---

## Medium

### F-04 — Frontend function URL was too rigid (project-id derived only)
- **Evidence (pre-patch):** `src/components/ChatWindow.tsx` constant URL built only from `VITE_SUPABASE_PROJECT_ID`.
- **Fix applied:** URL now built from `VITE_SUPABASE_URL` first, fallback to project id, plus explicit missing-config toast.
- **Impact:** wrong host risk / opaque failure reduced.
- **Confidence:** High

### F-05 — Generic user failure messaging for transport errors
- **Evidence:** `src/components/ChatWindow.tsx` send path catches and toasts generic failure.
- **Impact:** “doesn’t scan” reports without precise remediation.
- **Confidence:** High
- **Recommended control:** map statuses (401/403/404/429/5xx) to explicit analyst actions.

### F-06 — README is template-level; missing operational runbook for this app
- **Evidence:** `README.md` still generic Lovable boilerplate.
- **Impact:** onboarding/setup drift; higher misconfig risk.
- **Confidence:** High
- **Recommended control:** add project-specific sections: env vars, Supabase function deploy, required secrets, smoke tests.

---

## Low / Observations

### F-07 — RLS posture appears correctly scoped for core tables
- **Evidence:** `supabase/migrations/20260526140844_*.sql`
- `threads/messages/artifacts` have RLS and user-bound policies.
- **Impact:** positive control; reduces cross-tenant leakage risk.
- **Confidence:** High

### F-08 — SSRF hardening present for URL fetch pathways
- **Evidence:** `assertSafeUrl` in edge function (`index.ts:730-735`) blocks non-http(s) and private/internal hosts.
- **Impact:** positive control for crawler-like tools.
- **Confidence:** High

### F-09 — Surface area is large (tool-heavy orchestrator)
- **Evidence:** edge function file ~5.3k LOC and many external API branches.
- **Impact:** degraded-tool handling complexity; test matrix needs formalization.
- **Confidence:** High

---

## 3) Scan-path architecture check

Client scan path:
1. `ChatWindow` creates `DefaultChatTransport` with function URL.
2. Adds Supabase auth bearer from `supabase.auth.getSession()`.
3. Sends `{ threadId, messages }` to edge function.

Server scan path:
1. Validates auth header and user session.
2. Validates `threadId` ownership.
3. Persists message, resolves orchestrator model (MiniMax or Lovable fallback).
4. Executes tool chain and streams output.

**Assessment:** architecture is coherent; most “can’t scan” failures are expected gate failures without explicit UX guidance.

---

## 4) Secrets and config readiness matrix

Frontend `.env` presence check (local):
- `VITE_SUPABASE_PROJECT_ID`: present
- `VITE_SUPABASE_PUBLISHABLE_KEY`: present
- `VITE_SUPABASE_URL`: present

Edge function required-at-runtime for successful orchestration:
- **At least one:** `MINIMAX_API_KEY` or `LOVABLE_API_KEY`
- Plus optional tool keys depending on selected toolset (`OATHNET_API_KEY`, `EXA_API_KEY`, `HUNTER_API_KEY`, etc.)

**Risk:** missing optional keys are handled per-tool; missing orchestrator keys are fatal.

---

## 5) Priority remediation plan

## P0 (fix now)
1. Add explicit transport status mapping in `ChatWindow`:
   - 401 → “Session expired. Sign in again.”
   - 403 → “Thread access denied. Open/create your own thread.”
   - 404 → “Edge function not deployed.”
   - 500 → “Backend error. Check function logs.”
2. Add edge readiness check command/runbook:
   - verify `MINIMAX_API_KEY` or `LOVABLE_API_KEY` before scanning.
3. Add project README operational section (non-template) with exact setup/deploy/smoke-test commands.

## P1
1. Add `/health`-style edge probe function for frontend preflight.
2. Add structured error envelope from edge instead of plain string responses.
3. Add integration tests for auth/thread/orchestrator-fallback branches.

## P2
1. Split `osint-agent/index.ts` into modules (auth, tools, orchestration, persistence).
2. Add per-tool capability negotiation sent to frontend at session start.

---

## 6) Validation checklist (run locally)

1. Auth test
   - Sign out and attempt scan → expect explicit 401 UX guidance.
2. Thread ownership test
   - Use invalid/foreign thread id → expect explicit 403 guidance.
3. Function deploy test
   - Hit function endpoint directly; verify non-404.
4. Orchestrator readiness test
   - Confirm at least one of `MINIMAX_API_KEY` / `LOVABLE_API_KEY` set in Supabase secrets.
5. End-to-end scan
   - Create new thread, submit seed, confirm streamed assistant output + artifacts.

---

## 7) Change made during this audit

Patched `src/components/ChatWindow.tsx`:
- Function URL derivation now prefers `VITE_SUPABASE_URL`, falls back to `VITE_SUPABASE_PROJECT_ID`.
- Added explicit missing-function-url toast and early return.
- Prevents silent misroute in mixed env setups.

---

## 8) Audit confidence

- **Code-level findings:** High
- **Runtime behavior findings:** Medium (not executed in this environment)
- **Overall confidence:** **High** on root-cause classes; **Medium** on exact live instance failure without local runtime logs.
