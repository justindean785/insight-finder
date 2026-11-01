# Insight Finder — OSINT Investigation Platform

An AI-driven open-source intelligence workstation. A Supabase Edge Function orchestrates a registry of OSINT tools, streams findings into a React workspace, and keeps cross-investigation memory. Evidence is ranked, capped and quarantined by an integrity engine before an analyst reads it.

**Stack:** React 18 + TypeScript + Tailwind CSS + shadcn/ui | Supabase (Auth, Postgres, Storage, Edge Functions) | Vercel AI SDK

> **React version:** This project is intentionally pinned to **React 18** (`react`/`react-dom` `^18.3.1`, matching `@types/react` 18.x and the resolved `package-lock.json`). It uses no React-19-only APIs (`useOptimistic`, `useActionState`, `useFormStatus`, `use()`, server actions). `react-leaflet@5` declares a React 19 peer dependency that works fine at runtime against React 18; `.npmrc` sets `legacy-peer-deps=true` to suppress the peer-mismatch error. Do not bump to React 19 without an explicit migration.

**URL:** https://github.com/justindean785/insight-finder

> **Operators and coding agents: read [`CLAUDE.md`](CLAUDE.md) first.** It holds the deploy topology, the evidence-integrity rules and the settled decisions. This README only covers getting the code running.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Vite + React), deployed from `main` by Vercel    │
│  Workspace tabs: Investigate, Evidence, Tools, Graph,       │
│  Report. Chat streams over SSE from the edge function.      │
└──────────────────────────┬──────────────────────────────────┘
                           │ Bearer token (Supabase Auth)
