# Session Handoff — 2026-06-13 (Sidebar UX + Serus/IPQS + Audit Fixes)

> **Read this top-to-bottom before touching anything.** It is written so a brand-new
> agent with zero prior context can pick up exactly where this session stopped.
> Plain language, full breakdown, no assumed knowledge.

---

## 0. The one-paragraph version (if you read nothing else)

This session shipped a pile of **frontend** UI fixes and **backend** (OSINT agent)
accuracy/feature work as **7 commits on the branch `claude/dreamy-shannon-f1db20`**,
opened as **PR #35** (OPEN, not merged). The **frontend half is 100% done and will go
live the moment PR #35 merges** (Vercel auto-deploys from `main`). The **backend half
is committed but NOT deployed**, and **cannot be deployed from a Claude session** because
the live Supabase project is owned by Lovable's org, not the user's account (every deploy
attempt returns HTTP 403). The backend deploy must happen from inside Lovable, or by
pushing the code into the Lovable-connected `seeker-spark-search-*` repo. That is the
single biggest open item.

---

## 1. Context chain — how we got here

**Inherited state (start of session):** The app ("Swarmbot" / "Insight Finder") was
already deployed and working: Vite + React frontend on Vercel
(`insight-finder-sandy.vercel.app`), Supabase/Lovable-Cloud backend with the `osint-agent`
edge function. A prior session had produced `PROJECT_STATE_2026-06-13.md` and
`BETA_READINESS_AUDIT.md` (read those for deeper backend/Lovable history).

**What the user asked for, in order, across this session:**
1. Get the app beta-ready (landing page, legal pages, settings, auth polish). → DONE
2. Deep audit of the OSINT tool pipeline using exported trace JSON files. → DONE
3. Run more live test investigations (domain, phone, IP seeds) and audit those. → DONE
4. Implement the backend fixes the audit found. → DONE (committed, not deployed)
5. Recommend / add better APIs; "Serus isn't being called". → DONE (Serus fixed, IPQS added)
6. "The right sidebar has a ton of repetitive items" → first interpreted as artifact-row
   repetition (fixed), then clarified to mean **too many tabs** (fixed: 3 main tabs + Full
   review), then "the letters on the left sidebar look weird" (fixed: seed-type icons).
7. Commit everything, open PR, deploy. → PR open; **deploy blocked (see §4)**.

**Where it stopped:** Trying to deploy the backend. Confirmed via a real `supabase functions
deploy` that the user's personal access token gets **403 — not authorized** for the live
project. We did NOT merge PR #35 yet. We did NOT start the remaining backend quality fixes
(§5) beyond reading the code.

---

## 2. The 7 commits in this session (all on `claude/dreamy-shannon-f1db20`)

```
5b950b6 fix(web): show seed-type icons in collapsed thread rail, not title fragments
dfeb529 feat(web): collapse evidence panel nav to 3 main tabs + Full review
2e6d288 feat(web): cluster the evidence sidebar by kind to kill repetitive rows
7282beb feat(web): beta-readiness pages — landing, legal, settings, auth polish
be59692 feat(osint-agent): wire IPQualityScore + fix Serus never being proposed
966f5ff fix(osint-agent): close accuracy gaps found in cross-seed-type trace audit
43d9a84 fix: accept person seeds in dork harvest   <-- pre-existing, was already on branch
```
(The first 6 are this session's work. `43d9a84` was the branch's prior tip.)

### Frontend commits (ship via Vercel on merge — no extra deploy step)

**`7282beb` — beta pages.** New: `src/pages/Landing.tsx`, `Terms.tsx`, `Privacy.tsx`,
`Settings.tsx`, `public/favicon.svg`. Modified: `IndexRedirect.tsx` (unauth → Landing
instead of silent redirect), `Auth.tsx` (forgot-password flow, `?tab=signup` deep link,
Terms/Privacy links), `NotFound.tsx` (glass-card redesign), `App.tsx` (routes), `index.html`
(favicon + OG/canonical meta).

**`2e6d288` — evidence sidebar row clustering.** `src/components/ResourcesPanel.tsx`. The
Artifacts tab listed every artifact as a flat row, so 9 subdomains (all `hackertarget @70%`)
looked like a wall. Now artifacts sub-group **by kind** inside each category; same-source
clusters lift the source to a subheader; clusters >4 collapse by default
(`Subdomains · 9 · hackertarget · 70%`, expandable). Extracted `ArtifactRow` component.
**Verified live.**

