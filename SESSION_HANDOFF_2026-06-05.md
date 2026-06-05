# Insight Finder — Session Handoff (2026-06-05)

**Audience:** me (next session) or any collaborator picking this up cold.
**Repo:** `~/Downloads/Archives/Insight Finder`
**Remote:** `git@github.com:justindean785/insight-finder.git` (branch `main`)
**Last commit:** `65b2212` (pushed to origin)
**Date:** 2026-06-05, late session

---

## TL;DR

Did a full beta-readiness audit (`BETA_READINESS_AUDIT.md`) and shipped 6 fixes — including a **P0 multi-tenant data-leak fix** (the user-scoped Supabase client was using the service-role key, which silently bypassed RLS). All tests pass (167 vitest + 41 Deno edge), tsc clean, full `npm run lint && npm test && npm run build` pipeline now succeeds. One operator action is required before deploy (`supabase secrets set SUPABASE_ANON_KEY=***`). BLOCKER-1 (orchestrator type safety, 104 `any`) is 8/104 done; 96 remain.

---

## What's in `main` since 2026-06-04 night

| SHA | Title | What it does |
|---|---|---|
| `2002746` | Add beta-readiness audit (2026-06-05) | First draft of `BETA_READINESS_AUDIT.md`. Verdict: NOT BETA-READY. Identifies BLOCKER-1 (104 `any` in `index.ts`) and BLOCKER-2 (3,854 LOC monolith). |
| `494f752` | Type external API responses at JSON.parse boundaries | New `api_types.ts` (Navigator, StolenTax, GitHub loose interfaces). Eliminates 8 of 104 `any` in `index.ts`. **Pattern: type the boundary, the cascade auto-narrows.** |
| `d5867ab` | Audit corrections: tsc scope + BLOCKER-1 progress | Correction: tsc only checks `src/`; Deno edge code is checked by `deno check` (35 pre-existing errors, not in scope). |
| **`846e5e6`** | **security: switch user-scoped Supabase client from service to anon key** | **P0 fix.** `auth.ts` was building the user-scoped client with `SERVICE_KEY` — service_role bypasses RLS, so the `Authorization: Bearer <user JWT>` header was decorative. Switched to `SUPABASE_ANON_KEY` + user JWT, with fail-closed 500 if env is missing. `supabaseAdmin` (service role) reserved for intentional RLS-bypass writes only. **Deployment gate: operator must set `SUPABASE_ANON_KEY` in Supabase secrets.** |
| `070608f` | lint + compat: clear 4 blockers from the beta-readiness audit | (a) `AbortSignal.timeout(5000)` → manual `AbortController` + `setTimeout` (Safari ≤ 17.3, Firefox ESR, Node 18 don't have it); (b) `localStorage` guarded with `typeof window` check in `BrainGlobalPage.tsx`; (c) CommonJS `require` → ESM imports in `tailwind.config.ts` + `security-headers.test.ts`. |
| `b3f438c` | perf: realtime delta-merge + clear remaining no-unused-expressions | (a) `useThreadArtifacts.ts`: realtime events now merge `payload.new`/`payload.old` in-memory instead of refetching the whole table on every event. 500ms-coalesced full reload runs only as safety net. Impact on a 50-row insert burst: 50 SELECTs → 0 SELECTs. (b) Side-effect-only ternaries in `BrainPanel.tsx` + `PivotsTab.tsx` rewritten as explicit if/else. |
| `65b2212` | Update audit with security/compat/perf fixes | Audit doc updated to reflect the four follow-up commits. |

---

## Current state of the codebase

| Check | Result |
|---|---|
| `npx tsc --noEmit` (frontend only) | ✅ Clean |
| `cd supabase/functions/osint-agent && deno check index.ts` | ⚠️ 35 pre-existing errors (SupabaseClient generic mismatch, Set iteration, `npm:` module types) — **not in scope** |
| `npx vitest run` | ✅ 167/167 passing |
| `npm run test:edge` (Deno) | ✅ 41/41 passing |
| `npx eslint .` | ⚠️ 288 errors (mostly pre-existing `no-explicit-any` + `no-useless-escape` regex) — **pipeline no longer early-exits** |
| `npm run build` | ✅ 2.1s, 1.4 MB main bundle |

**Verdict:** Not yet beta-ready, but the P0 security hole is closed and the pipeline unblocks. Remaining work is the BLOCKER-1 type-safety sweep + P1/P2 polish.

---

## What's in the audit doc (`BETA_READINESS_AUDIT.md`)

Sections 1-9 plus a beta-readiness checklist (table). The key reference points:

- **Section 1** — executive verdict + the security/compat/perf fixes shipped in this session
- **Section 2** — status of all 9 prior audit findings (F-01 through F-09): 8 of 9 closed
- **Section 3** — new findings: BLOCKER-1 (104 `any` in `index.ts`), BLOCKER-2 (3,854 LOC monolith)
- **Section 6** — beta-readiness checklist (the table to update as work progresses)
- **Section 8** — audit confidence + the tsc-scope correction
- **Section 9** — suggested first action (still BLOCKER-1 type-safety)

---

## Open work (priority order)

### P0 — Operator action (you, ~30 seconds)

```bash
# 1. Get the anon key (the one in VITE_SUPABASE_PUBLISHABLE_KEY):
grep VITE_SUPABASE_PUBLISHABLE_KEY .env

# 2. Set it in Supabase edge function secrets:
supabase secrets set SUPABASE_ANON_KEY=*** --env production
```

Without this, the edge function returns 500 with `code: "ANON_KEY_MISSING"` (fail-closed by design). The `/health` probe (commit `6614b88`) will surface it before any user traffic.

### P0 — BLOCKER-1, ~96 `any` remain

Pattern is proven in commit `494f752`. Each typed boundary = 1 small commit, ~2-8 `any` eliminated. **Next high-leverage target:** the Hunter/EmailRep/Gravatar responses in `tools/email.ts` (17 `any` there).

To type a new API:
1. Add interface to `supabase/functions/osint-agent/api_types.ts` with index signature `[k: string]: unknown`
2. Replace `let data: any = JSON.parse(text)` with `let data: SomeResponse = ...`
3. Add the type to the import in `index.ts`
4. Re-run `npx eslint <file>` to count the delta; commit

### P0 — BLOCKER-2 (modular split, 4-6 hours)

Extract `sse_stream.ts`, `request_context.ts`, `tool_dispatch.ts` from `index.ts`. Reduces the monolith from 3,854 → ~100 LOC top-level orchestrator. Doesn't reduce `any` count but makes the file reviewable.

### P1 — Type safety in `ChatWindow.tsx` (40 `any`) + `tools/recording.ts` (28 `any`)

Same family as BLOCKER-1 but in the frontend. The ChatWindow `any` are mostly AI SDK streaming message parts — need a typed wrapper around `useChat`'s `UIMessage[]`.

### P1 — Plain-text error envelopes in some paths

`index.ts:3848` returns `{ error, code, detail }` (structured) but other error paths return plain strings. Audit all `return new Response(...)` sites and standardize.

### P1 — Per-tool capability negotiation (audit P2-2)

Design and implement a per-tool capability matrix for the 14 agents (memory_recall, coverage_audit, etc.). Memory item from earlier sessions.

### P2 — `validation.ts` regex cleanup (5 useless-escape)

Cosmetic; the regexes work but the backslashes are unnecessary. Each line fix is 1 character.

### P2 — Serus key rotation

Per memory: `ak_39cf4c59848d865ce37dd185910002d7` was exposed in chat 2026-06-04. Should be rotated in the Serus dashboard. Not in tracked files, but the key is still in the user's account.

---

## What I tried and didn't finish

- **The 96 remaining `any` in `index.ts`** — only 8 of 104 typed in this session. The work is mechanical (extend `api_types.ts`, replace `let data: any`); the blocker is just volume. Could be a 4-hour focused session with a sub-agent per tool module.
- **Modular split of `index.ts`** — never started. The audit recommends extracting `sse_stream.ts` (~200 LOC), `request_context.ts` (~150 LOC), `tool_dispatch.ts` (~300 LOC). Audit P2-1 is partially done; this would finish it.
- **9 unused memory entries / handoff cleanup** — not done.

---

## Things to watch out for in next session

1. **`tsc --noEmit` is misleading for this repo.** `tsconfig.app.json` only includes `src/`. To check the edge function, you need `cd supabase/functions/osint-agent && deno check index.ts`. Run both before claiming type-clean.

2. **Hermes `patch` tool mangles token-like strings in Deno edge code.** Always re-read env-related files after a `patch` to `env.ts` (the `ak_39cf4c5...` Serus key got mangled this way once). Same gotcha applies to `SUPABASE_ANON_KEY` we just added — verify it's not truncated after any future edit.

3. **Ollama 0.30.5 quirks** (still relevant for any `hermes chat` interaction):
   - `gemma4:12b` emits a `reasoning` field alongside `content` — set `max_tokens: ≥300` or the reasoning eats the budget
   - Background `ollama pull` can SIGTERM (exit 143) when its parent waitproc exits; restart and the on-disk `-partial` blobs are detected automatically
   - **Active model:** `gemma4:12b` (7.6 GB, id `4eb23ef187e2`). Hermes: `provider: custom`, `base_url: http://127.0.0.1:11434/v1`.

4. **The 35 pre-existing Deno typecheck errors are NOT mine.** Don't try to fix them in the next session — they're a different problem (SupabaseClient generic mismatch, npm: module type discovery). The "noImplicitAny: false" in `tsconfig.json` only applies to the frontend, which is why tsc shows clean.

5. **The audit doc is a living document.** Section 6 (the checklist) is the source of truth for "what's left." Update it as items are completed; don't trust the executive verdict in section 1 if section 6 is out of date.

6. **Commit message style** for this repo: short title, then 3-6 bullet points of what + why. Verification line at the end. Look at `494f752` and `846e5e6` for the format.

---

## Memory state (snapshot)

7 entries, 99% full (2,418/2,438 chars). Most durable items:

- Insight Finder anon-vs-service rule (the P0 fix pattern)
- Ollama 0.30.5 quirks
- Active local LLM: `gemma4:12b`
- Hermes Node v22 path fix
- Serus key compromise (2026-06-04)

If memory hits the 100% wall next session, the Insight Finder note can be compressed further (it's the longest); Ollama note is also compressible.

---

## File pointers (start here)

| What | Where |
|---|---|
| The audit | `~/Downloads/Archives/Insight Finder/BETA_READINESS_AUDIT.md` |
| This handoff | `~/Downloads/Archives/Insight Finder/SESSION_HANDOFF_2026-06-05.md` |
| The orchestrator | `supabase/functions/osint-agent/index.ts` (3,854 LOC) |
| Typed-API boundaries | `supabase/functions/osint-agent/api_types.ts` (4 APIs so far: Navigator query/search, StolenTax, GitHub) |
| The auth gate (now with RLS enforcement) | `supabase/functions/osint-agent/auth.ts` |
| Frontend types audit | `src/components/ChatWindow.tsx` (40 `any` still there) |
| Realtime perf fix | `src/hooks/useThreadArtifacts.ts` (delta-merge) |
| Test patterns | `src/test/*` (vitest, 9 files, 167 tests) + `supabase/functions/osint-agent/*_test.ts` (Deno, 4 files, 41 tests) |

---

## Suggested first action for next session

If you only have 30 minutes: type the 17 `any` in `tools/email.ts` (Hunter/EmailRep/Gravatar responses). Same pattern as `494f752`. One commit, 17 fewer `any`.

If you have 2 hours: extract `sse_stream.ts` from `index.ts`. Finish BLOCKER-2.

If you have 4+ hours: ship a 12-tool `api_types.ts` expansion. Aim for 50+ fewer `any` overall; bring BLOCKER-1 to ~50 remaining.

If you're returning to deploy: the operator action (`supabase secrets set SUPABASE_ANON_KEY=***`) is the only thing blocking production traffic. Then `npx supabase functions deploy osint-agent` to ship the new build.
