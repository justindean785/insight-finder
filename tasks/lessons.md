# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-10-18/19 (full review, integrity re-trace, free-tool PRs)
- **`npm run verify:deploy` is not read-only either.** `scripts/record-deploy.mjs:47,76` fetches `/health`, so the "read-only" gate makes the same paid GLM
  call and recovery writes. For an audit, compare trees instead: `git rev-parse origin/main:supabase/functions/<fn>` against the same path in the mirror.
- **Textual mergeability is not integration.** #763 shows no conflict on GitHub yet fails `src/test/edge-deploy-bundle.test.ts` once merged, because it
  predates #774 and keeps its tests under `supabase/functions/`. Before calling any older edge PR ready: `git worktree add --detach <scratch> origin/main`,
  `git merge --no-ff <head>` there, run the full suite, never push that merge.
- **Interleaved successes prove a key works, not why each call failed.** Jina had 257 ok and 11 raw 403s in 30 days, mixed together. That rules out a dead
  key; it does not prove each 403 was the target's page. The bodies are not stored, so the cause stays Unverified until the tool logs Jina's error `name`.
  Make a cause measurable before encoding it as a rule.
- **Budget the SUM of sequential sub-queries against the wrapper cap.** `wayback_cdx_search` ran two CDX queries in series, each on a 12 s `fetchRetry` with a
  retry: worst case about 48 s against a 25 s cap. Production showed it (1 ok, 21 failed in 30 days). Run them in parallel, give each its own timeout, keep
  partial answers, and test the budget arithmetic (`waybackCdxBudgetSelfTest`).
- **`{...modelMetadata, ...serverKeys}` makes every key the server does not overwrite model-writable.** `tool-registry.ts:5712`/`:6182` spread model
  metadata into artifacts with the user-JWT client; RLS only checks `user_id`. The name-only guard at `:5749` covers one branch. Measure prevalence before
  ranking it: `reviewed` 0 and `linkage_confirmed` 0 across 11,082 rows, so it is a latent hole, not an active leak.
- **A free-string citation list is authority.** `record_finding.supporting_sources` → `classifySource` → `countIndependentClasses` → `deriveStatus`
  (`confidence.ts:714`, two classes = confirmed). Nothing checks the named tool ran in the thread; one of 25 production findings cites a tool that never ran.
  The E3 guard (`MEMORY_TOKEN_RE`, `lib/memory-context.ts:18`) only catches tokens starting with `memory`.
- **A display merge can become stored data.** The quarantine-release writer (`ResourcesPanel.tsx:957`) writes `{...meta, ...patch}` from the DEDUPED item,
  so whatever `dedupeArtifacts` (`useThreadArtifacts.ts:70-99`) merged in is persisted onto the surviving row. Trace every writer that reads a view-model.
- **Parallel subagents in one clone clobber `FETCH_HEAD`.** Read PR heads by SHA (`git show <sha>:path`), never `FETCH_HEAD`.
- **Verify an agent-authored plan item by item before building it.** The Lovable free-tool prompt asked for C2 (skip a provider on 401/402), which already
  existed at `circuit.ts:474-492`; an auto-dispatch engine that does not exist; a call "before finalize" (inside the finalize window); and public URL
  submission on every URL (OPSEC). Each needed a separate ruling.
- **An outside reviewer caught four of my own overstatements.** An agent-reported credit shortage is a dated report, not a verified fact. An MX lookup
  discloses the domain to the DoH resolver. Number-to-string repair cannot restore leading zeros or precision, so repair only when unambiguous. "Blocked
  on money, not code" was false while three integrity defects were open. Label causes and money claims with their source and date.
- **When Codex is out of quota, review with subagents that must reproduce.** Ask for a failing test or a file:line trace per claim; a review answered from
  reading alone gives plausible findings you then have to re-verify yourself.
- **Merge one PR at a time.** After each: main CI green (the `e2e` job runs on push only), Vercel production READY on the new SHA, then the next one.

