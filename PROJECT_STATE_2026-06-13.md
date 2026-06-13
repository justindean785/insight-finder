# Project State & Handoff — Insight Finder

**Date:** 2026-06-13
**Author:** Claude Code session (`claude/loveable-preview-sync-z8lm5h`)
**Audience:** A fresh agent (or developer) picking this up cold, plus the project owner.

---

## 0. TL;DR (read this first)

- **The code is healthy.** `npm install` + `npm run typecheck` both pass clean. The app builds and the dev server runs. There is **no broken main branch.**
- **The pain is NOT the code — it's a repo/Lovable split-brain.** The real product lives in GitHub repo **`justindean785/insight-finder`** (`main` = `70bb4a0`, current & complete). The **Lovable preview** builds from a *different*, Lovable-owned repo whose `main` is an old version. They are two unrelated repositories with no shared git history.
- **That's why the Lovable preview "looks like nothing" and is missing everything** — it's literally a different repo's old code, not stale-sync of this one.
- **Biggest immediate decision** is owner's, not technical: how to unify the Lovable repo with `insight-finder` (see §7). Lovable refuses to point at `insight-finder` and spawns a brand-new repo on every reconnect.

---

## 1. Repository inventory

| Repo | Role | State |
|------|------|-------|
| **`justindean785/insight-finder`** | **The real product.** All engineering (PRs #1–#32) landed here. | `main` = `70bb4a0`, current & complete. THIS is the source of truth. |
| `justindean785/seeker-spark-search` | Old Lovable-generated repo | Created 2026-06-08. Stale. |
| `justindean785/seeker-spark-search-ec85cfea` | Lovable-generated repo | Created 2026-06-08. The Lovable agent believes the project is linked here. |
| `justindean785/seeker-spark-search-5fea4dc8` | Lovable-generated repo | Created **2026-06-13 02:26** (during this session, by a disconnect/reconnect). Last GitHub-settings screen showed THIS one as "Connected." |

**Why three `seeker-spark-search-*` repos exist:** every time you "Disconnect & reconnect" GitHub inside Lovable, Lovable creates a **new** repo named `seeker-spark-search-<hash>` and links the project to it. Reconnecting does **not** let you choose `insight-finder`. **Stop disconnecting/reconnecting** — it just multiplies dead repos.

> ⚠️ This Claude session is access-scoped to `insight-finder` ONLY. Any GitHub action against a `seeker-spark-search-*` repo returns **"Access denied: repository not configured for this session."** To act on the Lovable repo, it must be explicitly added to the session.

---

## 2. The Lovable problem, precisely

- Lovable project name: **"Insight Finder"**. Its preview URL: **`seeker-spark-search.lovable.app`**.
- Lovable builds the preview from **the connected `seeker-spark-search-*` repo's tracked branch (`main`)** — old code.
- A Lovable "✅ All synced and deployed" chat message claims HEAD `2f4f76d` with commits `a5942c1 (#19)`, `a781885 (#18)`, `d8436e3 (#17)`. **All of those are ancient ancestors** of `insight-finder` `main` (we're ~13 merges past them at `70bb4a0`), and **`2f4f76d` does not exist in `insight-finder` at all** — it's on the seeker repo's separate timeline. So Lovable's "synced" status is from early June and never caught up.
- Someone previously pushed a snapshot branch `insight-finder-main-a5942c1` and a `lovable-main-backup-20260608-*` into a seeker repo, but never promoted them to `main`.
- **Lovable confirmed (in its own chat reply) it cannot switch the connected repo, force-pull an external repo, or reset to a foreign commit.** Its sync only works with the repo it owns.

### Fix options for the preview (owner decision)
1. **Force-push `insight-finder@70bb4a0` into the connected seeker repo's `main`.** Lovable then auto-syncs its workspace to it. This is the sanctioned fix (Lovable suggested it). Requires push access to the seeker repo → either the owner runs git from a computer, **or** the seeker repo is added to a Claude session and the agent does it.
2. **Abandon Lovable's repo lock-in:** deploy the `insight-finder` frontend on any host (e.g. Vercel/Netlify) pointed at the existing Lovable Cloud (Supabase) backend. Cleaner long-term, but needs the `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PROJECT_ID` env vars configured.
3. **Repo rename swap** (Lovable suggested) — messy, conflicts because `insight-finder` already exists. Not recommended.

**Recommended:** Option 1 to get the preview current fast; consider Option 2 if they want to stop fighting Lovable's repo ownership.

---

## 3. Branches in `insight-finder`

| Branch | Purpose |
|--------|---------|
| `main` (`70bb4a0`) | Source of truth. Current product. |
| `test/e2e-playwright-smoke` | E2E Playwright smoke-test WIP. |
| `claude/loveable-preview-sync-z8lm5h` | **This session's branch.** Currently identical to `main` (`70bb4a0`), plus this handoff doc. |

There are **no open PRs**. All historical PRs (#1, #3, #5–#19, #21, #22, #24, #26–#32) are merged into `main`.

---

## 4. Where `main` stands (the actual product)

**Stack:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui frontend; Supabase (Auth/DB/Storage/Edge Functions) backend, hosted on Lovable Cloud. AI SDK v6 for the agent layer.

**App routes** (`src/App.tsx`):
- `/` → redirect, `/auth`, `/chat/:threadId` (main workspace), `/brain` (cross-investigation memory), `/report-preview`, `/admin/security`.

**Main UI** = a 3-pane investigation workspace (`ChatPage.tsx`): `ThreadSidebar` (left) · `ChatWindow` (center) · `ResourcesPanel` (right, with ~13 tabs: Overview, Audit, Clusters, Custody, Evidence Matrix, Timeline, Pivots, Map, Report, Notes…).

**Recent feature waves merged to main:**
- Graph-first engine (entity graph, edges, clustering, confidence propagation) — PRs #7–#12.
- Circuit breakers / cost gating / provider failover — #9, #11, #17, #18.
- Tranche 1 (catalog/billing hygiene) + Tranche 2 (env-gated provider chain: Grok / OpenAdapter), grok-4.3 default — #29–#32.
- Identity merge guard + handle-based identity merging — #19, #27.
- AI SDK v6 tool-part parsing fix — #28.

---

## 5. Backend (Supabase / Lovable Cloud) state

Edge functions (all show **Active** in Lovable Cloud, and all exist in `supabase/functions/`):
- `osint-agent` — the orchestrator. **Showing ~50% success rate** in the last hour — worth investigating (likely a provider/tool failure, separate from the preview issue).
- `security-test-lab`
- `evidence-export`

Migrations live in `supabase/migrations/` (latest: `20260612_memory_save_dedup_batch.sql`, `20260608_tool_usage_charged_micro_usd.sql`). The `tool_usage_log.charged_micro_usd` column is confirmed present in the live DB.

**Important:** the backend is shared/healthy and **independent of the frontend-repo mess.** Fixing the preview is purely a frontend-repo problem.

---

## 6. Running it locally

```bash
npm install
npm run dev -- --host 127.0.0.1   # see note below
```

- ✅ **`vite.config.ts` host** now set to `host: true` (this PR). Previously hardcoded `"::"` (IPv6-only), which failed with `EAFNOSUPPORT :::8080` in containers/sandboxes that aren't IPv6-enabled. `npm run dev` now works with no flags everywhere.
- App serves at `http://localhost:8080/`. Verified HTTP 200. **Note:** this is the *container's* localhost — not reachable from your phone/laptop browser. Viewing the app needs a deployed/preview URL (Lovable or another host).
- `npm run typecheck` → clean. `npm run lint`, `npm run test` available.

---

## 7. "Dirty code" / tech-debt inventory

Concrete messiness a new agent should know about (none of it blocks the build):

1. **`supabase/functions/osint-agent/tools/infrastructure.ts`** — header says *"Auto-extracted. Add imports manually."* and an earlier handoff called it dead, **but it is LIVE**: `tools/index.ts:41` imports `deepfind_mac_lookup` and `deepfind_dark_web_link` from it (relative `./infrastructure.ts`). **Do NOT delete it.** It reads like an auto-generated dump and is a refactor candidate (clean up / fold into siblings), but only after unwiring those two exports. *(A delete was attempted in this PR's history and reverted once the import was found.)*
2. **Oversized modules** (hard to understand, prime refactor targets):
   - `supabase/functions/osint-agent/index.ts` — **4,367 lines** (the orchestrator god-file: wrappers + validators + planner prompt + record paths all in one).
   - `src/components/ChatWindow.tsx` — 1,577 lines.
   - `src/lib/intel.ts` — 1,497 lines.
   - `src/pages/BrainGlobalPage.tsx` — 1,240 lines.
   - `src/components/ResourcesPanel.tsx` — 849 lines.
3. ~~Vite host hardcoded to IPv6~~ — **fixed in this PR** (`host: true`, see §6).
4. **UI density:** the workspace is heavily decorated (nested radial/linear gradients, absolute decorative overlays, uppercase letter-spacing everywhere). Functional but visually busy — the likely source of the "messy / hard to understand" feeling. A cleanup pass simplifying the chrome (fewer gradients/overlays, calmer typographic scale) would improve clarity without touching logic.
5. **18 npm audit vulnerabilities** (6 moderate / 11 high / 1 critical) reported on install — worth a `npm audit` review, but several are likely transitive/dev-only.
6. **Duplicate/throwaway Lovable repos** (§1) — the GitHub account is cluttered with 3 `seeker-spark-search-*` repos; once the preview is sorted, delete the unused ones.

---

## 8. Recommended next steps (in order)

1. **Decide the Lovable-preview path** (§2). If Option 1: add the currently-connected seeker repo (`5fea4dc8` per last screen — confirm in Lovable → GitHub settings) to a Claude session, then force-push `insight-finder@70bb4a0` into its `main`; Lovable auto-syncs.
2. ✅ **Quick code hygiene (done in this PR):** `vite.config.ts` host fixed (`host: true`). *(Note: `infrastructure.ts` is NOT dead — see §7.1 — leave it.)*
3. **Investigate `osint-agent` 50% success rate** in Lovable Cloud logs.
4. **(Optional) UI calm-down pass** on `ChatPage`/`ChatWindow`/`ResourcesPanel` chrome for clarity.
5. **Cleanup:** delete the two unused `seeker-spark-search*` repos once the preview is settled.

---

## 9. Key facts a new agent must not re-derive

- `insight-finder` `main` = `70bb4a0` = current truth. The Lovable preview is a **different repo**, not stale sync.
- Lovable **cannot** be repointed at `insight-finder`; reconnect spawns new repos.
- This session is access-locked to `insight-finder`; seeker repos need explicit add.
- Backend (3 edge functions + migrations) is healthy and independent of the frontend mess.
- Code typechecks clean; dev server needs `--host 127.0.0.1` due to hardcoded IPv6.
