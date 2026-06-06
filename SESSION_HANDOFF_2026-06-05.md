# Insight Finder — Session Handoff (2026-06-05)

**Audience:** me (next session) or any collaborator picking this up cold.
**Repo:** `~/Downloads/Archives/Insight Finder`
**Remote:** `git@github.com:justindean785/insight-finder.git` (branch `main`)
**Last commit:** `0304031` (Phase 1+2 typing — see bottom section; not yet pushed at time of writing)
**Date:** 2026-06-05, late session (updated after Phase 1+2 execution)

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

---
---

# ▶▶ Phase 1+2 execution update (2026-06-05, later session)

Everything in the sections above up to here is the *earlier* state. This section supersedes it where they conflict.

## TL;DR (new)

**BLOCKER-1 is cleared and the entire codebase is now `@typescript-eslint/no-explicit-any`-free.** ESLint went **288 errors → 0** (8 `react-refresh` *warnings* remain, P2). The structured error envelope was found already complete. The platform is **limited-beta-ready**. The only remaining Phase-2 item is the modular split, which is **bigger and riskier than the original estimate** and is deferred with a re-scoped plan (audit §10).

## Commits added this session (on `main`, local)

| SHA | Title |
|---|---|
| `5945c78` | lint: clear validation.ts regex escapes + prefer-const autofix |
| `dc85d74` | types: eliminate ~190 explicit-any across frontend + backend tools |
| `0304031` | types: eliminate all explicit-any in orchestrator index.ts (96 → 0) |

> ⚠️ **Not yet pushed to origin** as of this writing. `git push origin main` when ready.

## Current state (supersedes the table above)

| Check | Result |
|---|---|
| `npx eslint .` | ✅ **0 errors**, 8 warnings (`react-refresh/only-export-components` on `src/components/ui/*` — P2, dev-velocity only) |
| `npx tsc --noEmit` (frontend) | ✅ Clean |
| `deno check index.ts` (cold) | ⚠️ **153** pre-existing (144 × `TS7031` from ai@6 zod→`tool()` arg inference + a few `TS7006`). **The "35" in the old table was a stale deno-cache reading.** Not in the CI gate; out of scope. |
| `npx vitest run` | ✅ 167/167 |
| `npm run test:edge` | ✅ 41/41 |
| `npm run build` | ✅ ~2s |

## What was done (per cluster)

- **validation.ts** (input-security boundary): 4 `no-useless-escape` fixed (behavior-preserving char-class normalizations) + 2 `prefer-const` autofixes.
- **Frontend `src/` (66 `any` → 0):** ChatWindow SSE/streaming parts typed via `UIMessage` part shapes; dead `(supabase as any)` casts removed; metadata reads → `Record<string,unknown>`; react-markdown `components` via `satisfies Components`. Also: BrainGlobalPage ternary-statements → `if/else`; `command.tsx`/`textarea.tsx` empty interfaces → type aliases.
- **Backend `tools/*` + `cache.ts` + `recording.ts` (100 `any` → 0):** co-located API-response interfaces (fields read + `[k]:unknown`); `wrapToolsWithCache(toolsObj: Record<string, Tool>)`.
- **Backend misc (`archiver`/`circuit`/`contradictions`/`providers`/`sweeper`, 13 → 0).**
- **`index.ts` orchestrator (96 `any` → 0):** `ToolRegistry`/`ExecutableTool` aliases for the self-referential + late-injected tool registry; interfaces for every third-party JSON parse boundary; `ModelMessage` for message-trimming; typed Supabase row shapes. **Types-only, no behavior change.**
- **`tool-catalog-contract.test.ts`:** updated `lateInjectedNames()` grep to match the new `(tools as ToolRegistry).X = tool` notation (was matching `(tools as any)`). Removed a brittle comment-block workaround a sub-agent had added.
- **Error envelope:** verified — every error path in `auth.ts` (401/403/400/429/500) and `index.ts` (500) already returns `{error, code, detail}`. No work needed.

## Process notes / gotchas discovered

- **`deno` CLI is sandbox-blocked for sub-agents.** A delegated agent could not run `deno check`/`deno info` directly — only the pre-approved `npm run test:edge` wrapper runs deno (with `--no-check`). Verify deno-check deltas yourself from the orchestrating session.
- **Concurrent typing agents inflate each other's `deno check`.** Three agents editing disjoint files in parallel transiently raised `deno check index.ts` (it pulls in the whole import graph). Re-measure after all agents finish; confirm against a `git stash` baseline. Final delta here was **zero** (153 → 153).
- The audit's deno baseline "35" was wrong (cache artifact). Real cold baseline = **153**.

## The one remaining item — modular split (NOT done, see audit §10)

The original split plan doesn't match where the lines are. `index.ts` is 4,059 LOC and **lines 233–~3,880 are one inline `tools` literal** (~3,650 LOC) whose `execute()` bodies close over request context. The real reduction = converting tool groups into `make<Group>Tools(ctx)` factories — invasive (~3,650 lines), thin test net (41 edge tests). Re-scoped step-by-step plan is in **`BETA_READINESS_AUDIT.md` §10**. Now *safer* to attempt because the seams are typed. **Not required for limited beta.**

## Next-session first actions

1. `git push origin main` (3 commits pending).
2. Operator: `supabase secrets set SUPABASE_ANON_KEY=***` + rotate the exposed Serus key, then `npx supabase functions deploy osint-agent`.
3. If pursuing the split: follow audit §10, one tool-group factory at a time, `npm run test:edge` + a live smoke scan after each.

---
---

# ▶▶ Session update (2026-06-06, net-hardening continued)

