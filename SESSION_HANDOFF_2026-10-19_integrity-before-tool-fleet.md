# SESSION HANDOFF — 2026-10-19: integrity before tool fleet (session claude/code-review-lovable-vercel-0knfbb, PR #793)

## Goal
This branch is the session's audit and docs home, PR #793 (draft). It holds the 2026-10-18 full code review, the evening re-measure, and the review corrections. The fixes it led to are separate PRs on their own branches; see Status.

## JD's latest direction (2026-10-19, ~01:00Z, typed, then interrupted)
"Do what's best, you have creative control, for app expansion and improvement, without messing up breach reveal or the agents' ability to pivot and scan data."
- **Read this as broad delegation, with two hard lines:**
  1. **Breach reveal:** never touch it. `REVEAL_BREACH_DATA` stays ON (CLAUDE.md "SETTLED").
  2. **Pivot and scan:** never degrade the agent's ability to pivot or scan. No new tool suppression, no dispatch blocking of quarantined selectors (#581 tainted them on purpose), and no shrinking the tool set.
- **Standing rules from earlier in the session, still in force unless JD lifts them explicitly:**
  - **No merges, deploys, secret changes, prod data repairs, PR closures or Lovable messages** without JD's explicit go. Before the merge train (#794–#796) JD said "Merge all three in order"; that go was per-batch. "Do what's best" is broad, but deploys and merges stay JD-gated by CLAUDE.md, so ask.
  - `RUN_LEASE_DISABLED=true` stays.
  - The orchestrator pin is unchanged.
  - OathNet is JD's to handle.
  - `/health` is NOT passive: it makes a paid GLM call and runs recovery/sweep writes. Production reads are SELECT-only (`mcp__Lovable__query_database`, project `4ce11bc3-039d-4439-b293-acacca9e1e3a`).
  - Evidence-integrity changes (caps, quarantine semantics, analyst authority, corroboration counting) need JD's sign-off.

## Status (verified 2026-10-19T00:53Z)
- **`main` is `8fae8c8`**, which is #798. Vercel production is READY on it.
- **Edge.** `deploy/live`, the `BUILD_MARKER` and the ledger all say `cabfeb9`. The mirror `seeker-spark-search-5362c57c` is at `98c015e`, and all four shared function trees are EQUAL. The live runtime is Unverified (no `/health` call).
- **Merged and live this session:**
  - #794 F6 breach-table authority (`940d793`)
  - #795 F10 sidebar finished-write (`14f26fe`)
  - #796 F13 Retry/Re-run guard (`91bfefb`)
  - #798 Cases/case page show dead runs as Interrupted (`8fae8c8`)
- **Open PRs from this session:**
  - **#797** F3 dispatch-selector aliases, edge. Ready, not a draft. Codex-clean, all threads resolved. Tested merged with `main` at 21:03Z: vitest 2653/1/210, edge 2475/0/6. **Awaits JD merge + deploy.**
  - **#799** Jina raw 403 is page-level, not provider suppression, edge. Draft, CI green. **Reviewer correction:** the cause of each 403 is Unverified (bodies are not stored). Proposed amendment, not pushed: keep suppression when the Jina error body indicates auth/billing/quota, and log Jina's error `name`.
  - **#800** wayback_cdx_search runs its 4 archive.org queries in parallel and keeps partial answers, edge. Draft, CI green. A risk was added to the PR body: an availability-only "archived" can be a canonicalized URL variant (`closest.url` is not compared).
  - **#593** (another session's) dedupe authority donation, frontend. Tested merged with `main`: vitest 2736/1/213, e2e 52/2. **Needs JD's choice: option A, B or C** (audit §10.3 C).
- **Production at 00:53Z:** the last scan was at 19:34Z on 10-18. Nothing has run since, so the new `GITHUB_API_TOKEN` (saved 10-18 19:48Z via Lovable) is still unexercised. Lovable last reported credits exhausted at 19:55Z. That is reported only, not verified.

## Open / next (recommended order: integrity before tool fleet; see audit §8 and §10)
1. **#797:** JD merge, then the deploy cycle (stamp, surgical mirror sync, `verify:deploy` gate, Lovable message, `/health` SHA check, ledger). Blocked on a working Lovable route or credits.
2. **#741:** rebase it onto `main`.
   - Two import-only conflicts, in `tool-registry.ts` and `health-handler.ts`.
   - `git mv` its 2 test files to `supabase/tests/osint-agent/` and repoint the imports to `../../functions/osint-agent/`.
   - Add one rule: a model-supplied protective flag (`subject_unlinked`, `possible_minor`, …) is kept only when `true`.
   - Add tests for non-name rows (username with `linkage_confirmed` / `reviewed` / `subject_unlinked:false`).
   - Needs JD sign-off.