┌──────────────────────────▼──────────────────────────────────┐
│  Supabase Edge Function: osint-agent                        │
│  Auth → thread ownership → orchestrator → tool registry     │
│  → artifact persistence (quarantine, confidence caps)       │
│  → SSE response                                             │
│  Orchestrator: GLM (via the "deepseek" slot) is primary,    │
│  Anthropic is the backup. See `.env.example`, section 3.    │
└─────────────────────────────────────────────────────────────┘
```

Other edge functions exist (`evidence-export`, `security-test-lab`, and a plugin-generated `mcp`). Do not take the deployed inventory from this README; `CLAUDE.md` explains how to enumerate it.

---

## Prerequisites

- **Node.js 22.12 or newer.** CI runs Node 22, and `@axe-core/playwright` declares `>=22.12.0`. Node 20, the old README minimum, is not what CI tests. `package.json` has no `engines` field yet, so nothing enforces this.
- **npm.** `package-lock.json` is authoritative. `bun.lockb` and `deno.lock` are present but are not what the scripts or CI use for the frontend.
- **Deno**, only to run `npm run test:edge`.
- **Playwright browsers**, only to run `npm run test:e2e`.
- **Supabase CLI** (`npx supabase --version`), only if you manage your own Supabase project.

---

## Quick Start

```sh
git clone https://github.com/justindean785/insight-finder.git
cd insight-finder
npm ci
```

Then pick one of three ways to run it.

### A. Harness: no network, no credentials (safest first run)

```sh
npx vite --config vite.harness.config.ts      # http://127.0.0.1:5174
```

Open <http://127.0.0.1:5174/chat/11111111-2222-4333-8444-555555555555>. This renders the signed-in workspace against a local stub with a realistic finished case: 8 artifacts spanning verified to capped to broker-only, 9 tool calls including 2 failures, and a report-shaped final message. Every tab renders. Nothing under `src/` imports the stub, so it cannot reach a production build.

The harness uses `strictPort`. If port 5174 is taken it fails instead of drifting, because a drifted harness once landed on the Playwright port, where a local e2e run tested it in place of the checkout.

### B. Dev server against the hosted backend

```sh
npm run dev                                   # http://localhost:8080
```

> ⚠️ **With no `.env`, this talks to the LIVE hosted Supabase backend.** `src/integrations/supabase/client.ts` falls back to baked-in defaults on purpose, so a deploy without env vars still works. Signing in and running a scan therefore reads and writes real data and spends real provider credits.

### C. Dev server against your own Supabase project

```sh
cp .env.example .env              # macOS / Linux
# PowerShell: Copy-Item .env.example .env
```

`.env.example` is fully commented out, so the copy changes nothing until you uncomment lines. Set both of these to leave the hosted defaults behind:

```sh
VITE_SUPABASE_URL=https://<project-id>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon / publishable key from the dashboard>
```

Then apply the migrations to your project (see Backend below) and run `npm run dev`.

---

## Environment Variables

[`.env.example`](.env.example) is the single catalogue. It lists every variable the frontend and the edge functions read, with the default taken from source, in numbered sections:

| Section | What it covers |
|---|---|
| 1 | Frontend `VITE_*` variables |
| 2 | Variables the Supabase runtime injects (do not set) |
| 3 | Orchestrator selection, models, budgets |
| 4 | Health probe secret |
| 5 | Dark switches that default off |
| 6 | Run limits and budgets |
| 7 | Server-side breach display |
| 8 | Provider API keys (all optional; a tool with no key skips itself) |
| 9 | Legacy-restore switches |
| 10 | Kill switches |
| 11 | Optional distributed rate limiter |

**Frontend variables** (public, read at build time):

| Variable | Default | Effect |
|---|---|---|
| `VITE_SUPABASE_URL` | hosted backend | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | hosted backend | Anon / publishable key |
| `VITE_SUPABASE_PROJECT_ID` | unset | Project ref, also used to build the function URL |
| `VITE_ENABLE_GOOGLE_OAUTH` | hidden | `true` shows the Google sign-in button |
| `VITE_MASK_BREACH_VALUES` | off | `true` masks breach values behind click-to-reveal |
| `VITE_CO_RECORD_LINKAGE_DISABLED` | off | `true` restores pre-CO_RECORD clusters and graph |

**Edge function secrets** are never read from a local `.env`. They live in the Supabase project's secret store. Kill switches follow one rule: unset means the feature stays on, and `NAME=true` turns it off on the running build with no deploy.

The orchestrator needs one configured provider. In production that is `GLM_API_KEY` (or `DEEPSEEK_API_KEY`) with `DEEPSEEK_BASE_URL` and `DEEPSEEK_ORCHESTRATOR_MODEL_ID` for the vendor, plus `ANTHROPIC_API_KEY` as the backup. MiniMax and xAI Grok remain optional alternates, and the Lovable gateway is an opt-in last-resort fallback.

---

## Backend (Supabase)

**Migrations** live in `supabase/migrations/` and are applied in order. A deploy does not apply them. Apply a schema change first, verify it, and only then ship code that depends on it.

```sh
npx supabase link --project-ref <your-project-ref>   # a project you own
npx supabase db push
```

**Edge functions** are not deployed by merging, and not with `supabase functions deploy`. On the production project that command returns 403, because the project is owned by a platform account that ships functions through its own pipeline. The full recipe (stamp, surgical sync, the `verify:deploy` gate, the platform deploy message, the health check) is in [`CLAUDE.md`](CLAUDE.md) under "Deploy topology" and in [`.claude/skills/edge-deploy/SKILL.md`](.claude/skills/edge-deploy/SKILL.md). The only proof that a deploy happened is a moved `build` SHA at `?health=1`.

The frontend is different: merging to `main` ships it through Vercel.

---

## Development

```sh
npm run dev          # Vite dev server, port 8080
npm run build        # Production build → dist/
npm run preview      # Preview the production build locally
npm run lint         # ESLint (eslint .)
npm run typecheck    # Both tsconfig projects
npm run test         # Frontend unit tests (vitest run)
npm run test:edge    # Edge function tests (needs Deno)
npm run test:e2e     # Playwright specs against the harness build
```

Notes that have cost people time:

- **Use `npm run typecheck`.** A bare `npx tsc --noEmit` checks nothing here and returns 0 even on a syntax error.
- **`npm run test:edge` runs directories, not a `*_test.ts` glob.** Edge tests live in `supabase/tests/<function>/`, not in the function folder, because the platform refuses an upload over 4.5 MB.
- **`npm run test:e2e` is not run on pull requests.** CI runs it on pushes to `main` only, so run it by hand before merging a change that touches the workspace. It starts its own harness on port 5175; a stale harness already listening there will be reused and can hide a real failure.
- Test counts drift with every pull request. Read them from a fresh run instead of this file.

---

## Database

All tables are row-level-security protected and scoped to the authenticated user. The core tables are:

- `threads`: investigation cases
- `messages`: chat history with tool parts
- `artifacts`: extracted evidence (emails, IPs, domains and so on)
- `artifact_reviews`: analyst review states
- `agent_memory`: cross-investigation pattern store
- `investigation_cache`: cached scan results

Quarantined artifacts stay in the table with their reason. Quarantine removes authority, never existence.

---

## Smoke Tests

Checks that spend nothing:

1. **Repo checks:** `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build` all exit 0.
2. **Harness:** the workspace renders at the harness URL above, and every tab opens (Investigate, Evidence, Tools, Graph, Report).
3. **Signed out:** the app shows the sign-in page.

One check that costs a little: `?health=1` returns the expected `build` SHA (next section). It makes small calls to the orchestrator providers.

A real scan queries third parties and spends provider credits. Run one only on purpose, against a seed you are authorized to investigate.

### Health endpoint

```sh
curl -sS "https://<project-ref>.supabase.co/functions/v1/osint-agent?health=1" \
  -H "apikey: <publishable key>" | jq '{ok, build, build_committed_at}'
