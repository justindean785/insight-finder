# Insight Finder — Multi-Agent OSINT Investigation Platform

An AI-native open-source intelligence workstation. Orchestrates 14 specialized OSINT agents through a Supabase Edge Function, streams findings into a real-time React dashboard, and maintains cross-investigation memory via an Agent Brain.

**Stack:** React 18 + TypeScript + Tailwind CSS + shadcn/ui | Supabase (Auth, DB, Storage, Edge Functions) | AI SDK

> **React version:** This project is intentionally pinned to **React 18** (`react`/`react-dom` `^18.3.1`, matching `@types/react` 18.x and the resolved `package-lock.json`). It uses no React-19-only APIs (`useOptimistic`, `useActionState`, `useFormStatus`, `use()`, server actions). `react-leaflet@5` declares a React 19 peer dependency that works fine at runtime against React 18; `.npmrc` sets `legacy-peer-deps=true` to suppress the peer-mismatch error. Do not bump to React 19 without an explicit migration.

**URL:** https://github.com/justindean785/insight-finder

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Vite + React)                                    │
│  ChatWindow → Edge Function (SSE stream)                    │
│  ResourcesPanel → Evidence, Analysis, Provenance, Output    │
│  ThreadSidebar → Investigation list, Total Spend KPI        │
│  Agent Brain → Cross-investigation memory + pattern store   │
└──────────────────────────┬──────────────────────────────────┘
                           │ Bearer token (Supabase Auth)
┌──────────────────────────▼──────────────────────────────────┐
│  Supabase Edge Function: osint-agent                        │
│  Auth → Thread ownership → Orchestrator (MiniMax/Lovable)   │
│  → 14 tool agents → Artifact persistence → SSE response     │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- Node.js ≥ 20 + npm (or bun)
- Supabase account + CLI (`npx supabase --version`)
- A Supabase project linked for local dev

---

## Quick Start

```sh
# 1. Clone
git clone https://github.com/justindean785/insight-finder.git
cd insight-finder

# 2. Install
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Supabase project credentials (see below)

# 4. Start dev server
npm run dev
```

---

## Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL (e.g. `https://abc123.supabase.co`) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase anon/public key |
| `VITE_SUPABASE_PROJECT_ID` | Fallback | Used if `VITE_SUPABASE_URL` is not set |

**Edge Function secrets** (set in Supabase Dashboard → Edge Functions → osint-agent → Secrets):

| Secret | Required | Notes |
|--------|----------|-------|
| `MINIMAX_API_KEY` | At least one required | Primary orchestrator (MiniMax-M2.7) |
| `LOVABLE_API_KEY` | At least one required | Fallback orchestrator (Lovable gateway) |
| `OATHNET_API_KEY` | Optional | Breach database + stealer log lookups |
| `SERUS_API_KEY` | Optional | Serus darkweb exposure scan (email/phone/username/domain/keyword/origin/password) — 0.25 credits/scan, optional `reveal` scope for unmasked breach fields |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Optional | Distributed per-user rate limiter (30/min, 300/hour). Without these, falls back to a per-instance in-memory cap. Free tier 10k req/day. |
| `EXA_API_KEY` | Optional | Semantic web search |
| `HUNTER_API_KEY` | Optional | Email verification |
| `SOCIALFETCH_API_KEY` | Optional | Social media presence checks |
| `SYNAPSINT_API_KEY` | Optional | Domain intelligence |
| `OSINTNOVA_API_KEY` | Optional | OSINT lookups |
| `CORDCAT_API_KEY` | Optional | Data correlation |

---

## Supabase Setup

> **Note:** the steps below assume a Supabase project **you** own/link directly.
> If your Supabase project is owned by a third-party platform account (e.g. a
> Lovable Cloud-managed backend), `supabase functions deploy` will 403 — the
> owning platform must ship the function through its own deploy pipeline
> instead. Check with whoever owns the project before assuming this command
> applies.

```sh
# 1. Initialize Supabase locally (if not already linked)
npx supabase init

# 2. Link to your project
npx supabase link --project-ref <your-project-ref>

# 3. Apply migrations (creates tables + RLS policies)
npx supabase db push

# 4. Deploy the edge function
npx supabase functions deploy osint-agent

# 5. Set orchestrator secrets (at minimum)
npx supabase secrets set MINIMAX_API_KEY=<your-key> --env production
# OR
npx supabase secrets set LOVABLE_API_KEY=<your-key> --env production
```