**`dfeb529` — evidence panel nav simplification.** `ResourcesPanel.tsx`. Was a two-tier nav
(4 section buttons × 12 sub-tabs). Now top level = **Overview · Artifacts · Report · Full
review**. "Full review" reveals the complete old section/sub-tab nav. State: `mode` =
`"main" | "full"`. The 3 main tabs already exist inside SECTIONS, so Full review keeps the
selection. `swarmbot:navigate` events set the right mode. **Verified live.**

**`5b950b6` — left thread rail icons.** `src/components/ThreadSidebar.tsx`. The collapsed
left rail rendered `title.slice(0,2)` → ugly `+1 / 8. / SE / NI` letter stack. Now each
thread shows a lucide icon for its seed type (`SEED_ICON` map + `seedIcon()` helper using
`seed_type`, falling back to `detectSeed(title)` from `src/lib/seed.ts`). **Build/type
verified; NOT screenshot-verified** — the collapsed rail only renders on wide desktop
layouts and the browser resize was blocked in-session. A human should eyeball it once.

### Backend commits (committed, NOT deployed — see §4)

**`966f5ff` — accuracy fixes** in `supabase/functions/osint-agent/`:
- `artifact_types.ts` → `classifySource()` now strips a trailing parenthetical qualifier
  (`"socialfetch_lookup (instagram)"` → `socialfetch_lookup`) so passive-social/breach hits
  hit their real caps (40/60) instead of leaking to the `unknown` cap (50). Added
  `bosint_*`, `usphonesearch.net`, `nomorobo.com` to `TOOL_CLASS`, and
  `ipqualityscore_lookup → infra`.
- `confidence.ts` → new `isUnrelatedEntity(meta)` + `EXCLUDED_COLLISION_CONFIDENCE = 15`.
  Detects when the model flagged an artifact as a namesake/different entity (explicit
  `different_person:true` OR note text like "DIFFERENT company"/"UNRELATED individual").
- `index.ts` → `record_artifacts` AND `record_artifact` now call `isUnrelatedEntity`; if
  true they demote the artifact to `kind:"excluded_collision"`, `status:"excluded"`,
  `confidence ≤ 15` so namesakes can't pollute the case rollup. Also: persist `seed_type`
  on the thread row at completion (was always null); `jina_reader_scrape` includes the URL
  on timeout/abort.
- `validation.ts` → new `isReservedOrInvalidPhone()` (555-01xx fiction range, invalid NANP
  area/exchange, N11 codes, all-same-digit) wired into the `phone` validation branch.
- `audit_fixes_test.ts` → NEW, 5 tests covering all of the above.

**`be59692` — Serus fix + IPQualityScore**:
- **Serus root cause:** `serus_darkweb_scan` was registered in the tool registry, in
  `catalog.ts`, and in the workflow audit list — but **missing from `baseToolList`** in
  `index.ts` (~line 582), the menu the planner is *restricted* to. So the planner literally
  could not propose it → "Serus isn't being called." Fixed by adding it to `baseToolList`
  (gated) + a planner-filter line so it only appears when `SERUS_API_KEY` is set.
- **IPQualityScore (NEW tool `ipqualityscore_lookup`):** one tool, `kind: phone|email|ip`.
  A validation/fraud gate — returns `valid` + `fraud_score` + type-specific fields
  (phone: `line_type`/`carrier`/CNAM `name`/`active`/`recent_abuse`; email:
  `deliverability`/`disposable`/`leaked`; ip: `proxy`/`vpn`/`tor`). Implemented against the
  official IPQS phone + email validation docs (endpoint `/api/json/{kind}/{key}/{value}`,
  `strictness` param, email `timeout=12`). Wired across ALL of: `env.ts`
  (`IPQUALITYSCORE_API_KEY`), `index.ts` (tool def near `ip_intel`, health/capability map,
  `baseToolList`, planner key-gate, audit list, import), `catalog.ts`, `capabilities.ts`,
  `artifact_types.ts`. Key-gated — inert until `IPQUALITYSCORE_API_KEY` is set.

**Both backend tools are inert until their keys are in the edge-function secrets.** The user
says the keys are already set in Lovable Cloud.

### Verification done this session
- `deno check` on osint-agent: still exactly **41 pre-existing type errors, ZERO new** (the
  41 are AI-SDK-v6 `ResponseInit.headers` + `serus_core.ts` PollResponse typing — not ours).
