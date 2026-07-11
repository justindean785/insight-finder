# AGENTS.md

Read `CLAUDE.md` first — it holds the canonical deploy topology and edge-function
gotchas. This file only adds Cursor Cloud environment notes.

## Cursor Cloud specific instructions

### What runs where
- **Frontend** — Vite + React 18 + TS dev server on **port 8080** (`npm run dev`).
  It talks to a **live, hosted Supabase backend** whose URL + anon key are baked
  into `src/integrations/supabase/client.ts`, so the app boots and works against
  real data **without any `.env` wiring**. There is no local Supabase to start.
- **Backend (3 Deno edge functions)** is hosted on that same remote Supabase
  project (owned by Lovable). Do **not** run/deploy it locally or use
  `supabase functions deploy` — see `CLAUDE.md`. Locally you only ever *test* the
  edge code with Deno.

### Deno is required for edge tests
- `npm run test:edge` (and `npm run test:coverage`'s sibling `edge` CI job) need
  the **Deno** runtime. Deno v2.x is installed at `~/.deno/bin` and added to
  `PATH` via `~/.bashrc`; it is **not** installed by the update script. If a
  future VM lacks it, install with `curl -fsSL https://deno.land/install.sh | sh`
  and ensure `~/.deno/bin` is on `PATH`.
- Edge tests resolve `npm:` specifiers against `node_modules` via `deno.json`'s
  import map, so `npm ci` must run **before** `npm run test:edge`.

### Auth gotcha for testing authenticated flows (scans, evidence, brain)
- The hosted project **enforces email confirmation**. A brand-new sign-up cannot
  log in until the emailed confirmation link is clicked, so fresh UI signups are
  a dead end for testing. To exercise authenticated flows (running a scan,
  viewing evidence, the Agent Brain) log in with an **already-confirmed account**.
- Running a scan spends **real credits** on the hosted backend and calls live
  OSINT APIs. Use benign, non-PII seeds (e.g. the domain `example.com`) for smoke
  tests. A scan of `example.com` completes in ~20s and returns whois/DNS/CDN
  findings — a good end-to-end check.
- **Live smoke script:** `node scripts/live-scan.mjs [seed]` — signs up a fresh
  test user, creates a thread, streams `osint-agent` on production, prints artifact
  count + failure reason. Default seed: `example.com`.
- Backend readiness (does not spend credits or hit the LLM):
  `curl -sS "$VITE_SUPABASE_URL/functions/v1/osint-agent?health=1" -H "apikey: <anon key>"`
  → `{"ok":true,...}` when the orchestrator + core secrets are set.
- **Lovable AI Gateway spend cap:** orchestrator fallback bills Lovable credits.
  A cap hit surfaces as **403 Forbidden** in the investigation stream (now
  classified to a clear quota message). Operator action: raise the cap in Lovable
  settings. Primary orchestrator is still MiniMax; gateway is fallback only.
- **MiniMax preflight vs. gateway:** a 6s preflight ping timeout used to force
  every cold edge isolate onto the Lovable gateway (logs show
  `Lovable Gateway fallback` on every step). Fixed on `main` after the preflight
  timeout PR lands — only explicit HTTP probe failures pivot to gateway.
### Backend deploy — a mirror merge is NOT a deploy

> A mirror merge is NOT a deploy. The only proof of deploy is a moved build SHA.

Edge-function changes go live ONLY via an explicit Lovable deploy. Merging to
`insight-finder/main` — **and even merging the mirror sync PR** — does **not**
update production edge code. The verified recipe (canonical copy in `CLAUDE.md`):

1. Merge to `justindean785/insight-finder` `main`.
2. Run `node scripts/stamp-build.mjs` BEFORE the final commit — `build-info.ts`'s
   `BUILD_MARKER` does **not** auto-update; skip it and the health SHA won't move
   even after a real deploy.
3. Open a surgical sync PR to the Lovable mirror `seeker-spark-search-5362c57c`
   (per-function `cp -R` + `git diff` review; never blanket-overwrite — the mirror
   holds un-backported work like `tools/peopledatalabs.ts`).
4. **Explicitly trigger the Lovable edge-function deploy** — the Lovable project
   agent runs `supabase--deploy_edge_functions` for `osint-agent`. Merging the
   mirror PR does NOT deploy; a "redeploy" nudge often only creates a commit.
5. VERIFY: `curl "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"`
   and confirm the `build` SHA **moved**. If it didn't move, nothing shipped.

### Standard commands (defined in `package.json`)
`npm run dev` · `npm run lint` · `npm run typecheck` · `npm run test` /
`npm run test:coverage` · `npm run test:edge` · `npm run build`. The exact CI
gate is `.github/workflows/ci.yml`. Frontend tests use vitest with a coverage
ratchet in `vitest.config.ts` — don't lower the thresholds.
