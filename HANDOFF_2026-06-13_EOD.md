# Handoff — End of 2026-06-13 session

**For:** tomorrow's agent / me, picking this up fresh.
**Companion doc:** `PROJECT_STATE_2026-06-13.md` (the deep repo/Lovable breakdown — read it second).
**Repo:** `justindean785/insight-finder` · `main` = `c7e164b`.

---

## TL;DR — what happened tonight

1. **Diagnosed the "Lovable preview is the wrong version" problem.** Root cause: Lovable builds from a **separate, Lovable-owned repo** (`seeker-spark-search-*`), NOT from `insight-finder`. They're unrelated repos. Lovable **cannot** be repointed at `insight-finder` — every reconnect spawns a new `seeker-spark-search-<hash>` repo (there are now 3: bare, `-ec85cfea`, `-5fea4dc8`).
2. **Made `insight-finder` deploy-ready** and merged it to `main` (**PR #33, squash-merged**, CI green): baked public Supabase creds into the client, added `vercel.json`, fixed the vite IPv6 host, restored a wrongly-deleted file, added the breakdown doc.
3. **The current app is confirmed working** — runs correctly at `localhost:8080` from the user's local clone (`/Users/dizosint/insight-finder`); shows the real Swarmbot OSINT console with live backend data.
4. **Set up a Vercel deploy path** (code side done) — waiting on the user to do the one-time GitHub import in their Vercel dashboard.
5. **Identified an open data-quality issue** (false identity merges / weak breach noise) — NOT yet fixed. This is the user's current frustration ("still off").

---

## Current state (facts, don't re-derive)

- `main` = `c7e164b`. Contains: Supabase public anon defaults in `src/integrations/supabase/client.ts`, `vercel.json` (SPA rewrite + build config), `vite.config.ts` `host: true`, `PROJECT_STATE_2026-06-13.md`.
- **App health:** `npm install` → `npm run dev` works with **no flags** now. `npm run typecheck`, `lint`, `test`, `build` all pass. CI (frontend vitest+build, deno edge tests) green on `main`.
- **Backend** (Lovable Cloud / Supabase, project ref `skzqwbyvmwqarfgfvyky`): 3 edge functions Active — `osint-agent` (~50% success rate, worth investigating), `security-test-lab`, `evidence-export`. Independent of the frontend repo mess.
- **Frontend Supabase env vars** (public, safe): `VITE_SUPABASE_URL=https://skzqwbyvmwqarfgfvyky.supabase.co`, `VITE_SUPABASE_PROJECT_ID=skzqwbyvmwqarfgfvyky`, `VITE_SUPABASE_PUBLISHABLE_KEY=<anon JWT>` — now baked into `client.ts` as defaults.

---

## ⚠️ Coordination hazard — multiple agents on one repo

Tonight there were **several sessions touching `insight-finder` in parallel**: a Lovable agent, a Cursor/Claude "Review code issues" session (did local git surgery + a stash it called a "safety net" — that stash is **ephemeral/local, never pushed**), and a **Codex** session. This is how the repo gets clobbered.
**Rule for tomorrow: ONE driver.** Before any push, `git fetch` and check `origin/main` hasn't moved under you. Don't trust any "stash safety net" — it's not on GitHub.

---

## Open items / next steps (priority order)

### 1. Finish the Vercel deploy (fast, gives a shareable URL)
- Vercel account is linked in-session (team `team_AStXEwK8p0iTi4lDwkGubVKS`, "justindean785's projects"). **No `insight-finder` project exists yet.**
- The in-session Vercel MCP can't push a build (no CLI/token). Deploy must go through **Vercel's GitHub integration**: user imports `justindean785/insight-finder` at vercel.com → Add New → Project. Build `npm run build`, output `dist` (already set by `vercel.json`). Production branch = `main`.
- Once connected, pushes to `main` auto-deploy. Result: public `*.vercel.app` URL identical to the local app, no env setup (creds baked in).

### 2. THE REAL UNFINISHED WORK — investigation data quality ("still off")
The user's main complaint about results. Seen on case `dejouerrich@aol.com` (`/chat/76ecce7a…`):
- **False identity merges:** IDENTITY shows 3 different names from breach dumps — *Dede Williams* (rocket-text), *Dejouer Rich* (canva), *Dede Rich* (verifications.io) — all surfaced at 50–70% as if they're the subject.
- **Weak handle noise:** SOCIAL attaches unrelated usernames *loope33* (Datpiff), *prettyd91* (Zynga) at 50% with no link to the seed — looks like breach co-occurrence noise.
- **No confirmed-vs-weak separation:** everything sits at 50–70% "medium," nothing truly confirmed, but it's all presented as established identity.

This is exactly what **`.lovable/plan.md`** specifies fixing (confidence caps, strong-vs-weak selectors, identity-cluster rules, weak-lead bucketing, collision/contradiction handling). It's only **partially** wired in (PRs #19 identity-merge guard, #27 handle-based merging). Work lives in `supabase/functions/osint-agent/` (`confidence.ts`, `clusters.ts`, `contradictions.ts`, `index.ts` validator/record paths) + UI bucketing in `CaseReport.tsx`, `OverviewTab.tsx`, `KeyFindings.tsx`, and the Evidence panel.

**User had not yet chosen which sub-fix to start with** when the session ended. Options offered:
  a. Stop false name-merges (cluster/flag breach names instead of treating each as the subject).
  b. Drop weak handle noise (stop attaching unrelated usernames at 50%).
  c. Separate "confirmed" from "weak breach leads" in the UI so low-confidence stops looking like identity.
**→ Ask the user which (a/b/c/all) before diving in.**
**Note:** engine fixes only affect **future** runs; they won't retroactively re-grade the stored `dejouerrich` artifacts (re-run the seed to see changes).

### 3. Lower-priority
- Investigate `osint-agent` ~50% success rate (Lovable Cloud logs).
- Optional: delete the 2 unused `seeker-spark-search*` repos once the preview is moot.
- Optional: the `osint-agent/index.ts` god-file (4,367 lines) is a refactor candidate.

---

## How to resume tomorrow
1. `git fetch origin && git checkout main && git pull` — confirm `main` is at/after `c7e164b` and nothing was clobbered overnight.
2. `npm install && npm run dev` → open `localhost:8080` to see the app.
3. Ask the user: did the Vercel import happen? And which data-quality sub-fix (2a/2b/2c) to tackle first.
