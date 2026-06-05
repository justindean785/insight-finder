# Insight Finder — Beta Readiness Audit

**Date:** 2026-06-05
**Auditor:** Hermes (independent review pass)
**Scope:** Beta-readiness of the Insight Finder platform for public/limited-beta release.
**Method:** Static analysis (tsc, ESLint), test runs (vitest 167/167, Deno edge 41/41), config audit, prior-audit (`INSIGHT_FINDER_EXTENSIVE_AUDIT.md`) follow-up check, security sweep.

---

## 1) Executive verdict

**Overall status:** `NOT BETA-READY — BLOCKERS PRESENT`

The platform is **functionally solid** — 208/208 tests passing, tsc clean, the audit-driven `/health` probe is shipped, and most user-facing transport errors (401/403/404) are now mapped to explicit toasts in `ChatWindow.tsx`. However, **two structural issues block beta release**:

1. **Type safety collapse in the orchestrator** — `index.ts` (3,854 LOC, 250 KB) contains 104 `any` types. The orchestrator function is the single most important piece of code in the platform; it handles PII, makes external API calls, and persists artifacts. Shipping beta with this much untyped code in the orchestrator means the next refactor will introduce silent regressions in the highest-risk part of the system.
2. **`index.ts` is still monolithic** — 3,854 LOC. The June 4 split refactor extracted 22 modules (good), but the remaining monolith contains the auth/thread gating, the SSE stream handler, and the per-tool dispatch loop. Audit's P2-1 (modularization) is **partially done, not done**.

Everything else is either already addressed or is a polish item.

---

## 2) Status of prior audit findings (F-01 through F-09)

| ID | Finding | Prior status | Current status (2026-06-05) |
|---|---|---|---|
| F-01 | Auth required, opaque failure UX | Open | **FIXED** — `ChatWindow.tsx:45-47` maps 401/403/404 to explicit messages; line 828 routes 401 to auth |
| F-02 | Thread ownership returns 403 | Open | **FIXED** — same `transportStatusMessage()` function handles 403 |
| F-03 | Orchestrator key hard dependency | Open | **FIXED** — `/health` probe (commit `6614b88`) reports readiness; `index.ts:107,128` computes `orchestratorOk` from key presence |
| F-04 | Rigid function URL construction | **Patched in audit** | **VERIFIED FIXED** — `ChatWindow.tsx` prefers `VITE_SUPABASE_URL`, falls back to project id |
| F-05 | Generic user failure messaging | Open | **FIXED** — `transport-errors.test.ts` (41 tests) locks the 401/403/404/429/500/timeout mapping |
| F-06 | README is template-level | Open | **FIXED** — current `README.md` has project-specific env table, deploy steps, health probe docs, troubleshooting matrix |
| F-07 | RLS posture correct | Positive | **VERIFIED** — RLS policies in migrations remain in place; F-A5 self-view policy shipped today (commit not in tree yet) |
| F-08 | SSRF hardening (`assertSafeUrl`) | Positive | **VERIFIED** — `assertSafeUrl` still imported and used at `index.ts:1653, 1660` |
| F-09 | Surface area is large | Open | **PARTIALLY ADDRESSED** — 22 modules extracted; `index.ts` down from ~5,300 LOC to 3,854 LOC; **NOT YET DONE** — orchestrator body still monolithic |

**Net:** 8 of 9 prior findings closed. The one remaining is F-09 (modularization depth).

---

## 3) New findings from this audit

### BLOCKER-1: Type safety collapse in the orchestrator
- **Evidence:** `supabase/functions/osint-agent/index.ts` has 104 `any` types. 100% of ESLint errors in this file are `@typescript-eslint/no-explicit-any`. Two additional `prefer-const` errors (lines 341-342).
- **Impact:** The orchestrator (`Deno.serve(async (req) => ...)` at line 151) is the entire backend of the platform. With 104 untyped values, the type system provides zero protection against:
  - Wrong response shape from external APIs (OathNet, Serus, Exa, Hunter, etc.)
  - Tool-result shape mismatches when threading data through the 14-agent catalog
  - Silent breakage of the SSE stream contract
  - PII/breach data leaking into wrong fields (e.g. breach passwords into display-only contexts)
