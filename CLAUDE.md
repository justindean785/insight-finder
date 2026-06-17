# CLAUDE.md — read first

Project: **Insight Finder** (a.k.a. Swarmbot) — an OSINT investigator. Vite + React + TS + Tailwind/shadcn frontend; Supabase (Postgres/Auth/Storage + **3 Deno edge functions** — `osint-agent`, `evidence-export`, `security-test-lab` — sharing `supabase/functions/_shared/`) backend.

## ⚠️ Deploy topology — the #1 thing to get right

There is **ONE place to work: this repo, `justindean785/insight-finder`** (local: `/Users/dizosint/insight-finder`, production branch `main`). Everything below was consolidated 2026-06-13 after the setup sprawled across 5 repos / 3 hosts. Do not recreate that sprawl.

```
        WORK HERE → github.com/justindean785/insight-finder (main)
                       │                         │
          merge PR ↓ (frontend)     sync functions/ via PR ↓ (backend)
                  VERCEL                seeker-spark-search-5362c57c
               (the app UI)              → Lovable auto-deploys
                       └──────────┬───────────────┘  ALL edge functions
                                  ▼
                  ONE Supabase backend: skzqwbyvmwqarfgfvyky
```

### Frontend → Vercel
- Vercel project `insight-finder` deploys this repo's `main`. `vercel.json` is committed. **Merge a PR to `main` → frontend ships.** Use the **Vercel URL** as the real app.
- **Netlify is NOT used** (a stray `netlify.toml` was removed). Don't re-add it.
- The Lovable-hosted frontend (`*.lovable.app`) is **deprecated** — both frontends hit the same Supabase backend, so Vercel already works against live data.

### Backend (3 edge functions) → via Lovable
- The Supabase project `skzqwbyvmwqarfgfvyky` is **owned by Lovable Cloud**, not the user. Lovable deploys the edge functions from **its** connected GitHub repo `justindean785/seeker-spark-search-5362c57c` (branch `main`).
- **Do NOT use `supabase functions deploy`** — the user's token 403s on that project (ownership wall). It is the wrong channel.
- **The backend is 3 functions + a shared module. A sync MUST cover all that changed — not just `osint-agent/`** (the old single-function recipe is why `evidence-export` drifted below):
  - `supabase/functions/osint-agent/` — 72 files; live tool defs inline in `index.ts`
  - `supabase/functions/evidence-export/` — PDF/zip export; `index.ts` + `text-sanitize.ts` (+ test)
  - `supabase/functions/security-test-lab/` — admin-only red-team harness; `index.ts`
  - `supabase/functions/_shared/ai-gateway.ts`
- **To ship a backend change:** edit here in `insight-finder`, then sync the changed function(s) into `seeker-spark-search-5362c57c` via a PR (the `gh` token can push there), merge → Lovable auto-deploys. Per function: `cp -R supabase/functions/<fn>/. <clone>/supabase/functions/<fn>/` + a `git diff` review.
- **Sync = true merge, NEVER `rsync --delete` / blanket overwrite.** The mirror has at times held Lovable-authored work not yet backported (e.g. the #16 source-classification rework — see `PR_BODY_backport-16.md` in the `pr2` worktree); a delete-sync would clobber it.
- **Known parity/drift (verified 2026-06-17):** `osint-agent`, `security-test-lab`, and `_shared/ai-gateway.ts` are **byte-identical** between `insight-finder/main` and the mirror. **`evidence-export` HAS DRIFTED** — the mirror runs an older 273-line `index.ts` with no `text-sanitize.ts`, so the *deployed* export path lacks the WinAnsi-sanitizer refactor that's on `insight-finder/main`. Sync it deliberately (reviewed PR), not blindly. Further evidence-export 500 fixes also sit unmerged on the `fix/evidence-export-500` branch (`insight-finder-ee` worktree).
- Edge-function secrets live in Supabase function settings (e.g. `IPQUALITYSCORE_API_KEY`, `SERUS_API_KEY`). Tools self-skip if their key is missing.

### Dead repos — ignore
`seeker-spark-search`, `seeker-spark-search-5fea4dc8`, `seeker-spark-search-ec85cfea` are **archived dead spawns** from past Lovable reconnect cycles. The ONLY live Lovable repo is `…-5362c57c`. Never push to the others; never disconnect/reconnect GitHub in Lovable (it spawns more dead repos).

## Edge function internals (gotchas)
- **Live tool defs are INLINE in `supabase/functions/osint-agent/index.ts`** (~4500 lines). Files under `tools/*.ts` are **stale auto-extracted mirrors** used only by the catalog↔runtime contract test — keep them in sync when adding a tool, but the inline def is what runs.
- Tests: `cd supabase/functions/osint-agent && deno test --allow-net --no-check`. `deno check index.ts` has ~12–157 **pre-existing** AI-SDK/Supabase type-graph errors — not a gate; verify your change adds none.
- Frontend tests: `npx vitest run` from repo root.

## Evidence-integrity rules (do not change without explicit approval)
Evidence ranking, confidence caps, chain-of-custody, credential masking, minor-safety detection, and the audit/coverage behavior are integrity-critical. Treat changes to them as requiring sign-off.

## Misc
- Today's working topology + history is also in the user's agent memory (`canonical-deploy-topology.md`, `deploy-blocker-lovable-supabase.md`).
- A few non-default local branches/worktrees with unmerged work exist (`claude/upbeat-darwin-y842dl`, `left/beta-p0`, `insight-finder-tier0`) — leave them unless asked.