- `deno test --no-check`: **78 pass** (73 prior + 5 new audit tests).
- `vite build`: clean. `tsc -p tsconfig.app.json`: clean for our files.
- Frontend sidebar changes verified **live** in Chrome against the real `serus.ai`
  investigation (thread `2f3c7459-235d-4a45-9bfa-f093a3d0ce3f`).

---

## 3. The OSINT audit findings (the "why" behind the backend commits)

Ran 4 live investigations and exported their traces (saved in `~/Downloads/osint-trace-*.json`):
- **person** `nick guynes wheatland ca` — 169 calls, $2.04, 22 failed
- **domain** `serus.ai` — 39 calls, $0.045, 8 failed
- **IP** `8.8.8.8` — 13 calls, $0.023, 0 failed (cleanest)
- **phone** `+14155552671` — 26 calls; this seed is a **reserved fiction number** yet the
  agent manufactured ~6 false-positive identities (a real 425k-follower Instagram account
  `keita.iq` attributed at 50%). This drove fixes #1–#3 above.

Findings already fixed: source-class suffix loophole, different-person gate, reserved-phone
detection, seed_type persistence, scrape-URL logging, Serus-not-proposed.

Findings **NOT yet fixed** (these are the backend quality-fix backlog — see §5).

---

## 4. ⛔ THE DEPLOY BLOCKER (most important section)

### Topology
- **Frontend** = Vite/React, hosted on **Vercel**, auto-deploys from `insight-finder` `main`.
  → Merging PR #35 ships ALL frontend work. No CLI, no token needed.
- **Backend** = the `osint-agent` Supabase **edge function**, running on Supabase project
  **`skzqwbyvmwqarfgfvyky`**, which is managed by **Lovable Cloud**.

### Why the backend can't be deployed from a Claude session (verified, not assumed)
1. The repo's `supabase/config.toml` and `src/integrations/supabase/client.ts` both point at
   project `skzqwbyvmwqarfgfvyky`.
2. The Supabase CLI is installed (`/opt/homebrew/bin/supabase`, v2.105.0) and can log in,
   BUT both the default login AND the user's personal access token (`sbp_…`) can only see
   projects `ohwdednujtszirajsxra` ("osint") and `rsydqjdqkjduldkxzdrg` ("supabase-gray-kite").
   **`skzqwbyvmwqarfgfvyky` is invisible to both** — it's in Lovable's own Supabase org.
3. Running the real deploy with a valid token returned:
   `unexpected deploy status 403: "Your account does not have the necessary privileges to
   access this endpoint."` → definitive: this account cannot deploy to that project.
4. The Lovable-connected GitHub repos are `seeker-spark-search-*` (multiple, from repeated
   Lovable disconnect/reconnects). **This Claude session is access-scoped to `insight-finder`
   ONLY** — any git op against a `seeker-spark-search-*` repo is denied.

### The only paths that actually work (a human / Lovable must do one)
- **Option A (recommended, sanctioned by Lovable per `PROJECT_STATE_2026-06-13.md` §4):**
  Add the currently-connected `seeker-spark-search-*` repo to a Claude session, then
  force-push `insight-finder`'s code into its `main`; Lovable auto-syncs + deploys. An agent
  CAN run this once the repo is in scope.
- **Option B:** Deploy from inside Lovable directly. Lovable builds from its own (stale) repo,
  so it first needs the new `osint-agent` files. Hand Lovable a patch of the 4 changed backend
  files (`artifact_types.ts`, `confidence.ts`, `validation.ts`, `index.ts`) + the new
  `audit_fixes_test.ts`, or point it at branch `claude/dreamy-shannon-f1db20`.
- **Option C (long-term):** Migrate the app off Lovable's Supabase to the `osint` project
  (`ohwdednujtszirajsxra`) that the CLI CAN deploy to. Big lift — needs DB schema/migrations,
  RLS, storage buckets, and all secrets re-provisioned there, plus repointing
  `VITE_SUPABASE_*`. Only if the user wants to leave Lovable.

### Do NOT
- Do not retry `supabase functions deploy --project-ref skzqwbyvmwqarfgfvyky` — it 403s.
- Do not add `--no-verify-jwt` to any deploy (it disables auth; was correctly blocked).
- Do not disconnect/reconnect GitHub inside Lovable — it spawns yet another dead
  `seeker-spark-search-<hash>` repo.