- **Why it matters for beta:** A beta audience will hit edge cases the original dev environment didn't. Each `any` is a place where the next OSINT investigation could surface a wrong artifact, fail silently, or expose unmasked breach data.
- **Severity:** **HIGH** (P0) — blocks beta.
- **Estimated effort:** 2–4 hours to type the orchestrator's external interface boundaries (the 14 tool return types are already typed in `tools/*.ts`; the orchestrator needs to import and use them).
- **Recommended approach:** Add `// eslint-disable-next-line @typescript-eslint/no-explicit-any` for genuinely untyped third-party responses (Exa, Serus) with a comment explaining why, and type the rest using the existing tool types.

### BLOCKER-2: `index.ts` is still 3,854 lines
- **Evidence:** `wc -l supabase/functions/osint-agent/index.ts` → 3854.
- **Impact:** A single 250 KB file containing the entire request lifecycle (CORS, auth, thread validation, message persistence, orchestrator selection, tool dispatch loop, SSE streaming, error envelope) is hard to audit, hard to test in isolation, and hard to evolve. The prior split (22 modules) extracted the easy pieces; the hard ones — auth/thread gate, SSE handler, tool dispatch — remain.
- **Severity:** **MEDIUM** (P1) — should be done before wider beta, not strictly required for limited beta.
- **Recommended split:**
  - `sse_stream.ts` — `Deno.serve` handler + SSE encoding (~200 LOC)
  - `request_context.ts` — auth/thread validation, env assembly (~150 LOC)
  - `tool_dispatch.ts` — tool execution loop (~300 LOC)
  - `index.ts` — top-level orchestration only (~100 LOC)

### HIGH-1: `validation.ts` has 5 `no-useless-escape` errors
- **Evidence:** `supabase/functions/osint-agent/validation.ts` lines 20, 41, 88.
- **Impact:** Cosmetic regex syntax; no behavior impact, but each is a sign of a regex that was written without care. Validation is the security boundary for user input — sloppy regexes here are a real risk.
- **Severity:** LOW (P2) — but should be cleaned up.
- **Recommended approach:** Read each regex, remove the unnecessary backslash escape, add a unit test that the regex still matches what it should.

### HIGH-2: `ChatWindow.tsx` has 40 `any` types
- **Evidence:** `src/components/ChatWindow.tsx` lines 35, 43, 217, 221, 225, 234-237, 553, 581, 585, 590, 603, 619, 629, 636, 641, 712, 717, 802, 821, 1025, 1030, 1111-1112, 1137, 1160, 1165, 1175, 1181, 1183, 1315.
- **Impact:** The chat window is the only UI surface that talks to the orchestrator. 40 untyped values in the streaming/SSE handling means UI bug fixes are flying blind.
- **Severity:** MEDIUM (P1) — same family as BLOCKER-1 but in the frontend.

### MEDIUM-1: `tools/recording.ts` has 28 `any` types
- **Evidence:** ESLint output for `recording.ts`.
- **Impact:** The recording module is responsible for capturing which tools ran, what they returned, and what they cost. It's the audit trail for the OSINT investigation. With 28 untyped values, the audit trail is one refactor away from being unreliable.
- **Severity:** MEDIUM (P1).

### MEDIUM-2: No `react-refresh/only-export-components` boundaries in `src/components/ui/`
- **Evidence:** 8 `react-refresh/only-export-components` warnings in `badge.tsx`, `button.tsx`, etc.
- **Impact:** Fast Refresh (the dev-server hot-reload) doesn't work optimally when these files export both a component and a constant. Not a runtime bug, but a dev-velocity hit.
- **Severity:** LOW (P2).

---

## 4) Tests and checks — quantitative results

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ 0 errors |
| `npx vitest run` | ✅ 167/167 passing, 9 test files, 967ms |
| `npm run test:edge` (Deno) | ✅ 41/41 passing, 96ms |
| `npx eslint .` | ❌ **305 errors, 8 warnings** |
| `git status` | ✅ Working tree clean, last commit `5b7500c` pushed to origin |
| Serus leaked key in tracked files | ✅ Not found (clean) |
| `.env` in tracked files | ✅ Not tracked |
| RLS policies on `security_tests` | ✅ F-A5 self-view policy shipped today (in `supabase/migrations/20260605_audit_f_a5_self_view.sql`) |

---

## 5) Security sweep results