This section supersedes earlier ones where they conflict. **All work below is pushed to `origin/main`.**

## TL;DR (new)

Continued the SSE-stream hang-hardening line of work and **finished it**: **every external `fetch()` in every *live* edge-function module is now time-bounded.** `f63150c` covered the 36 remaining tool-API fetches in `index.ts`; `3fd312b` closed the last live gap in `archiver.ts`. Inside `index.ts`, only **2 raw untimed `fetch()` remain by design** — both have bespoke self-timeouts (osintnova phone 25s+retry @ ~line 917; http_fingerprint 10s+SSRF-redirect-recheck @ ~line 1797). The `tools/*` directory still has many untimed fetches but is **dead code** (never imported live — confirmed by grep). All gates green.

**Live-module fetch coverage (audited this session):** `index.ts` → fetchT/fetchRetry; `sweeper.ts` → bespoke 6s/req + 25s budget; `providers.ts` → bespoke 45s; `archiver.ts` → bespoke 8s HEAD + 25s GET (body-spanning). No other live module makes external fetches.

## Commits added since the 2026-06-05 typing work (all on `origin/main`)

| SHA | Title |
|---|---|
| `173e520` | fix(tools): 4 verified API-integration accuracy bugs |
| `ff7a886` | fix(tools): 12 more failure-masquerade bugs in live inline tools |
| `5ba5bc4` | test(tools): test seam for live inline tools + 25 interpreter tests |
| `305feb5` | fix(net): per-call timeouts + partial-failure hardening (infra endpoints) |
| **`f63150c`** | **fix(net): route remaining 36 tool-API fetches through fetchT (close hang-vuln)** |
| **`3fd312b`** | **fix(net): bound archiveAttachment HEAD/GET (last live untimed-fetch gap)** |

## What `f63150c` did (this session)

`305feb5` timed only the infra endpoints (crt.sh, DoH, archive.org, blockstream, shodan, …) and left ~36 third-party tool fetches untimed. This session routed all 36 through the existing `fetchT(url, init?, timeoutMs=12_000)` helper:

- **12s default:** deepfind.me (×14), virustotal, ipgeolocation, ip-api, rdap, emailrep, gravatar, hackernews, github code-search, socialfetch, hunter.io (×6 incl. the people/companies fan-out), leakcheck public fallback.
- **Tuned headroom** for genuinely slow upstreams: oathnet 20s, stolen.tax breach fan-out 20s, leakcheck v2 20s, stolen.tax 127-site footprint sweep 25s.
- **intelbase:** client cap = `(caller timeout_ms ?? 30_000) + 5_000` — honors the caller-supplied upstream timeout (also sent in the body, max 60s) so the fetch never aborts a still-pending server-side lookup.

## Net-helper reference (`fetch_retry.ts`)

- `fetchRetry(url, init, {retries=2, baseDelayMs=400, timeoutMs=30_000})` — retries 429/5xx + network errors, per-attempt timeout, composes with caller signal, cancels discarded retry bodies. Used for the important/retriable endpoints (13 sites).
- `fetchT(url, init?, timeoutMs=12_000)` — one-shot hard timeout, no retry. The hang-guard for flaky/slow upstreams (48 sites). Drop-in replacement for `fetch(url, init)`.

## Current state (supersedes the tables above)

| Check | Result |
|---|---|
| `npm run test:edge` (Deno) | ✅ 73/73 |
| `npx vitest run` | ✅ 167/167 |
| `npx eslint .` | ✅ 0 errors (8 react-refresh warnings, P2) |
| `npx tsc --noEmit` (frontend) | ✅ Clean |
| `npm run build` | ✅ ~2s |
| `deno check index.ts` (warm) | ⚠️ 39 pre-existing (ai@6 zod→`tool()` inference) — delta 0, out of scope |

## Still open (priority order, unchanged)

1. **Operator action (blocks deploy):** `supabase secrets set SUPABASE_ANON_KEY=***`, rotate the exposed Serus key (`ak_39cf4c5…`, compromised 2026-06-04), then `npx supabase functions deploy osint-agent`. Requires operator — not doable from this session.
2. **BLOCKER-2 modular split** (audit §10) — deferred, big, not required for limited beta. Now safer (seams typed + time-bounded).
3. P1/P2 polish from the earlier sections (frontend `any` already cleared; react-refresh warnings remain).

## Watch-outs (still current)

- `deno check` warm baseline is **39** this session (was 153 cold last session — cache-dependent). Always re-measure delta against `git stash`, don't trust the absolute number.
- Sub-agents can't run `deno` (sandbox-blocked); only the orchestrating session can. The `npm run test:edge` wrapper runs deno with `--no-check`.
- `fetchT`/`fetchRetry` are imported into `index.ts` from `./env.ts` (which re-exports from `./fetch_retry.ts`).
- **`fetchT`/`fetchRetry` only bound time-to-headers, not body download.** They `clearTimeout` in `finally` the moment `fetch()` resolves (headers received). For a call that then does `res.arrayBuffer()`/`res.text()` on a large or slow-drip body, the body read is *not* covered — use a bespoke `AbortController` whose timer stays armed through the body read (see `archiver.ts` GET, `sweeper.ts`). For the JSON tool-API calls this doesn't matter (small bodies), which is why `fetchT` is correct there.
- **Deno typed-arrays gotcha:** annotating `let buf: Uint8Array` widens to `Uint8Array<ArrayBufferLike>` and breaks `crypto.subtle.digest` (`SharedArrayBuffer` not assignable to `BufferSource`). Keep `const buf = new Uint8Array(await res.arrayBuffer())` so the narrow `Uint8Array<ArrayBuffer>` is inferred.