3. **Executed-source gate (new, unbuilt).** A tool named in `record_finding.supporting_sources` must have run in the thread to grant a class; filter, never reject. Kill switch `UNEXECUTED_SOURCE_GATE_DISABLED`, health key `checks.executed_source_gate`. Needs sign-off.
4. **#593:** JD picks A, B or C.
5. **#738:** land only its `MEMORY_TOKEN_RE` tokenizer slice; the rest is prompt wording.
6. **#799** amendment and **#800**, then the §8b free-tool plan as corrected. New third parties (CertSpotter, Photon, PullPush/Arctic Shift, XposedOrNot) each need JD's OK.
7. **Queue hygiene, needing JD's go:** close #764 (superseded by #765) and #701 (wrong premise); close or restart #516; mirror #117 goes with F21.
8. **Time-sensitive:** the Anthropic backup credit reportedly expires 10-23 (Unverified). Z.AI ran dry mid-run at 10-18 06:31Z.

## Key decisions (and why)
- **One behaviour per edge PR**, each with a kill switch and a `/health` proof key. Only one edge PR is shipped at a time. #797 → #799 → #800 are serialized because `/health` proves a build, not a change.
- **The free-tool prompt is not built as one change.**
  - C2 (skip provider on 401/402) already exists: `circuit.ts:474-492`.
  - C1 is mostly done.
  - There is no auto-dispatch engine. Building one fights `MAX_CONCURRENT_CALLS=3`, `MAX_PAID_CALLS` and the termination history, so the B items become guidance only.
  - `opsis_results` would not run "before finalize": that is inside the finalize window, which CLAUDE.md forbids.
  - `archive_url` / `urlscanner_scan` are not run on every URL: an OPSEC hazard, they are public submissions.
  - The `gemini_deep_dork` timeout stays as is: it is a recorded, test-pinned decision.
- **Fallbacks go INSIDE existing tools**, so no new tool schemas are added to every model step (schema bytes per step).
- **Read-only review mode** applies only because of JD's pasted reviewer prompt, which said no product-code edits before approval. JD's later "do what's best" relaxes that, but merges and deploys still need asking.

## Gotchas
- **`npm run verify:deploy` calls `/health`** (`scripts/record-deploy.mjs:47,76`). Compare trees manually instead: `git rev-parse origin/main:supabase/functions/<fn>` vs the mirror's.
- **Sandbox network.** It cannot reach `web.archive.org` (connection reset), and `archive.org/wayback/available` works. Never contact provider APIs to "test".
- **Old test layout.** Edge PRs predating #774 keep tests under `supabase/functions/`, which fails `src/test/edge-deploy-bundle.test.ts` once merged. GitHub shows no conflict for this.
- **Deno and lockfiles.** Always run deno with `--config=../../functions/osint-agent/deno.json --no-lock` from `supabase/tests/osint-agent`. Running deno at the repo root rewrites `node_modules` and `deno.lock` (F31).
- **Codex has hit its usage limit.** Use subagent reviews instead.
- **Shared `FETCH_HEAD`.** Subagents sharing the clone clobber it; read PR heads by SHA (`git show <sha>:path`).
- **Release writer.** `src/components/ResourcesPanel.tsx:957` writes `{...meta, ...patch}` from the deduped (merged) item onto the surviving row. A display merge can therefore become stored data. #593 fixes the merge.
- **Lovable bot commits** to the mirror (`4d667bc`, `98c015e`, 10-18 19:40Z) touched only `src/integrations/supabase/previewAuthStorage.ts`. Not edge.

## Map
- Audits:
  - `docs/AUDIT_2026-10-18_full-code-review-lovable-vercel-github.md` (findings F1–F33)
  - `docs/AUDIT_2026-10-18-evening_state-pr-queue-next-tasks.md` (F34–F41; §8 order; §8b tool plan; **§10 review re-trace with file:line**)
- `tasks/todo.md`: section "2026-10-18 evening review", appended at the end.
- Integrity defects, with file:line in audit §10.3:
  - A (#741): model-writable analyst keys, `tool-registry.ts:5712` / `:6182`; name-only guard `:5749`.
  - B (new): memory → confirmed, `tool-registry.ts:6856`, `lib/finding-row.ts:95-97`, `confidence.ts:714`, `system-prompt.ts:145`, `lib/memory-context.ts:18`.
  - C (#593): `src/hooks/useThreadArtifacts.ts:70-99`.
- Edge PR modules: `lib/dispatch-selector.ts` (#797), `lib/jina-http-error.ts` (#799), `lib/wayback-cdx.ts` (#800).

## Verify
- Frontend: `npm ci && npm run lint && npm run typecheck && npx vitest run && npm run build`. Green on `main`: 0 lint errors, vitest 2653/1/210.
- Edge: `cd supabase/tests/osint-agent && deno test --config=../../functions/osint-agent/deno.json --no-check --no-lock --allow-net --allow-env --allow-sys --allow-read . ../evidence-export`. Green on `main`: 2449/0/6.
- e2e: `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e` → 52 passed / 2 skipped.
- Integration test for a PR: `git worktree add --detach <scratch> origin/main`, then `git merge --no-ff <pr-head>` there, then run all of the above. Never push that merge.
- Safety-net check-in scheduled for 2026-10-19T02:14Z (trig_01XE8dyPwkkdPHFicZrQBs2r): it re-checks #797/#593/#799/#800 and re-arms quietly; at most 3 quiet runs.