## 2026-10-13
- **A read-only DB trace beats inference.** Two separate corrections came only from queries: the thread holds THREE runs (not two), and the three cache hits in run 1 came from a different thread started 15s earlier. Ask for the data path before reasoning about it.
- **`agent_memory` has no writer or provenance column, and the browser's analyst lesson and the model's `memory_save` use the same `save_agent_memories` RPC.** Analyst authorship can only be inferred from wording; never claim it. The upsert overwrites `source_thread_id`, ratchets confidence, keeps the longer content and bumps `hit_count`/`last_used_at`, so those columns are not recall evidence.
- **`tool_usage_log` stores no tool output**, so which memory rows were recalled cannot be reconstructed from it.
- **The orchestrator's budget elision cuts assistant text to 200 chars** (`elideAssistantText`); a prefix label longer than that is silently destroyed. Test any prompt prefix through the real `capTotalToBudget`, not just `truncateStr`.
- **Frontend suites import `system-prompt.ts`**, so anything it imports must not touch `Deno` directly (use the `globalThis.Deno` pattern in `lib/memory-context.ts`); `npm run typecheck` catches it, `deno test` does not.
- **`/health?health=1` is a GET with side effects.** `health-handler.ts` runs `recoverStaleActiveThreads` (DB writes), the rejected-cluster sweep,
  finding synthesis and live provider pings. Use `deploy-log.jsonl`, `deploy/live` and the mirror git log instead.
- **A footer is not a control.** The Evidence Record already says "No authoritative finding rows ... nothing in the narrative above was adjudicated",
  while the stored narrative keeps its `[CONFIRMED]` tags (14 in one case). `narrativeIsUnadjudicated` only shows a notice.
- **Two breach tools are one source.** `breach_check` and `oathnet_stealer_search` classify to the same `breach` class (count 1), so "4 independent
  stealer-log sources" is not a count the engine would produce.
- **Do not trust a code-review subagent's single-tree answer.** It reported `/timing` and the sidebar RPC "not reproduced" because it read only canonical;
  both exist in the Lovable mirror's frontend. Check both trees before classifying a Lovable warning.
- **When calling a helper in a repro, read its signature.** `shapeJinaBody(url, text, maxChars)` was first called as `(body, 200)` and threw; the Jina
  error format is anchored (`URL Source:` then `Warning: Target URL returned error N`). A repro that does not match the real input shape proves nothing.
- **Activity "Succeeded" = Health "Succeeded" + "No record"** (26 = 24+2, 47 = 41+6). The header's "N evidence" is `evidence_log` custody entries, not artifacts.
- **`deno test` rewrites `deno.lock`** even with `--no-lock` passed through `npm run`; `git checkout deno.lock` afterwards.


## 2026-10-10 (audit revalidation)
- **Implemented, deployed and enabled are three states; documents must say which.** S1a is the first two. A PR body that read "not started" outlived
  the work by hours, and a handoff saying "unbuilt" would have sent a fresh session to rebuild it. Update the status line in the same PR that changes it.
- **A `.git/handoffs/` note is local to one clone.** Fresh cloud sessions clone anew and never see it. Durable handoffs live in the repo root as
  `SESSION_HANDOFF_<date>_<slug>.md` and are linked from `CLAUDE.md`.
- **Never replace a checklist file without archiving it.** `tasks/todo.md` was overwritten; the old content (20 unchecked items) now lives in
  `docs/archive/TODO_2026-06_workspace-ui-plan.md`.
- **Audit every CLIENT writer of a server liveness column before gating on it.** S1a's lease read
  `last_heartbeat_at < 75 s` as "a run is live". `ChatWindow.beginInvestigation` had stamped
  `status:"active"` + a fresh heartbeat before every send since long before the lease, so every send
  refused itself with 409 on 2026-10-10 (one captured refusal carried `last heartbeat 09:36:34Z`) until
  `RUN_LEASE_DISABLED=true` was set. The recovery module's own comment described that client stamp and I read past it. Rule: grep
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
