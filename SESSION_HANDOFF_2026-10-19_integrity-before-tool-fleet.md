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

## Done since the last save (the 2026-10-14 handoff #760 and the 2026-10-15 CLAUDE.md update #770)
Taken from `git log origin/main` and `deploy-log.jsonl`, not from memory. Several of these came from other sessions; the ones from this session are marked.

**Edge builds recorded in the ledger** (six deploy cycles; live runtime not re-probed since `cabfeb9`):

| Build | Recorded (UTC) | What it shipped |
|---|---|---|
| `dd20ed4` | 10-14 08:25 | #758 dropped browser connection no longer ends the run; #756 LeakCheck query-pool cap |
| `aaad5d9` | 10-15 12:17 | #774 tests moved out of the deployed folder (4.5 MB limit), plus the batch stamped as `69ec83b` (#771) and never recorded on its own: #765 object tool inputs, #769 Anthropic start-failure fallback, #766 near-miss input coercion, #768 cross-case review verdicts |
| `3cafa81` | 10-15 13:12 | #778 wait for a busy provider (E3), #780 E3 queue stops on finalize/abort |
| `6d36614` | 10-15 13:45 | #781 `breach_exposure` needs a breach-class tool that ran and a non-zero result |
| `d3d3a73` | 10-15 14:05 | #786 an archived page read by a page-fetch tool is archive evidence |
| `cabfeb9` | 10-15 14:30 | #790 infer a missing `google_dorks` kind; `serus_darkweb_scan` accepts `identifier` |

**Frontend shipped on merge (Vercel):**
- Other sessions: #757 summary counts CONFIRMED/ATTESTED apart, #759 mid-stream 401 no longer signs the analyst out, #767 one tool-outcome taxonomy, #773 CO_RECORD clusters, #777 Needs-a-decision drops breach co-tenants, #783 "verified" means analyst clicks, #787 per-case table layout.
- This session: #794 breach table authority (F6), #795 sidebar never writes `finished` (F10), #796 Retry/Re-run guard (F13), #798 dead runs show as Interrupted.

**Docs:** #770 GLM primary / Anthropic backup (other session). This session: #793 (this branch, draft) holds the full review (F1–F33), the evening re-measure (F34–F41, §8b tool plan), the outside-review corrections and integrity re-trace (§10), `tasks/todo.md` and `tasks/lessons.md` sections, this handoff, `NEXT_SESSION_PROMPT.md`, and the CLAUDE.md state block (old block archived to `docs/archive/CLAUDE_STATE_HISTORY_2026-10.md`).

**Built this session, not merged:** #797 (ready), #799 and #800 (drafts). **Reviewed:** #593 made mergeable (merge commit `4afe07a`); #741, #738 and #593 traced against `main` (audit §10.3).

**Measured in production this session (SELECT only):** Z.AI balance ran out mid-run at 10-18 06:31Z; no runs on 10-16 or 10-17; Anthropic last ran 10-14; Jina 257 ok / 11 raw 403 in 30 days; `wayback_cdx_search` 1 ok / 21 failed; 25 findings in the product, 0 confirmed, 1 citing a tool that never ran in its thread; model-written `reviewed` / `linkage_confirmed` keys: 0 and 0 across 11,082 artifacts.

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
- Safety-net check-ins: the one-shot `trig_01XE8dyPwkkdPHFicZrQBs2r` fired at 2026-10-19T02:14Z and has ended. The policy is unchanged: re-check #797/#593/#799/#800, re-arm quietly about every 4 h, and stop after 3 quiet check-ins since JD's last message. Any new session starts without a pending check-in.

## Addendum (2026-10-20T03:40Z, written when this note was reconciled with `main` at `cf501fb`)

Everything above is a 2026-10-19T00:53Z measurement. These points changed before it merged:

- **Merged since:** #805 (Obsidian foundation), #806 (Stage A shell), #807 (session hygiene), #809 (run stays visible after the live stream drops), #808 (the UI handoff `SESSION_HANDOFF_2026-10-19_obsidian-foundation-and-stage-a-shell.md`, which carries JD's newer, design-side queue: trust labels first, then Stage C1). `main` is `cf501fb`; Vercel production was READY on `fb42e23` (verified 2026-10-20T01:20Z).
- **Edge is one build behind canonical.** #802 merged (`aae1152`), #803 stamped it, mirror PR #121 synced it (mirror `96034b0`, all four function trees equal). Live `/health` still reports `cabfeb9` (probed 2026-10-20T01:20Z and again by the gate at 03:35Z). `npm run verify:deploy` passes the hard gate (`mirror tree -> equal`, `mirror pushed`); the `marker_offset_mismatch` it prints is the expected pre-deploy reading. The Lovable deploy message was never sent and there is no ledger row for `aae1152`. Deploy it on its own before #797, so each build maps to one change.
- **#797** stays the next edge PR after that deploy; it remains ready, green and clean.
- **#764 is superseded** by #765 (merged, `tool_input_object_repair` live). Candidate for closure on JD's go, with #701.
- **#804** (another session's Investigate draft) has a red Frontend job on its head: its browser-side `formatThreadTitle` no longer mirrors the server's, which `seed-provider-export.test.ts` pins. It also conflicts with the Obsidian foundation in `src/index.css`. JD's plan salvages its timeline work into Stage C1 without its CSS.
- **#809's two Codex findings were re-traced independently (2026-10-20).** The literal rebuttals hold, but each finding has a real sibling path: (1) a second tab or device that already had the case open marks the previous run's final reply as live when a new run starts, because `messages` is not in the realtime publication; (2) a half-open stream that never ends keeps `isLoading` true, which pins the snapshot to running even after the poll reads a finished row, so the report needs a manual refresh if the realtime socket is also dead. Both are frontend, small, unbuilt, and need JD's go. Fix shapes: gate `live` on the message's `created_at` being at or after the run's start; let the poll/visibility path stop and reconcile when the row is terminal past a grace window.
- **The incident thread's stored shape** (read-only, structure only): one assistant message of 43 parts, 26 tool calls, every text part `done`. No stored row carries a streaming text part, so no "Interrupted response" label renders after a reload.
- **`/health` `checks.credentials` reads `ok:false`** (2026-10-20): `deepfind_disposable_email` 3x, `reddit_user` 2x, `nominatim_geocode` 1x refusing over 7 days. Small counts; lead only.
- **Open scheduled tasks at this writing:** `trig_01WctDRq4AoA9cGfZH43VVu2` (one-shot, 03:42Z, verifies `main` CI and Vercel after #808). It belongs to the session that wrote this addendum and ends itself.
