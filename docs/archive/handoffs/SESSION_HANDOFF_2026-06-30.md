# Insight Finder — Session Handoff (2026-06-30)

> Read this + `CLAUDE.md` + `SCOPING_QOL_ROADMAP.md` first. Written to be read with zero prior context.

---

## 0. TL;DR
The app is stable and current in production. This session fixed a broken CI lint gate (which had been
silently blocking production deploys), shipped the React Flow graph + fixed its empty-canvas bug, made the
report deliverable honest (effective source counts + a CLEAN/ADVISORY/BLOCKED confidence verdict), culled
dead tools from the planner, and fixed a serus crash. **Everything is merged; production = `main` HEAD
`d213b40`; there are no open PRs of mine.**

---

## 1. ⚠️ Where to work — clean branch & worktree (READ FIRST)
- **Work in the worktree `/Users/dizosint/if-beta-p0`** (it has `node_modules` + `reactflow` installed).
- It is currently on the merged branch `feat/report-verdict`. **The clean base is `origin/main`.** Start new work with:
  ```
  cd /Users/dizosint/if-beta-p0
  git fetch origin
  git checkout -b <your-branch> origin/main
  ```
- **Do NOT `git checkout main`** here — `main` is checked out by another worktree (`.claude/worktrees/agitated-lalande-*`), so it errors. Always branch off `origin/main`.
- **Do NOT work in `/Users/dizosint/insight-finder`** (the primary checkout) — it sits on a stale far-behind feature branch.
- A parallel agent/editor sometimes edits this worktree live (caused a collision this session). If a file changes under you, re-read before editing.

## 2. Deploy topology + CI gate (don't repeat my early mistake)
- **Frontend:** merge PR → `main` → Vercel auto-deploys → **`insight-finder-sandy.vercel.app`** (the real app).
- **Backend (osint-agent edge fn):** double-port `supabase/functions/osint-agent/` to the mirror
  `justindean785/seeker-spark-search-5362c57c` → Lovable auto-deploys. Recipe in `CLAUDE.md`; worktree off `mirror/main`,
  copy changed files, `git diff` to confirm only your change, `deno test`, PR, merge.
- **CI gate (`.github/workflows/ci.yml`):** Frontend job runs **lint → typecheck → test:coverage → build** (lint FIRST);
  Edge job runs deno tests. **ALWAYS run `npm run lint` locally before merging.** **Do NOT `gh pr merge --admin`** —
  it masks a red gate (a red lint gate also blocks Vercel production promotion, which bit us this session).
- **Evidence/confidence/report/custody changes are integrity-critical → need user sign-off** (per `CLAUDE.md`).

## 3. Verify commands (all currently green on main)
- `npm run lint` → 0 errors (9 pre-existing warnings) · `npm run typecheck` · `npm run build`
- `npx vitest run` → **815 passed** · edge: `cd supabase/functions/osint-agent && deno test --allow-net --allow-sys --allow-env --allow-read --no-check` → 347 passed / 0 failed / 3 ignored

## 4. What shipped this session (all merged to `main`)
- **#173** fullscreen-remount fix (ChatPage unified to one layout tree; was aborting live runs + dropping messages)
- **#174** PII scrub (real demo seed + real-person `/report-preview` dossier + 17 test fixtures + guard test) + beta P0s (Terms rename, credit chip, contact link → `support@dizosint.co.site`)
- **#175** sidebar = one recency-ordered case list (was burying recent scans)
- **#177** + mirror **#39** dead-tool cull: `synapsint`/`stolentax_footprint`/`hackernews_user`/`gravatar`/`emailrep` blocked from planner + decoupled from playbooks
- **#178** React Flow graph (wires the dormant `src/lib/entity-graph.ts` `buildEntityGraph`)
- **#180** lint-gate fix: typed `user_credits` in generated types, removed `(supabase as any)`, fixed wrong column `spent`→`spent_micro_usd`
- **#181** graph fitView fix (graph was rendering an empty canvas in prod)
- **#179** honest source depth (effective independent source count; collapses mirrors/duplicate datasets)
- **#182** + mirror **#40** serus crash fix (`String()`-coerce non-string errorMsg in `classifyToolOutcome`)
- **#183** honest confidence verdict (CLEAN/ADVISORY/BLOCKED banner + tier-over-statement findings)
- **#176** roadmap doc (`SCOPING_QOL_ROADMAP.md`)
- **DB ops:** backfilled 77 stuck-`active` threads → `finished` (status only, recency preserved).

