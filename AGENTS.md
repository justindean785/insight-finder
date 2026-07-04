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
- Backend readiness (does not spend credits or hit the LLM):
  `curl -sS "$VITE_SUPABASE_URL/functions/v1/osint-agent?health=1" -H "apikey: <anon key>"`
  → `{"ok":true,...}` when the orchestrator + core secrets are set.

### Standard commands (defined in `package.json`)
`npm run dev` · `npm run lint` · `npm run typecheck` · `npm run test` /
`npm run test:coverage` · `npm run test:edge` · `npm run build`. The exact CI
gate is `.github/workflows/ci.yml`. Frontend tests use vitest with a coverage
ratchet in `vitest.config.ts` — don't lower the thresholds.