- **No hardcoded secrets** in tracked files. Serus, MiniMax, Lovable, Exa, Hunter, SocialFetch, Synapsint, OSINTNova, Cordcat, OathNet, Upstash, Jina, GitHub, Firecrawl, StolenTax, OSINT Navigator, Perplexity, Gemini — all read from `Deno.env.get(...)` via `env.ts`.
- **`.env` is gitignored** — confirmed by `git ls-files | grep .env` returning empty.
- **Serus key from chat 2026-06-04 leak** (`ak_39cf4c5...`) — **NOT present** in any tracked file. (Per memory, this key should still be rotated in the Serus dashboard; the platform never had it hardcoded, but the user has it on the dashboard and it was exposed in chat.)
- **Auth header + thread ownership gating** — present at the top of the orchestrator function. F-01, F-02 controls intact.
- **SSRF hardening** — `assertSafeUrl` still imported and used. F-08 control intact.
- **Error envelope from orchestrator** — `index.ts:3848` returns `{ error, code: "ORCHESTRATOR_FAULT", detail }`. P1-2 (structured error envelope) is **partially done**; some other error paths still return plain text.

---

## 6) Beta-readiness checklist (what's left)

| Item | Status | Action |
|---|---|---|
| `/health` probe shipped | ✅ Done | Deployed (awaiting user to run `npx supabase functions deploy osint-agent`) |
| Transport status UX (401/403/404) | ✅ Done | — |
| Project README | ✅ Done | — |
| Auth + thread ownership gating | ✅ Done | — |
| SSRF hardening | ✅ Done | — |
| RLS on all tables | ✅ Done | — |
| Test suite (vitest + Deno edge) | ✅ 208/208 | — |
| `tsc --noEmit` | ✅ Clean | — |
| **Type safety in orchestrator (`index.ts` 104 × `any`)** | ❌ **Open** | Type or annotate — BLOCKER for beta |
| **Modular split of `index.ts` (3,854 LOC)** | ⚠️ Partial | Extract SSE handler, request context, tool dispatch — P1 |
| Type safety in `ChatWindow.tsx` (40 × `any`) | ❌ Open | P1 — same family as BLOCKER-1 |
| `validation.ts` regex cleanup (5 useless escapes) | ❌ Open | P2 — quick fix |
| `tools/recording.ts` 28 × `any` | ❌ Open | P1 |
| Plain-text error envelopes in some paths | ⚠️ Partial | P1 — extend structured envelope to all error returns |
| Serus key rotation in dashboard | ⚠️ Pending user action | Per memory, key from 2026-06-04 chat exposure should be rotated in Serus dashboard |

---

## 7) Recommended release path

### Path A — Limited Beta (10-25 users, hand-picked)
**Conditions:** Fix BLOCKER-1 (type safety in `index.ts`) only. Everything else can be P1/P2.
**Estimated effort:** 2-4 hours focused work.
**Justification:** A small group of trusted OSINT analysts can report issues; the orchestrator is functionally correct, just unsafe to evolve.

### Path B — Open Beta
**Conditions:** BLOCKER-1 + P1 items (modular split, ChatWindow type safety, recording type safety, structured error envelope). All P2 items.
**Estimated effort:** 1-2 days.
**Justification:** A larger audience will surface refactor-induced regressions in the untyped `any` paths; modularization is needed for fast iteration on hotfixes.

### Path C — Public Launch
**Conditions:** Everything in Path B + a load test, an incident response runbook, an SLA statement, a privacy policy, a beta-terms agreement, and a kill switch.
**Estimated effort:** 1-2 weeks.

---

## 8) Audit confidence

- **Code-level findings:** High
- **Test coverage analysis:** High (208 tests across 9 vitest + 4 Deno files)
- **Runtime behavior findings:** Medium (no live deploy verification)
- **Overall confidence:** High on the structural findings; **BLOCKER-1 is a code-static finding, not a runtime test result, so verify by running `npx eslint .` yourself**.

---

## 9) Suggested first action

Type the orchestrator boundary. The 14 tool return types already exist in `tools/*.ts`. The fix is mechanical: import them in `index.ts` and replace `any` with the specific tool's return type. The fastest loop is:

1. Pick a single tool call site in `index.ts` (e.g. `oathnet_email_breach` near line 668).
2. Import the tool's return type from `tools/breach.ts`.
3. Replace `const r: any = await oathnet_email_breach.execute(...)` with `const r: BreachToolResult = await oathnet_email_breach.execute(...)`.
4. Re-run `tsc --noEmit` to surface any real shape mismatches the `any` was hiding.
5. Repeat for the 13 other tools.

This is the **highest-leverage** change in the codebase: each typed call site either compiles (and is now safer) or fails to compile (and surfaces a latent bug).

After that, the modular split becomes much easier because the typed boundaries make the module seams obvious.