## 5. Awaiting USER visual confirmation (hard-refresh prod)
- Graph tab now renders nodes (the #181 fix) — confirm not blank.
- Report shows the verdict banner + "N labels → M independent" source depth + Accuracy Guardrails findings rendering correctly.
(If anything looks off, iterate — these are additive/low-risk.)

## 6. Most actionable next upgrades (priority order)
1. **Finish Tier-0 tool reroutes (backend, double-port).** The last weak-tool cleanup from prod telemetry:
   - `socialfetch_lookup`: planner calls it for `github`/`linkedin`/`twitch` (unsupported) + over-bursts → its "failures" are self-inflicted. Add routing guidance/guard so it's only used for supported platforms. Files: `system-prompt.ts`, `playbooks.ts`, `tool-registry.ts` (socialfetch).
   - `leakcheck_lookup`: 20× `upstream HTTP 400` = malformed input. Fix input formatting. File: `tool-registry.ts` (leakcheck execute).
   - **Phone coverage** (biggest hole): `bosint_phone_lookup` 14% ok / ~30s timeout. Repair/replace the phone provider; phone is the weakest seed type. Files: `tool-registry.ts`, phone playbook in `playbooks.ts`.
2. **Geist Mono phantom font (frontend, S, big cohesion win).** "Geist Mono" is declared in ~12 CSS classes + the brand but **never loaded** — `index.html` loads JetBrains Mono — so the forensic-data UI renders two different monospace faces. Load Geist Mono or standardize on JetBrains Mono. Files: `index.html`, `src/index.css`, `tailwind.config.ts`.
3. **Global Entity Explorer (Tier 2 — the cross-scan moat).** "Every case this selector touches." Needs a new `entities` rollup table `(user_id, kind, norm_value, thread_ids[], first_seen, last_seen, occurrence_count, max_confidence)` + a `/entities` route; reuse `normalizeValue`/`selectorsFor`. Highest-impact net-new feature. (See roadmap §2 Tier-2.)
4. **Make the learning loop honest (Tier 1.4).** `artifact_reviews` (confirm/dismiss marks) is written by the UI but **read nowhere in `supabase/functions/`**, yet the Brain UI claims it reweights sources. Either wire it (read reviews → bias source confidence) or fix the overclaiming copy. Files: `supabase/functions/osint-agent/tool-registry.ts` (`memory_recall`/source confidence), `BrainGlobalPage.tsx`, `BrainPanel.tsx`.
5. **Adopt `ReportCardV2` fully on real data (report slice 3).** My #179/#183 wired the audit pipeline into the simpler `CaseReport`. The richer `src/components/investigation/ReportCardV2.tsx` (drift arrows, competing hypotheses, custody serializer) still ships only to DEV `/report-preview`. Also: "Download PDF" is `window.print()` — route it through the real `evidence-export` edge function + unify dossier + connections + custody into ONE export.
6. **UI polish (Tier 3):** re-tint premium surfaces (`.intel-node`/`.evidence-tile`/`.code-panel` are pure grey, should be blue-black hue) + branded loading skeletons (bare "Loading…" first paints) + rebuild the Landing feature trio (most templated block).

## 7. Known issues / non-bugs (don't chase)
- `hibp_lookup` (0%) and `ipqualityscore_lookup` (0%) are left on **API-key gates** — they need a key/integration fix (owner/config action), not code.
- `jina_reader_scrape` **HTTP 451** (legal block on target) and `gemini_deep_dork` **abort/timeout** are external/expected, not code bugs.
- Open PR **#119** (`fix/osint-artifact-integrity`, 2026-06-24) is a pre-session integrity PR awaiting sign-off — not mine; leave unless asked.
- `evidence-export` has historical mirror drift (per `CLAUDE.md`); sync deliberately if you touch it.

## 8. Key files
- Report/audit: `src/lib/audit/from-artifacts.ts` (adapters: `artifactsToSources`, `artifactsToClusterAudit`, `reportVerdict`), `src/lib/audit/{confidence-linter,source-independence}.ts` (engines), `src/components/panel/CaseReport.tsx` (`VerdictBanner` + Accuracy Guardrails), `src/components/investigation/ReportCardV2.tsx` (richer, DEV-only).
- Graph: `src/components/workspace/GraphTab.tsx` (React Flow), `src/lib/entity-graph.ts` (model).
- Sidebar/credits: `src/components/ThreadSidebar.tsx`, `src/integrations/supabase/types.ts` (`user_credits` typed).
- Backend planner/tools: `supabase/functions/osint-agent/{tool-registry,playbooks,system-prompt,tool-outcome}.ts`.
- Roadmap: `SCOPING_QOL_ROADMAP.md`. Memory: `insight-finder-qol-roadmap.md`.
