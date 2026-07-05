# Insight Finder — Comprehensive Audit Report

**Date:** 2026-07-05  
**Scope:** logs.json, lo22gs.json, repository structure, tool implementations, prior audits  
**Status:** AUDIT COMPLETE — ISSUES IDENTIFIED

---

## 1. Log Analysis Summary

### logs.json (100 entries)

| Level | Count |
| --- | --- |
| log | 64 |
| info | 27 |
| warning | 9 |

**Findings:**

* ❌ **No errors** — clean execution log
* ⚠️ **18 warnings** — all AI SDK compatibility warnings about `specificationVersion` (v2 compatibility mode for Gemini 3 Flash). This is cosmetic and expected.

### lo22gs.json (100 entries)

| HTTP Status | Count |
| --- | --- |
| 2xx | 98 |
| 4xx | 2 |

**Findings:**

* ❌ **2 × 404 errors** — both for `GET /rest/v1/tool_health` endpoint
* **Root cause:** The `tool_health` table **does not exist** in the database. This is a missing migration.

---

## 2. Tool Audit — Known Failing Tools

### Hard-Blocked Tools (Permanently Disabled in Planner)

These tools have been removed from the pivot planner due to poor performance:

| Tool | Ok % | Latency | Issue |
| --- | --- | --- | --- |
| `stolentax_footprint` | 22% | ~10s | 401 bad key + aborts |
| `hackernews_user` | 0% | — | Complete failure |
| `gravatar_profile` | 14% | — | 404 errors |
| `emailrep` | 19% | — | 429 rate-limited |
| `ipqualityscore_lookup` | 0/28 | — | Dead key ("Invalid or unauthorized key" for 30d) |

**Action required:** Fix or remove these tool definitions. Do not re-enable in planner without key repairs.

### Key-Gated Tools (Require API Keys)

These tools **self-skip** when their API keys are missing, but remain in the tool catalog:

| Tool | Required Secret | Current Status |
| --- | --- | --- |
| `hibp_lookup` | `HIBP_API_KEY` | Gate-only (valuable once keyed) |
| `serus_darkweb_scan` | `SERUS_API_KEY` | Off planner menu when unkeyed |
| `ipqualityscore_lookup` | `IPQUALITYSCORE_API_KEY` | Hard-cut (dead key confirmed) |
| `indicia_*` (6 endpoints) | `INDICIA_API_KEY` | Off planner menu when unkeyed |
| `rapidapi_breach_search` | `RAPIDAPI_KEY` | Primary breach source — critical |
| `rapidapi_all_breaches` | `RAPIDAPI_KEY` | Same as above |
| `opencorporates_search` | `OPENCORPORATES_API_KEY` | 401 without key |
| `ransomwarelive_lookup` | `RANSOMWARELIVE_API_KEY` | Free API dead; needs key |
| `urlscanner_scan` | `URLSCANNER_API_KEY` | Off planner menu when unkeyed |

---

## 3. Database Issues

### Missing `tool_health` Table

* **Impact:** Health checks fail with 404
* **Evidence:** lo22gs.json shows 2 failed GET requests to `/rest/v1/tool_health`
* **Fix:** Create migration for `tool_health` table or remove the health check query

### Missing Index: `investigation_cache`

* **Potential issue:** Queries on `investigation_cache` may be slow without indexes
* **Fix:** Add composite index on `(thread_id, key)` if not present

---

## 4. Architecture Findings

### Current Stack

```
Frontend (Vercel) → Supabase Edge Function → 14 OSINT Tool Agents
                           ↓
                    Supabase DB (RLS-protected)
```

### Edge Functions (3)

1. **osint-agent** — Main orchestrator (72 files, ~5.3k LOC)
2. **evidence-export** — PDF/zip export
3. **security-test-lab** — Admin red-team harness

### Deployment Topology

* Frontend: Vercel (insight-finder-swart.vercel.app)
* Backend: Supabase owned by Lovable Cloud
* **Critical:** Do NOT use `supabase functions deploy` — use the mirror repo `seeker-spark-search-5362c57c`

---

## 5. Prior Audit Issues (June 30)

