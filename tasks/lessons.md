# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-07-14 (release triage)
- **The live health curl is egress-blocked in the web/remote environment.** The proxy returns
  an org-policy `403 CONNECT` for `skzqwbyvmwqarfgfvyky.supabase.co`, so `/health` cannot be read
  here. Establish backend/DeepSeek "deploy truth" via the mirror repo (`build-info.ts`,
  `health-handler.ts`) + the Lovable connector instead — never claim a live build from this box.
- **Prod DB is reachable READ-ONLY via the Lovable MCP connector** (`query_database` on project
  `4ce11bc3…`). Aggregate-only SELECTs reproduce the migration impact with no PII pulled, no DDL,
  no locks. This is the authorized read-only inspection path when curl/Supabase egress is blocked.
- **`deno` is NOT installable in this environment** (egress blocks `dl.deno.land`), so
  `npm run test:edge` can't run locally — rely on the CI `Edge functions (deno test)` check.
  But **Postgres server binaries ARE present** (`/usr/lib/postgresql/16/bin`), so the full CI
  `migrations` job runs locally against a throwaway cluster (must run as a non-root user; PG
  refuses root — `useradd pg` + datadir under `/home/pg`).
- **#307's "53 analyst reviews repointed" is imprecise.** Read-only prod audit: 53 reviews sit on
  collapsing groups, but only **1** is on a non-survivor (repointed); **52** are already on the
  survivor (untouched), and **0** evidence rows repoint. The safety conclusion (0 discarded) holds;
  the count was overstated. Always distinguish "on a collapsing group" from "actually repointed".
- **DeepSeek was deployed to prod DIRECTLY via Lovable `deploy_edge_functions`, not the canonical
  recipe** — so `build-info.ts` was never re-stamped (still `4692afa`) and there is no
  `checks.deepseek` diagnostic in the mirror's `health-handler.ts`. The git branch
  `feat/deepseek-orchestrator-hardening` (`e6e24db`) is a *separate, more complete* implementation
  that is neither merged nor deployed; its tip `87031da` mixes in OathNet/breach work.

## 2026-06-27
- **Two `<think>`-strip paths existed, only one was wired.** `ChatWindow.tsx` strips
  `<think>` for *rendered* chat text (line ~828) but the **Next Steps** cards parse the
  *raw* assistant message via `extractRecommendedPivots` (`recommended-pivots.ts`), which
  had no sanitization — so reasoning leaked only into the cards, not the chat. Lesson: when
  the same backend text feeds two surfaces, sanitize at the shared source, not per-surface.
- **PR target remote is `origin` (`justindean785/insight-finder`).** `mirror` points to the
  Lovable backend repo `seeker-spark-search-5362c57c` — never open frontend PRs there.
- **The local dev server hits the LIVE backend.** `src/integrations/supabase/client.ts` bakes
  in the prod Supabase URL + anon key (`skzqwbyvmwqarfgfvyky`), so `npm run dev` authenticates
  against real data. With the user's login you can drive the actual authenticated workspace
  (real cases, real Next Steps) locally — full browser QA IS possible here, contrary to prior
  passes' assumption. (Auth is Supabase email/pw, shared across the Vercel + Lovable frontends.)
- **Worktrees share the parent checkout's `node_modules`.** A worktree off `main` whose
  `package.json` lists `@vercel/speed-insights` will fail `build`/`typecheck` if the parent's
  shared `node_modules` was installed for a branch lacking it. Fix locally with
  `npm install --no-save <pkg>` from the parent — don't touch the lockfile.
