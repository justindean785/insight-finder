# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-10-10 (audit revalidation)
- **Audit every CLIENT writer of a server liveness column before gating on it.** S1a's lease read
  `last_heartbeat_at < 75 s` as "a run is live". `ChatWindow.beginInvestigation` had stamped
  `status:"active"` + a fresh heartbeat before every send since long before the lease, so every send
  refused itself with 409 for ~20 minutes on 2026-10-10 (09:36Z–09:43Z) until `RUN_LEASE_DISABLED=true`
  was set. The recovery module's own comment described that client stamp and I read past it. Rule: grep
  `src/` for every write to a column the edge is about to treat as a signal, and say in the PR which
  writers exist. The wiring test checked server-side ORDER and could never have caught a client write.
- **The kill switch earned its keep.** Rollback was one secret write through the Lovable agent and
  `/health` showed `LEGACY` within a minute, with no deploy. Every behaviour-changing edge PR keeps one.
- **`/health` is also the fastest honest instrument for an incident**, and the live DB is readable
  through the Lovable project's `query_database` (SELECT only): the two threads' rows, the empty
  `tool_usage_log` and the empty `orchestrator_invocations` window proved "no run was live" in three
  queries. Use it before theorising.

- **A lease without cleanup on every exit is a ghost-run factory.** S1a's first cut released only on the two
  402 exits; a thrown setup error after acquisition would have stranded a heartbeat-less marker for the stale
  sweep to reap as an "interrupted run". Hold startup-only state at the handler top, release it in the outer
  catch, and clear it at the real handoff so a genuine interruption marker is never erased.
- **A rollback snapshot is only trustworthy if the UPDATE proves it.** Reading the row and then updating it
  lets the row change in between (a run finishing), and restoring the stale read resurrects it. Add the read
  values to the UPDATE's WHERE (`IS NOT DISTINCT FROM`), retry once from a fresh read, and never admit on a
  persistent mismatch.
- **CI's Frontend job lints `supabase/functions/` too.** A Deno lint comment does not satisfy
  `@typescript-eslint/no-explicit-any`; type the structural db chain instead and cast supabase-js at the call
  site, as `reviews.ts` does for `ReviewDb`.
- **`threads.status` is NOT NULL.** A fixture row with `status NULL` fails the insert in the Migrations job; the
  `status IS NULL` branch of a predicate is unreachable on this schema.
- **The Lovable `send_message` MCP call can time out client-side at 60 s while the message never landed.**
  Check `list_messages` before resending; use `wait=false` and poll `get_message`, and treat `/health` as the
  only proof either way.

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