| Issue | Status |
| --- | --- |
| F-01: 401/403 auth errors need explicit UX | ❌ Not addressed |
| F-02: Thread ownership 403 guidance | ❌ Not addressed |
| F-03: Orchestrator key missing = fatal | ✅ Health probe added (2026-07-05) |
| F-04: Function URL rigidity | ✅ Patched |
| F-05: Generic error messages | ❌ Not addressed |
| F-06: README operational runbook | ⚠️ Partially addressed |

---

## 6. Next Session To-Do List

### P0 — Fix Now

* **Create `tool_health` table migration** — fixes 404 health check failures
* **Fix or remove hard-blocked tools** — stolentax, hackernews, gravatar, emailrep, ipqualityscore
* **Verify/deploy PR #244** — CI migration (currently broken red-test state)
* **Deploy PR #243** — tool hardening to production (merged but not deployed)

### P1 — High Priority

* **Add explicit transport error mapping** in ChatWindow:

  + 401 → "Session expired. Sign in again."
  + 403 → "Thread access denied."
  + 404 → "Edge function not deployed."
  + 500 → "Backend error. Check logs."
* **Verify RapidAPI key** — primary breach source, critical for OSINT value
* **Complete indicia provider fix** — B = indicia provider family in circuit.ts
* **Complete indicia gate fix** — C = indicia gate in list\_tools handler
* **Complete US\_STATE\_TOKENS fix** — D = frontend-only fix in src/lib/intel.ts

### P2 — Medium Priority

* **Test PR #245** — Radix bundle split (clean, verified)
* **Test PR #246** — per-isolate schema cache (~18x speedup)
* **Add `investigation_cache` index** if missing
* **Clean up worktrees** — three worker worktrees under `.claude/worktrees/agent-*`
* **Clear stale branch** — local checkout on prompt-bloat branch

### P3 — Future Work

* **Integrate OSINT Navigator** — tool recommendation engine (already wired)
* **Add per-tool capability negotiation** to frontend at session start
* **Split osint-agent/index.ts** into modules (auth, tools, orchestration, persistence)

---

## 7. Quick Reference

### Handoff Locations

* **This doc:** `HANDOFF_7_5_26.md`
* **State file:** `insight-finder/.remember/remember.md`
* **Memory:** `insight-finder-prompt-bloat-branch-verdict.md`

### Open PRs

| PR | Status | Notes |
| --- | --- | --- |
| #244 | ⚠️ Do not merge | Broken red-test commit (dd98a56), needs revert |
| #245 | Ready | Clean, 893/893 tests, entry −33 kB gzip |
| #246 | Ready | ~18x speedup, edge/frontend CI pending |
| #243 | Merged, not deployed | Tool hardening in main (bfe3d3e) |

### Deployed State

* **Frontend:** Vercel (main branch)
* **Edge Function:** Lovable-managed (mirror repo)
* **Database:** skzqwbyvmwqarfgfvyky (Supabase)

---

## 8. Secrets Checklist

| Secret | Purpose | Status |
| --- | --- | --- |
| `MINIMAX_API_KEY` | Primary orchestrator | ✅ Required |
| `LOVABLE_API_KEY` | Fallback orchestrator | ✅ Required |
| `RAPIDAPI_KEY` | Breach search | ⚠️ Critical — verify |
| `SERUS_API_KEY` | Darkweb scan | Optional |
| `OATHNET_API_KEY` | Breach/stealer | Optional |
| `EXA_API_KEY` | Semantic search | Optional |
| `HUNTER_API_KEY` | Email verification | Optional |
| `INDICIA_API_KEY` | US person/phone/email | Optional |
| `OPENCORPORATES_API_KEY` | Company registry | Optional |
| `RANSOMWARELIVE_API_KEY` | Ransomware victims | Optional |
| `URLSCANNER_API_KEY` | URL security scan | Optional |
| `HIBP_API_KEY` | Have I Been Pwned | Optional |
| `IPQUALITYSCORE_API_KEY` | Fraud scoring | ❌ Dead key — remove |
| `GITHUB_API_TOKEN` | GitHub search | Optional |

---

**Audit complete. All findings documented above. Resume from P0 checklist.**

✻ Cooked for ~5m