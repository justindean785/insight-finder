# Lessons

Running log of non-obvious gotchas learned while working in this repo. Newest first.

## 2026-10-23 (Opsis guard ship, brendanloza measurements)
- **A pre-flight refusal's error text must match `tool-outcome.ts` `SKIP_RE`**, or its `tool_usage_log` row logs `failed`
  and counts against the tool's health. Pin it with a captured-row test (`opsis_search_guard_test.ts`).
- **`detectSeedServer` labels any few-word prose `person`** ("look into this for me"). It is a word count, not a shape;
  never treat `person` as structural in a fallback or an inferred kind.
- **`memoSchema` is module-global**: one schema per tool name for every thread, so a preprocess cannot know the thread's
  seed. Thread-aware defaults resolve in `execute`. **`triageState` (guard.ts) is shared across threads on an isolate.**
- **`applyInputCoercion` hands back the RAW input when the coerced value still fails validation**, so the rejection log
  can name a field the model never sent. Read `input_json.runtime.sent_keys` before calling a rename broken.
- **`orchestrator_invocations.credits_micro_usd` is tools + LLM** (the same accumulator as `threads.cost_micro_usd`),
  not LLM credits; adding the tool log to it double-counts.
- **The 220k prompt budget's un-trimmable floor is tool-call INPUTS** (`record_artifacts` batches above all); outputs are
  capped, inputs are not. `initial_context_chars` is measured after trimming.
- **The Opsis finalize collect phase cannot fire at the wall-clock trigger** (its own comment); the money fix is on the
  SEARCH side (#833), never more work inside the finalize window.

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
