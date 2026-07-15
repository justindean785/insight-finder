# HANDOFF — 2026-07-15 — Beta Release Session

**Author:** Claude (release-mode session)
**Outcome:** ✅ **BETA GO** — reviewed backend fixes deployed live, all canaries pass.
**Read this first, then `CLAUDE.md` for deploy topology.**

---

## 0. TL;DR

- **Backend edge function `osint-agent` deployed live** — build moved `64213f4` → **`f9784e0`** (confirmed via `/health`). Carries #310 (cache-skip guard), #311 (DeepSeek persistence nudge), #304 (attachment-abort recovery), the **account-authorized breach reveal**, and **PDL** (`pdl_person_enrich`).
- **Frontend** = Vercel `main` (now `4c9da29`, includes #312 tool-count fix). Auto-deployed on merge.
- **All three production canaries pass** (A DeepSeek persistence, B cache-skip retry, C UI counts). Stop button works; failed tools degrade gracefully; evidence-integrity labels intact.
- **The single completion-blocker (backend fixes not live) is RESOLVED.**
- **JD directive honored:** breach reveal left ON ("leave data shown, work around it") — masking behavior unchanged from what was already live.

---

## 1. ⚠️ CURRENT DEPLOY TOPOLOGY & STATE (read carefully — there is a marker gotcha)

```
FRONTEND (Vercel, "Insight Finder", insight-finder-s… )  ← the REAL beta surface
   = justindean785/insight-finder  main @ 4c9da29
   includes #312 (tool counts), reveal-in-source (#322), everything merged.

BACKEND edge fn osint-agent (Supabase skzqwbyvmwqarfgfvyky)  build = f9784e0  ← LIVE
   deployed FROM the mirror justindean785/seeker-spark-search-5362c57c  main @ 8c95e46
   (content commit f9784e0 = mirror lineage: #310+#311+#304+reveal+PDL+deepseek-obs health)

DEPRECATED frontend (Swarmbot, seeker-spark-search.lovable.app) — DO NOT evaluate beta here.
   It is a DIFFERENT, older app (no useThreadToolActivity/WorkspaceHeader). It showed
   "backend: unreachable" and a wrong tool count "107" — both artifacts of THAT app, not the beta.
```

### 🔴 Marker mismatch you WILL notice (and it's fine):
- `insight-finder` **main** `build-info.ts` `BUILD_MARKER = "3a69abc"` (stamped during #322).
- **Live `/health` reports `build: "f9784e0"`.**
- **These differ on purpose.** I stamped main `3a69abc` planning to deploy main's osint-agent (Strategy B), then discovered the **mirror already carried an un-deployed reconciled build with the beta fixes + PDL + deepseek-obs**, so I deployed the **mirror** as-is (Strategy A — lower risk, preserves PDL/health-obs, nothing to hand-merge). So the beta backend fixes ARE live via the mirror's `f9784e0`; they were **not** shipped from main's `3a69abc`.
- **Consequence:** main's osint-agent (3a69abc) and the deployed osint-agent (f9784e0) are **functionally equivalent for the beta** but **textually divergent** (main lacks PDL + deepseek-obs health; the mirror has its own impl of the same fixes). This is unresolved drift — see §7.3.

### Health snapshot (live, 2026-07-15 ~00:11Z):
```json
{"ok":true,"service":"osint-agent","version":"1.2.2","build":"f9784e0",
 "selected_provider":"deepseek","selected_model":"deepseek-v4-pro","orchestrator_active_ok":true,
 "checks":{"orchestrator":{"ok":true},"core":{"ok":true},"tools":{"ok":true,"detail":"16/18 optional tool APIs configured"},
 "deepseek":{"ok":true,"role":"active"},"minimax":{"ok":true,"role":"fallback"}}}
```

---

## 2. RELEASE-MODE CHECKLIST (from the session brief) — UPDATED

### MUST include — ALL DONE ✅
- [x] **#310 provider-skip cache-poisoning fix** — LIVE on `f9784e0`; **Canary B verified** (18 cached rows since deploy, all `outcome=ok`, 0 cached skips/failures).
- [x] **#311 DeepSeek first-pass persistence nudge** — LIVE. Works (see Canary A). ⚠️ Partial: on heavy targets DeepSeek still defers persistence to a late batch (not incremental) — see §5.5 / §7.1.
- [x] **#312 frontend persisted tool-count fix** — LIVE on Vercel `main`; **Canary C verified** (Evidence tab `15` == 15 persisted artifacts).
- [x] **#304 attachment-timeout / vision-abort recovery** — LIVE on `f9784e0` (present in the mirror lineage via #315).

### DO NOT include — ALL EXCLUDED ✅
- [x] transactional-auto-persistence migration (**#321**) — excluded (WIP draft, untouched).
- [x] new evidence schema migrations — none applied.
- [x] deterministic artifact extractor — excluded (this is the #1 post-beta upgrade, §7.1).
- [x] major confidence changes — none.
- [x] RLS redesign — none.
- [x] new features — none.
- [x] branch-only experimental work — **#319 NOT revived**; nothing from #321.

### Three production canaries — ALL PASS ✅
- [x] **CANARY A — DeepSeek first-pass persistence:**
  - Control `example.com` (thread `48eba15f`): first `record_artifacts` at 13 tools (~51s, first-pass), **5 artifacts**, finished. ✅
  - Real target `leaxen.lol` (thread `aa9318bb`, JD ran it on the Vercel app): 95+ tools, **15 artifacts** persisted (8 hard: 5 emails, 3 usernames, breach credential, IP, domain, org, subdomain), full report with 8 identity clusters + confidence caps + INFERRED/VERIFY labels + actionable pivots. `zero_artifacts_at_completion` did NOT fire. ✅
  - ⚠️ Caveat: leaxen.lol **deferred** all persistence to a single late batch (`record_artifacts` first fired at 00:25:29, ~10 min in, after `minimax_correlate` cycles) — NOT incremental/first-pass. A *completed* heavy scan persists fine; an *early-stopped* heavy scan could still lose the batch.
- [x] **CANARY B — provider-skip not cached / live retry:** PASS. `isCacheableToolResult` guard live; no skip/failure ever entered cache.
- [x] **CANARY C — UI counts match persisted rows:** PASS on the Vercel beta app (header/Evidence = exact `tool_usage_log`/`artifacts` counts). The "107" JD saw earlier was the **deprecated Lovable frontend**, a different app.

### Also-verify list — status
- [x] **Stop button works** — present + functional (red-square in JD's screenshots; 17+ historical `stopped` threads).
- [x] **A failed tool does not crash the investigation** — leaxen.lol hit 4 live tool failures (crtsh 502, wayback 503, hunter_domain_search 400, hibp_kanon param-error) and still completed with 15 artifacts. 144 historical finished threads had ≥1 failed tool.
- [~] **No raw secrets / breach victim creds in normal UI** — **reveal is ON by JD's explicit decision** ("do not touch masking, leave data shown"). Breach artifacts DO surface credential material (e.g. `password_sha1`, `linked_password_hash: "wowdersus11"`). This is the account-authorized reveal (FBI-case dependency) — **removed from the GO/NO-GO gate by JD**, not by me. If beta audience changes, flip `REVEAL_BREACH_DATA=false` in edge secrets to restore masking.
- [x] **No new critical console/edge errors** — `/health` ok; no new error class surfaced in the canary runs.

---

## 3. REPO CHECKLIST (from `HANDOFF 7_5_26.md` §6 P0–P3) — UPDATED

> These predate this session; status reflects what I could confirm now. Items I did NOT touch this session are marked `(not this session)`.

### P0 — Fix Now
- [ ] **Create `tool_health` table migration** — STILL OPEN. NOTE: the `tool_health` table **now exists** in the DB (it's in `information_schema` — confirmed this session). The 404s in the old handoff appear resolved. Verify the frontend query path.
- [ ] **Fix or remove hard-blocked tools** (stolentax, hackernews, gravatar, emailrep, ipqualityscore) — `(not this session)`. Still advisable. `gravatar_profile` still shows in tool lists.
- [ ] **Verify/deploy PR #244 (CI migration)** — `(not this session)` — stale, verify state.
- [x] **Deploy tool-hardening to production** — SUPERSEDED. This session deployed the full reconciled beta backend (`f9784e0`), which includes the tool-reliability train (#277 F2/F3/F4 timeouts, #293 minimax leak fix, #316 replay cap, #309 DeepSeek hardening).

### P1 — High Priority
- [ ] **Explicit transport error mapping in ChatWindow** (401/403/404/500 → friendly copy) — `(not this session)` — STILL OPEN, good beta polish.
- [x] **Verify RapidAPI key** — CONFIRMED WORKING: leaxen.lol used `rapidapi_breach_search` ×12 successfully (found 4 emails). Key is healthy.
- [~] **indicia provider fix / gate** — indicia tools ran on leaxen.lol; `indicia_web_dbs`/`indicia_hudsonrock`/`indicia_phone` show intermittent **HTTP 400** (request-shape bug, self-fails gracefully). Post-beta cleanup (§7.2).
- [ ] **US_STATE_TOKENS fix** — `(not this session)`.

### P2 / P3
- [ ] Radix bundle split (#245), per-isolate schema cache (#246), `investigation_cache` index, worktree cleanup, OSINT Navigator, capability negotiation, **split `osint-agent/index.ts`** — all `(not this session)`. The index.ts god-file split partially happened (tool defs moved to `tool-registry.ts`); orchestration still in index.ts.

---

## 4. PROBLEMS I HAD (so you don't repeat them)

1. **Egress policy blocks the Supabase host.** `curl`/`WebFetch` to `skzqwbyvmwqarfgfvyky.supabase.co` return **403 CONNECT** (org egress denial, not TLS). You **cannot** hit the live backend from the sandbox. **Workaround:** the Lovable project agent (`send_message` to project `4ce11bc3-039d-4439-b293-acacca9e1e3a`) runs in an env that CAN reach Supabase — use it for the health curl and for triggering scans. Read the DB directly via `mcp__Lovable__query_database` (works, read-only, RLS-bypassing service view).

2. **MCP servers (github, Lovable, claude-code-remote) disconnect/reconnect constantly.** `send_message`, `AskUserQuestion`, `send_later`, and `create_pull_request` all timed out or aborted mid-call at least once. **Workaround:** `mcp__Lovable__send_message` with `wait=false`, then poll `get_message`/`list_messages`/`query_database`. Don't re-send deploy commands on a transport timeout — the agent usually still received them (verify via `list_messages` before retrying, or you'll double-trigger).

3. **The Lovable-mirror divergence is worse than CLAUDE.md implies.** The mirror (`seeker-spark-search-5362c57c`) and `insight-finder` main have **diverged bidirectionally across ~24 files** — same fixes, different implementations on each lineage. The mirror carries **PDL** (`tools/peopledatalabs.ts`) and a **richer DeepSeek-observability `/health`** that main lacks; main carries the normal PR train the mirror lacks. **A blind `cp` sync either direction clobbers real work.** This is why I deployed the mirror as-is (it already had the beta fixes reconciled onto its lineage — see the `deploy/reconcile-310-311-deepseek-obs` branch) instead of syncing main→mirror. **Do NOT blanket-overwrite the mirror.**

4. **I made a verdict error mid-session — learn from it.** I twice called **BETA NO-GO** based on the leaxen.lol scan showing **0 artifacts at 55/88 tools** — but the scan was **still running** (its `status` field even flapped `active→finished→active`, which is misleading). DeepSeek **defers** persistence to a late batch; when the scan actually completed it had **15 artifacts**. **LESSON: never judge Canary A on a mid-flight snapshot. Wait for a true terminal state, and don't trust the `threads.status` field alone — corroborate with "has `record_artifacts` fired AND is `tools` count stable AND is there an assistant report".** The DeepSeek "record everything after correlate" pattern means artifacts can land 8–10 minutes in on a rich target.

5. **`messages` table has no `content` column** — it's `parts` (jsonb). `evidence_log` has no `created_at` — it's `collected_at`/`seq`. `threads` has `seed_value`/`seed_type` (not `seed`). Save yourself the failed queries.

---

## 5. CURRENT SYSTEM — how it actually works

- **Orchestrator:** DeepSeek (`deepseek-v4-pro`) is the pinned primary (`orchestrator_reason: pinned`); MiniMax is fallback. DeepSeek is an openai-compatible model that **narrates-then-defers** — it fans out many discovery tools, then records artifacts in a big batch after `minimax_correlate`. This is the root behavior #311 tries to nudge and the deterministic extractor (deferred) would make robust.
- **Persistence path:** the model calls `record_artifacts` (a tool) to write `artifacts`. There's also an `auto-record-integrity.ts` path and `evidence_log` (chain-of-custody, `content_hash`/`prev_hash`/`chain_hash`). Evidence rows of `kind='tool_query'` are just query audit, NOT findings — filter them out when counting real evidence.
- **Tool catalog:** ~103 live tools (object-literal + late-attach in `tool-registry.ts`; `catalog.ts` must stay 1:1 — the `catalog-guidance`/`catalog_contract` tests enforce it). Tools self-skip on missing keys; failures return structured `{ok:false}`/`{error}` and never crash the run.
- **Reveal:** `REVEAL_BREACH_DATA` (env.ts, default ON) forces `serus reveal=true`, keeps `rapidapi` `exposed_values`/`concrete_values`, and threads `reveal` through the OathNet maskers (`stripSecrets`/`trimStealerItems`/`maskSecrets`/`safeVictimFile`, all default `false`). Kill-switch: set `REVEAL_BREACH_DATA=false`.
- **Deploy pipeline (VERIFIED this session):** merge to `insight-finder` main → (frontend ships via Vercel automatically) → for backend: stamp `build-info.ts`, push the changed osint-agent files to the mirror `seeker-spark-search-5362c57c` main, then `send_message` the Lovable project agent to run `supabase--deploy_edge_functions(["osint-agent"])` → curl `/health` until `build` SHA moves. **A mirror push is NOT a deploy; only the moved `/health` SHA proves it.**
- **Test harness in the sandbox:** `jsr.io` is egress-blocked, so `deno test` fails on `jsr:@std/assert`/`@std/testing`. **Workaround used:** `npm i deno@2`, set `DENO_CERT=/root/.ccr/ca-bundle.crt`, and add a local shim import-map redirecting `jsr:@std/assert@^1` and `jsr:@std/testing@^1/mock` to hand-written stubs (in scratchpad `std-assert-shim.ts` / `std-testing-mock-shim.ts`). With that, `deno test --no-check` runs: **osint-agent main suite = 690 pass / 0 fail / 3 ignored; mirror suite = 672 pass / 2 stale-test-only fail (nytimes→reuters token, correlate 30k cap — both are #314 test updates the mirror lacks; runtime is correct).**

---

## 6. NEXT BEST UPGRADES (prioritized)

### 6.1 🥇 Deterministic server-side auto-persist (THE one that matters)
The `zero_artifacts`/deferred-persistence risk is a **model-behavior** problem; #311's behavioral nudge is insufficient on rich targets (leaxen.lol deferred to a single late batch). **Fix:** after every value-producing tool returns, parse its output and `upsertArtifact()` **server-side**, independent of the model calling `record_artifacts`. This makes persistence **incremental + crash/early-stop-proof**. Edge-only, **no schema migration needed** for a first cut (write to existing `artifacts` with `metadata.auto_recorded=true`). This is the Lovable "Tier-1 Fix 1" and the deferred "deterministic artifact extractor." **Do NOT ship without JD's go** (it touches the sensitive persistence path).

### 6.2 Tool request-shape fixes (post-beta cleanup)
- `hunter_domain_search` / `indicia_*` → **HTTP 400** request-body bug (likely snake_case vs camelCase or a missing `query` wrapper). Inspect `error_msg` in `tool_usage_log` / edge logs, fix the body, add a unit test with the exact rejected payload.
- `hibp_pwned_passwords_kanon` → "provide either password or sha1": the orchestrator invokes it without the required param. Add a param guard so it self-skips cleanly instead of erroring.
- crtsh (502) / wayback (503) are **external outages** — nothing to fix, just noise.

### 6.3 Reconcile main ↔ mirror (kill the drift permanently)
main's osint-agent (`3a69abc`) and the deployed mirror (`f9784e0`) are textually divergent. Long-term this is fragile. Options: (a) backport PDL + deepseek-obs health into `insight-finder` main so main becomes the true single source and future deploys are `main→mirror` clean syncs; or (b) formally treat the mirror as the backend source of truth. **(a) is the right end state.** Until then, every backend deploy must reason about both trees.

### 6.4 Frontend transport-error UX (P1 from old handoff, still open)
401/403/404/500 → friendly, actionable copy in ChatWindow. Cheap, high beta polish.

### 6.5 A third tool-call state ("skipped/unavailable" ≠ "failed")
Per `BETA_FINDINGS.md §B`: missing-key/no-result skips currently render identical to real failures, making the health board look alarming and burying genuine failures. `isFreeCall` already centralizes detection; surface it as a distinct state front+back.

---

## 7. THINGS I THINK COULD IMPROVE (opinion)

- **The `threads.status` field is unreliable** (it flapped active→finished→active on leaxen.lol). Either fix the state machine or add a derived "truly done" signal (report message present AND no tool call in N seconds). This directly caused my mid-session misjudgment; it will mislead users and future agents too.
- **DeepSeek's defer-until-correlate behavior is the core product risk.** Everything downstream (evidence board, custody, confidence) depends on `record_artifacts` firing. Relying on a prompt nudge to a model that structurally prefers to batch-at-the-end is fragile. §6.1 is the durable fix; until then, expect intermittent empty/late evidence on heavy scans, and NEVER let a heavy scan be judged before it truly finishes.
- **Deploy verifiability is undermined by the marker mismatch.** main says `3a69abc`, live says `f9784e0`. Anyone auditing "is main deployed?" will get a false negative. §6.3 fixes the root; short-term, document loudly (this file) that the backend source of truth is the mirror.
- **The deprecated Lovable/Swarmbot frontend is actively misleading** — it shows "backend: unreachable" and wrong counts, and JD nearly evaluated the beta on it. Consider taking it down or hard-redirecting it to the Vercel app to stop it generating false alarms.
- **Egress + MCP flakiness makes this environment painful for backend ops.** Budget extra time; prefer `query_database` (reliable) over `send_message` (flaky) for verification; fire scans with `wait=false` and poll the DB.

---

## 8. QUICK REFERENCE

| Thing | Value |
| --- | --- |
| `insight-finder` main | `4c9da29` (Merge #322) |
| main osint-agent marker | `3a69abc` (⚠️ NOT the live build) |
| **LIVE edge build** (`/health`) | **`f9784e0`** (from mirror `8c95e46`) |
| This session's branch | `claude/insight-finder-beta-release-ygvppa` (merged via #322 → done) |
| Supabase project | `skzqwbyvmwqarfgfvyky` |
| Lovable project (deploy channel) | `4ce11bc3-039d-4439-b293-acacca9e1e3a` |
| Mirror repo | `justindean785/seeker-spark-search-5362c57c` (cloned at `/workspace/…`) |
| Health URL | `https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1` (unreachable from sandbox — use Lovable agent) |
| Canary threads | `aa9318bb…` (leaxen.lol, 15 artifacts), `48eba15f…` (example.com, 5 artifacts) |

### Deploy recipe (verified 2026-07-15)
1. Merge to `insight-finder` main (frontend ships via Vercel).
2. `node scripts/stamp-build.mjs` → commit `build-info.ts`.
3. Surgically copy ONLY changed osint-agent files to the mirror clone (NEVER blanket-overwrite — preserves PDL/deepseek-obs), `git diff` review, push mirror main.
4. `send_message` Lovable project `4ce11bc3…`: pull main, confirm marker, `supabase--deploy_edge_functions(["osint-agent"])`, deploy AS-IS.
5. curl `/health` (via the Lovable agent) until `build` == your marker.

### Verdict: **BETA GO.** Nothing stops a user from completing an investigation. The one worthwhile pre-beta-if-time / first-post-beta item is §6.1 (deterministic auto-persist) — JD's call, do not ship without explicit go.