```

What it does, so you do not mistake it for a passive ping:

| Request | Behaviour |
|---|---|
| `?health=1` | Public. Reports `build` (the stamped git short SHA) and a `checks.*` map. **It contacts the configured orchestrator providers**, so it is not free and not offline. Status is `200` when ready and `503` when a required dependency is missing; read `checks.*` for the reason. |
| `?health=1&probe=1` | Paid deep probe. Needs the `x-probe-secret` header to match `OSINT_AGENT_PROBE_SECRET`; otherwise `403`. |
| `?health=1&maintenance=1` | **Writes to the database.** Runs stale-run recovery, the rejected-cluster sweep, credential health, and the synthesis and cache sweeps when those are switched on. The app itself calls this form. It is not a smoke test. |
| `HEAD ?health=1` | Status only, no body. |

A `404` means the function is not deployed. Use the deploy path in `CLAUDE.md`, not the Supabase CLI.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dev server shows real data and real accounts | No `.env`, so the hosted defaults apply | Use the harness, or set both `VITE_SUPABASE_*` values (path C) |
| `npm ci` errors on a peer dependency | `.npmrc` was bypassed | Run plain `npm ci`; `legacy-peer-deps=true` is set on purpose |
| Engine or version errors during install or e2e | Node older than 22.12 | Switch to Node 22.12+ |
| Harness: "Port 5174 is already in use" | Another harness is running | Stop it. Check which checkout the listener belongs to before trusting what it serves |
| `npm run typecheck` fails but `npx tsc --noEmit` passes | The bare command checks nothing | Trust `npm run typecheck` |
| "Session expired" toast | Auth token expired | Sign out and sign in again |
| "Access denied" toast | Wrong thread ID | Create a new thread |
| "Edge function not deployed" | `404` from the health probe | Deploy through the project's own pipeline (see Backend) |
| "Scan backend is not ready: …" toast | `ok:false` from `?health=1` | Set the missing secret the toast names; the orchestrator needs one provider key (`.env.example`, section 3) |
| "Scan backend timed out" | Cold start | Retry; the first call after a deploy is slow |
| A tool returns nothing | Its optional API key is unset | Set that key in the Supabase secret store (`.env.example`, section 8) |
| A tool reports a 403 | Often a blocked datacenter IP or a plan limit, not a dead key | Measure outcomes over real attempts before rotating anything |

---

## Security Notes

- All database tables have row-level security; users can only reach their own data.
- The edge function validates the auth header and thread ownership on every request.
- URL-fetching tools have SSRF hardening that blocks private and internal hosts.
- API keys live only in the Supabase secret store, never in frontend code. `VITE_*` values are public by design.
- Every `.env.*` variant and common key-material files (`*.pem`, `*.key`) are git-ignored; only `.env.example` is tracked. Never commit a populated env file.
- A key that was committed, pasted into chat or put in a document is compromised. Rotate it at the provider.

---

## License

Private repository. For personal/authorized use only.