---

## Development

```sh
npm run dev        # Start Vite dev server (port 8080)
npm run build      # Production build → dist/
npm run preview    # Preview production build locally
```

### Lint

```sh
npm run lint       # ESLint across src/
```

---

## Database

All tables are RLS-protected and scoped to the authenticated user:
- `threads` — Investigation cases
- `messages` — Chat history with tool parts
- `artifacts` — Extracted evidence (emails, IPs, domains, etc.)
- `artifact_reviews` — Analyst review states (confirmed/dismissed/key/recheck)
- `agent_memory` — Cross-investigation pattern store
- `investigation_cache` — Cached scan results

Migrations live in `supabase/migrations/` and are applied in order.

---

## Smoke Tests

After setup, verify the platform works:

1. **Auth flow:** Navigate to the app. You should be prompted to sign in/up.
2. **Create thread:** Click "New investigation" in the sidebar. A thread appears.
3. **First scan:** Enter a seed (e.g. `test@example.com`) and submit. Agents should begin streaming findings.
4. **Evidence panel:** Artifacts appear in the right panel under Evidence → Artifacts.
5. **AI report:** After agents complete, an AI analysis appears in the chat.
6. **Pivots:** Pivot targets appear in the Analysis → Pivots tab.
7. **Agent Brain:** Click the Brain icon. Cross-investigation memories accumulate.

### Health/readiness probe

The `osint-agent` edge function exposes a lightweight readiness endpoint used by the frontend preflight (before every scan) and by ops smoke tests. It does **not** invoke the LLM, the rate limiter, or the database — it only checks which secrets are configured.

| Trigger | Status | Body |
| --- | --- | --- |
| `GET /functions/v1/osint-agent?health=1` | `200` when ready, `503` when not | `{ ok, service, version, checks: { orchestrator, core, tools }, intelbase_enabled }` |
| `HEAD /functions/v1/osint-agent?health=1` | `200` when ready, `503` when not | (no body) |
| (no `?health=1` query) | normal flow | auth + scan handler |

Interpretation:

- **404** — function is not deployed. Run `npx supabase functions deploy osint-agent` (or, if the project is owned by a third-party deploy pipeline, trigger that pipeline instead — see the note under Supabase Setup above).
- **200 + `ok:true`** — ready to scan.
- **503 + `ok:false`** — function is deployed but a required dep is missing. Inspect `checks.orchestrator.detail` / `checks.core.detail` for the exact missing secret(s). The frontend will block the scan and surface the detail in a toast.
- `checks.tools.detail` reports `configured/13 optional tool APIs` — informational only, never blocks a run.

Quick CLI check after deploy:

```sh
curl -sS "$VITE_SUPABASE_URL/functions/v1/osint-agent?health=1" \
  -H "apikey: $VITE_SUPABASE_PUBLISHABLE_KEY" | jq .
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Session expired" toast | Auth token expired | Sign out and sign in again |
| "Access denied" toast | Wrong thread ID | Create a new thread |
| "Edge function not deployed" toast | Function not pushed | `npx supabase functions deploy osint-agent` (self-owned project) or the project's own deploy pipeline (third-party-owned project) |
| "Edge function not deployed" pre-scan | 404 from `/health` probe | Deploy the function |
| "Scan backend is not ready: …" toast | 200 + `ok:false` from `/health` | Set the missing secret named in the toast (usually `MINIMAX_API_KEY` or `LOVABLE_API_KEY`) |
| "Scan backend timed out" | Cold start | Retry; first invocation after deploy takes ~5-10s |
| Agents run but no output | Missing orchestrator key | Set `MINIMAX_API_KEY` or `LOVABLE_API_KEY` in Supabase secrets |
| Specific tool returns no data | Missing optional API key | Set the corresponding key in Supabase secrets |
| Module not found errors | Dependencies not installed | `npm install` |

---

## Security Notes

- All DB tables have Row-Level Security (RLS) — users can only access their own data
- Edge function validates auth header + thread ownership on every request
- URL fetch pathways have SSRF hardening (blocks private/internal hosts)
- API keys are stored only in Supabase Edge Function secrets — never in frontend code
- `.env` is gitignored; never commit Supabase keys to the repository

---

## License

Private repository. For personal/authorized use only.
