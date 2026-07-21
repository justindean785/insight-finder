# SESSION HANDOFF — 2026-07-21 — PR #369 deploy + emergency rollback to 6d76133

**Date:** 2026-07-21 (UTC)  
**Repo:** `justindean785/insight-finder`  
**Live Supabase:** `skzqwbyvmwqarfgfvyky`  
**Lovable project:** `4ce11bc3-039d-4439-b293-acacca9e1e3a`  
**Current live `/health` (verified repeatedly after rollback):**

```json
{
  "ok": true,
  "service": "osint-agent",
  "version": "1.2.2",
  "build": "6d76133",
  "build_committed_at": "2026-07-16T17:22:46-07:00",
  "selected_provider": "deepseek",
  "selected_model": "deepseek-v4-pro",
  "orchestrator_reason": "pinned",
  "orchestrator_active_ok": true
}
```

**Current `main` HEAD:** `a06de59` (Merge PR #370 — emergency rollback)  
**Canonical known-good osint-agent tree:** commit `0595d8e` (PR #366) with `BUILD_MARKER = "6d76133"`  
**Do NOT confuse with git ref `6d76133` itself** — that commit’s `build-info.ts` says `2645f50` and is the **wrong tree**.

---

## One-line verdict

Ship of PR #369 to production reintroduced the July 19–20 “tools run / no assistant response / hung RUNNING” regression. Emergency rollback restored the July 16 DeepSeek-stable tree (`BUILD_MARKER 6d76133` via source commit `0595d8e`). Live edge is again on `6d76133`. Treat #369 as **quarantined** until a controlled canary proves the full 10-point checklist under DeepSeek load — health alone is not enough.

---

## Timeline (UTC, 2026-07-21)

| Time (approx) | Event |
|---|---|
| Earlier sessions | PR #369 built on `cursor/cdf02ff8-four-fixes-cf62`: SocialFetch selector, Jina concurrency 3, HTB/PyPI blocklist, recovery pivots, atomic budget, auto-persist, review filtering, comma-safe memory, `toolChoice: "required"`, etc. CI green. Live still on stale `6d76133`. |
| ~08:26 | User said **“go”**. PR **#369 merged** → `7af7673`. |
| ~08:26 | `node scripts/stamp-build.mjs` → `BUILD_MARKER = "7af7673"` committed as `5811db2` on `main`. |
| ~08:28–08:30 | Mirror repo `seeker-spark-search-5362c57c` **not accessible** to this agent’s GitHub token (404). Workaround: Lovable agent surgically synced 29 `osint-agent` files from public `insight-finder@5811db2` and ran `supabase--deploy_edge_functions` for `osint-agent`. |
| ~08:30 | Live `/health` moved **`6d76133` → `7af7673`**. Deploy proven. |
| ~08:33–08:35 | User UI: `example.com` / other runs; `xkeyscore.co` appeared COMPLETE on Vercel UI (pre/post mix). Lovable preview showed stale “3 issues” banner + `Backend health` HTML JSON error (badge used unset `VITE_SUPABASE_URL` → SPA HTML). |
| ~08:37 | Controlled `node scripts/live-scan.mjs example.com` against live `7af7673`: **stream finished with 15 artifacts**, status later `finished` — but stream `finish` flag false / thread still `active` at script exit; not a full 10-point canary. |
| ~08:38–08:40 | Operator screenshots: investigation **RUNNING**, tool cycles firing, **no real assistant prose**, hung on RapidAPI breach search — classic no-response regression. Operator ordered **rollback now**. |
| ~08:41 | First Lovable rollback instruction mistakenly said sync from git ref **`6d76133`**. Lovable did that and deployed. Live reported **`build: "2645f50"`** — wrong tree. |
| ~08:42 | Correction: sync from **`0595d8e`** (PR #366). Branch `cursor/emergency-rollback-6d76133-cf62` restored osint-agent byte-for-byte from `0595d8e`, deleted #369-only files, pushed. |
| ~08:43 | **PR #370 merged** → `a06de59`. Lovable sync+deploy from `0595d8e` completed. Live `/health` → **`build: "6d76133"`**, DeepSeek active. |
| ~08:43–08:45 | Operator + ChatGPT paste re-confirmed the same correction; Lovable reported full health JSON with `6d76133`. Independent curl matched. |

---

## What PR #369 contained (quarantined on main history, not live)

Merged as `7af7673`, stamped `5811db2`. Large backend batch vs July 16 tree:

1. **Atomic tool-call budget reservation** (`reserveToolCall` / `tool_budget_reserve_test.ts`)
2. **Per-call auto-persist** of findings (with `ALWAYS_ALLOW` exclusions + scrubbing)
3. **Forced tool execution** on non-finalize steps (`buildIntermediateStepPlan` + `toolChoice: "required"`)
4. **Stale-thread recovery leases** (`recovery_claim:*`, heartbeat CAS, reclaimable leases)
5. **SocialFetch platform-aware circuit selector** (`platform|kind|handle`; benign skip via `circuit_benign_skip`)
6. **Jina concurrency 3**; origin 403/451 selector-local (not provider-wide)
7. **Recovery report “Recommended Next Pivots”**
8. **Analyst-rejection filtering** across artifacts/memory/cache/recovery (`filterMemoriesByReviews`, reviews wiring)
9. **Memory preload** + PostgREST comma-safe filters (`agentMemoryOrFilter`)
10. **HTB / PyPI sweeper blocklist**
11. Collapse multi-step assistant prose toward one closing report

**Local verification before ship (on #369 branch):** edge ~846+ targeted canaries green; frontend tests for report-shape / circuit / pivots green; GitHub CI 5/5 SUCCESS.

**Production proof after #369 deploy:** `/health` build moved to `7af7673` only. That does **not** prove DeepSeek investigation stability.

---

## Failure mode observed after #369 went live

Matches documented July 19–20 regression (see prior handoff *Revert osint-agent to 07-16 + DeepSeek*):

- Thread stays **RUNNING**
- Internal tool activity / cycle log progresses (or hangs mid-tool)
- Chat UI shows **no durable assistant response / no closing report**
- Evidence count may move while Chat stays empty of narrative
- Operator experience: “API activity but no agent reply”

**Hypothesis (not fully root-caused live):** interaction of `toolChoice: "required"`, DeepSeek tool-call / DSML behavior, long tool waits (e.g. RapidAPI breach), and/or finalize/persist path changes — same *class* of failure as the July 19–20 batch that #366 rolled back.

**Do not re-ship #369 wholesale** without a passing controlled canary (checklist below).

---

## Rollback — critical ref lesson

### Wrong ref (do not use again)

| Item | Value |
|---|---|
| Git commit | `6d76133` (Merge PR #336) |
| That tree’s `BUILD_MARKER` | **`2645f50`** |
| Result when deployed | Live health showed `2645f50` — **not** the known-good July 16 production marker |

### Correct rollback source

| Item | Value |
|---|---|
| Canonical commit | **`0595d8e`** (`revert(osint-agent): roll back to 07-16 build (0bcd1a0)` — PR **#366**) |
| Expected `BUILD_MARKER` | **`6d76133`** |
| `BUILD_COMMITTED_AT` | `2026-07-16T17:22:46-07:00` |
| Also equivalent trees | `cd9733c`, `0bcd1a0`, `5d90d6e` (pre-#369 main) — all carry marker `6d76133` |
| Emergency PR that restored main | **#370** → merge `a06de59`, commit `4c92abd` |

### Deploy channel (unchanged)

> A mirror merge is NOT a deploy. The only proof of deploy is a moved `/health` `build` SHA.

1. Source of truth: `insight-finder` `main`
2. Stamp `build-info.ts` when shipping a *new* build (rollback reused existing stamped `6d76133` from `0595d8e`)
3. Sync `supabase/functions/osint-agent/` surgically into Lovable sandbox (mirror `seeker-spark-search-5362c57c` still often inaccessible to Cursor bot token — Lovable agent can pull from public GitHub raw/API)
4. Explicit `supabase--deploy_edge_functions` with `function_names: ["osint-agent"]`
5. Verify curl health SHA

**Never** `supabase functions deploy` from user token (403 ownership wall).

---

## Current production state (as of handoff)

| Surface | State |
|---|---|
| Edge `osint-agent` | **Live `build: 6d76133`**, DeepSeek pinned, checks ok |
| `insight-finder` `main` | `a06de59` — osint-agent tree = `0595d8e` (#366) |
| Vercel frontend | Tracks `main`; ships independently of edge |
| Lovable sandbox `build-info.ts` | `BUILD_MARKER = "6d76133"` |
| #369 code | Still in git history (`7af7673` / feature commits) but **not** in live edge or current `main` tree |
| Mirror repo access from this agent | Still broken (404 / not found) — use Lovable sync-from-GitHub workaround |

### Operator instructions right now

1. Confirm badge/health shows **`6d76133`** (not `7af7673`, not `2645f50`).
2. **Stop** any hung #369-era threads.
3. Start a **new** investigation — do not resume stuck ones.
4. Keep #369 quarantined until canary passes.

---

## Canary checklist (still NOT fully proven for #369)

Health ≠ investigation stability. Before any re-roll of #369 (or pieces of it), prove:

1. Normal investigation reaches a **real final report**
2. DeepSeek accepts `toolChoice: "required"` **without** forced-tool loops / silent hang
3. Parallel bursts do **not** exceed tool cap
4. Successful findings **persist before** finalization
5. SocialFetch multi-platform calls no longer collide
6. Three parallel Jina reads work; excess reported honestly
7. Comma-containing address loads prior memory
8. Analyst-dismissed value does not reappear (cache / artifacts / recovery / memory)
9. Forced stale-thread recovery → exactly one report with Recommended Next Pivots
10. CPU time, duration, tool count, DB activity within bounds

### Partial evidence from this session

| Probe | Result |
|---|---|
| Live health after #369 | `7af7673` ok |
| `live-scan.mjs example.com` on `7af7673` | 15 artifacts, no stream error; incomplete finish semantics |
| Operator real UI after #369 | **FAIL** — hung RUNNING, no assistant response |
| Unit/edge canaries for #369 logic | Passed locally before ship — **insufficient** |
| DB via Lovable `query_database` | Worked later for thread listing (earlier connector `403 insufficient_scope` was intermittent / scope) |
| Post-rollback health | **`6d76133`** ok, DeepSeek |

### Threads seen around deploy window (DB sample)

| Thread | Seed | Status notes |
|---|---|---|
| `5e7cf606-…` | example.com | finished (~08:33–08:35) |
| `24828f83-…` | example.com (live-scan) | finished after agent canary |
| `0752123f-…` | phone 19167356524 | finished (~08:38–08:43) — overlapped hang window |
| Older `ysshotit` | username | updated ~09:02 finished |

---

## Side issues (non-blocking for rollback)

### Lovable `BackendVersionBadge` HTML-as-JSON error

- Popover title **“Backend health”**
- Error: `Failed to execute 'json' on 'Response': Unexpected token '<' … <!doctype`
- Cause: `import.meta.env.VITE_SUPABASE_URL` unset in Lovable preview → relative URL → SPA HTML
- Lovable applied a fallback to hardcoded Supabase URL/anon key during session
- **Not present on Vercel insight-finder tree** (component is Lovable-side); Vercel is the real app

### Lovable “3 issues” banner

Stale detections of bugs that #369 claimed to fix (`toolChoice` required, review filtering). After rollback those *fixes* are also off live. Banner is not a deploy authority — `/health` is.

### Mirror repo

`justindean785/seeker-spark-search-5362c57c` remains the documented Lovable GitHub connection, but this Cursor agent cannot clone/list it. Operational workaround: instruct Lovable to pull specific files from **public** `insight-finder` SHAs.

---

## Git / PR map

| PR | Merge SHA | Role |
|---|---|---|
| #366 | `0595d8e` | Prior known-good July 16 restore |
| #369 | `7af7673` (+ stamp `5811db2`) | Quarantined batch — caused hang |
| #370 | `a06de59` (`4c92abd`) | Emergency restore of `0595d8e` tree to `main` |

**Branches:**

- `cursor/cdf02ff8-four-fixes-cf62` — #369 work (merged)
- `cursor/emergency-rollback-6d76133-cf62` — #370 work (merged)

---

## Immediate next steps for the next agent / operator

1. **Leave live on `6d76133` / DeepSeek** unless operator explicitly re-approves a canary deploy.
2. If investigating #369 hang root cause: do it on a **feature branch** with unit/integration tests; do **not** re-deploy full #369.
3. Prefer **surgical re-introduction** (e.g. HTB/PyPI blocklist alone, SocialFetch selector alone) over the whole batch.
4. Any future backend ship must follow: stamp → sync **correct commit** → Lovable `supabase--deploy_edge_functions` → health SHA gate → **then** 10-point canary before declaring success.
5. When messaging Lovable for rollback/sync, always specify:
   - **source commit SHA that contains the desired `BUILD_MARKER`**, not the marker string as if it were a git ref
   - explicit “STOP if build-info ≠ expected marker before deploy”
6. Update operator memory / ChatGPT: **canonical rollback = `0595d8e` → marker `6d76133`**, never sync git ref `6d76133` for that goal.

---

## Copy-paste: Lovable emergency restore (if live drifts again)

```
EMERGENCY CORRECTION — sync ONLY supabase/functions/osint-agent/ byte-for-byte from
github.com/justindean785/insight-finder commit 0595d8e
(PR #366 July 16 known-good). DO NOT use git ref 6d76133 (that tree marks 2645f50).

Before deploy, read build-info.ts — MUST contain BUILD_MARKER = "6d76133".
If not, STOP. Do not hand-edit the marker.

Then: supabase--deploy_edge_functions function_names: ["osint-agent"] AS-IS.

Verify curl .../osint-agent?health=1 → ok:true, build:"6d76133", selected_provider:deepseek.

No frontend edits. No publish. No inventing fixes.
```

---

## Related docs

- `CLAUDE.md` / `AGENTS.md` — deploy topology
- `docs/REDEPLOY_RUNBOOK.md`
- Prior: *SESSION HANDOFF — 2026-07-20 — Revert osint-agent to 07-16 + DeepSeek* (operator/ChatGPT memory; same failure class)
- `SESSION_HANDOFF_2026-07-19_dismissals-integrity-fix.md` — review-filtering lineage (parts of #369 integrity work)

---

## Bottom line for ChatGPT / next session

**Production is rolled back and verified on `build: 6d76133` + DeepSeek.**  
**PR #369 is a failed production experiment** until canary criteria pass.  
**Never again treat git SHA `6d76133` as the rollback source** — use commit **`0595d8e`**, which *carries* marker `6d76133`.