---

## 5. Backend quality-fix backlog (found in audit, code NOT yet written)

These are self-contained edge-function changes a new agent can implement + commit on this
branch so they ride along whenever the deploy path opens. **None are started** (only read).

1. **`minimax_correlate` never runs.** In `index.ts` (~line 537) the guard is
   `if (guard.artifactsSinceCorrelate < 3) return skipStub(...)`. But `artifactsSinceCorrelate`
   only increments when `record_artifacts` runs, and the agent records ONE batch at the END
   of a round — so the counter is 0 when it calls correlate mid-round, and it skips on EVERY
   investigation (seen in both domain + phone traces: "skipped: guard not met"). **Fix:** gate
   on the `artifacts` array actually passed into the tool (e.g. `artifacts.length >= 3`),
   plus a cheap dedup signature (count + sorted kind:value) stored on the `guard` object in
   `guard.ts` to avoid re-correlating an unchanged set. NOTE: there are TWO copies of this
   tool — the LIVE one is **inline in `index.ts` (~line 523)**; `tools/minimax.ts` is a stale
   copy. Edit `index.ts`.
2. **Three tools fail 100% of the time** — `wayback_snapshots`, `deepfind_reverse_email`,
   `stolentax_footprint` (and `bosint_phone_lookup` on phone seeds) always time out
   (12–25s aborts), wasting wall-clock + a dedup-guard slot. **Fix:** either drop them from
   `baseToolList`/catalog, or add a per-tool circuit-break after first timeout this run.
3. **Export bundle returns 500.** The Provenance → "Export bundle" button 500s server-side.
   (The per-tool-trace JSON download under Analysis works fine — that's what was used for the
   audit.) Find the export endpoint (likely `evidence-export` edge function) and fix.
4. **`detect_contradictions` / collision detector** could consume the new `excluded_collision`
   flag (low-priority polish).

---

## 6. Quick-reference facts

| Thing | Value |
|---|---|
| Branch | `claude/dreamy-shannon-f1db20` (clean, all pushed) |
| PR | **#35** OPEN → https://github.com/justindean785/insight-finder/pull/35 |
| Frontend host | Vercel, auto-deploys from `insight-finder` `main` → `insight-finder-sandy.vercel.app` |
| Live Supabase project | `skzqwbyvmwqarfgfvyky` (Lovable Cloud — CLI CANNOT deploy to it) |
| CLI-accessible projects | `ohwdednujtszirajsxra` (osint), `rsydqjdqkjduldkxzdrg` (supabase-gray-kite) |
| Backend edge fn | `supabase/functions/osint-agent/` (live entry = `index.ts`, ~4400 lines) |
| Live tool defs | INLINE in `index.ts` — `tools/recording.ts` & `tools/minimax.ts` are STALE copies |
| New API keys needed in edge secrets | `SERUS_API_KEY`, `IPQUALITYSCORE_API_KEY` (user says set) |
| Backend typecheck baseline | 41 pre-existing errors (AI-SDK v6 / serus_core) — do not chase these |
| Test command | `cd supabase/functions/osint-agent && deno test --no-check --allow-read --allow-env --allow-net` |
| Frontend tests | `npx vitest run` ; build = `npx vite build` |
| serus.ai test thread | `/chat/2f3c7459-235d-4a45-9bfa-f093a3d0ce3f` (31 artifacts, great for UI testing) |
| Reference docs | `PROJECT_STATE_2026-06-13.md`, `BETA_READINESS_AUDIT.md` |

---

## 7. Recommended next actions (in order)

1. **Merge PR #35** → ships all frontend work via Vercel (sidebar clustering, 3-tab nav,
   thread-rail icons, beta pages). Lowest risk, highest visible value, needs nothing special.
2. **Eyeball the collapsed left rail** on a wide desktop window once #35 is live — confirm the
   seed-type icons render (Phone for `+1…`, Globe for `serus.ai`, Network for `8.8.8.8`).
3. **Unblock the backend deploy** — pick Option A or B from §4. Until then the Serus fix,
   IPQS tool, and accuracy fixes are NOT live even though the keys are set.
4. **Implement the §5 backlog** (correlate guard first — it's the highest-impact and fully
   self-contained) and commit to this branch so it deploys with everything else.

---

*Handoff written 2026-06-13 ~5:50am PDT. Working tree clean. Nothing in progress mid-edit.*
