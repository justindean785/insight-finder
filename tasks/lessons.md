# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-10-10 (audit revalidation)
- **An audit baseline is a dated measurement, not a state.** The 2026-10-10 audit's baseline (`main`
  `219732c`, live `2e5f78c`, "#724 not live") was overtaken within hours: `main` is `811acf3`, live is
  `f9fc281`, #724 is merged and live. Re-measure `git log` and `/health` (once) before acting on any
  audit number.
- **`invalid_type` on a required string is not catalog name drift.** The catalog entries for
  `serus_darkweb_scan`, `google_dorks`, `oathnet_lookup` and `socialfetch_lookup` already name the real
  zod fields; the 82 rejected calls sent the wrong *shape or type*. #698's five drifts are a different
  set. Read `tool_usage_log.input_json.sent_keys` (#697) before designing a fix.
- **`markRunStarted` is unconditional** (`recovery.ts:873`): it is a marker, not a lease. The frontend
  `server_running` refusal is per-tab and advisory. Overlapping invocations (21 of 94 in the window) are
  therefore expected, not anomalous, until an atomic conditional update lands.
- **`persistFinalMessages` runs from the browser's stream cancel too** (`lib/run-end.ts` header). The
  `premature_client_cancel` marker is the measurement; it is not a mobile-backgrounding diagnosis.
- **#593 (dedupe) is the correct fix shape and is still a draft**; `main`'s `dedupeArtifacts` still
  takes max confidence and spreads later metadata. Do not re-implement it; rebase it.
- **The lineage table is absent on the live DB** regardless of what any ledger says (`schema2` query
  returned null). A deployment ledger records a deploy, not a migration.

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
