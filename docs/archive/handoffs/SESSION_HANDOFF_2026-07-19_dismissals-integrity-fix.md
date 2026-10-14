# Session Handoff — 2026-07-19

**Branch:** `claude/agent-reads-dismissals` → **PR #352** (draft, open, CI green, `mergeable_state: clean`)
**Deploy status:** frontend not yet shipped (ships automatically on merge → Vercel); backend `osint-agent` **NOT deployed** — Lovable step comes after you merge.

---

## What shipped this session (PR #352, 2 commits)

The trigger: analyst **Confirm/False/Recheck** marks were being completely ignored by the backend — a dismissed/wrong finding could still come back as the "most likely subject." Confirmed as a real, live-data incident (Joseph Henrichsen/Kota Burden case), not theoretical.

### Commit `799b829` — Part 1: the agent never reads `artifact_reviews`
Root cause: `public.artifact_reviews` (where the frontend writes analyst verdicts) had **zero readers** anywhere in `supabase/functions/`.

- **New `supabase/functions/osint-agent/reviews.ts`** — shared helper:
  - `loadReviewsForThread(db, threadId, userId)` → `Map<artifact_id, state>`. Fails **open** (a load error → empty map → prior unfiltered behavior; a transient DB hiccup must never break a live run).
  - `applyReviewsToArtifacts(rows, map)` — drops `dismissed`/`wrong`, downweights `recheck` by 20, tags kept rows.
  - `rejectedArtifacts(rows, map)` — the rejected rows, for an explicit "DO NOT USE" block.
- Wired into **all four** model-facing artifact re-reads:
  | Path | File |
  |---|---|
  | Salvage synthesis (CPU-kill finalize) | `index.ts` |
  | 7-day `investigation_cache` write | `index.ts` |
  | Deterministic cluster engine | `lib/cluster.ts` (`applyClusteringToThread`) |
  | Stale-run recovery report | `recovery.ts` (`recoverOneStaleThread`) |
- `orchestrator-finalize.ts` — `buildSalvageSynthesisPrompt` gained a `rejected` param → renders an "ANALYST-REJECTED — DO NOT USE" block.
- Tests: `reviews_test.ts` (new).

### Commit `9122327` — Part 2: the cache-replay bypass (found reviewing Part 1)
A second, independent hole: `ChatWindow.tsx`'s 7-day cache **replay** clones cached artifacts and re-displays the cached assistant narrative **without ever calling `osint-agent`** — so none of Part 1's filtering ever ran on this path. A row is cached *before* any review exists; a later dismissal never touched it.

- `index.ts` (cache write): every row now stamped `cache_version: 2` + `origin_thread_id`; previously-swallowed artifacts-read and upsert errors are now captured and logged.
- `src/lib/review.ts`:
  - `checkCachedHitSafety(originThreadId, userId)` — re-checks `artifact_reviews` for the cache row's origin thread **at replay time**. **Fails CLOSED** (opposite of Part 1's helper) — a query error or a pre-fix/unversioned row is treated as unsafe, forcing a live run instead of risking a silent replay.
  - `invalidateInvestigationCache()` — best-effort cache eviction on a `dismissed`/`wrong`/`recheck` write (not load-bearing; the read-time check is).
  - Fixed constant drift: `reviews.ts`'s recheck penalty was `-40`; canonical (`REVIEW_CONFIDENCE_DELTA.recheck`) is `-20`. Corrected.
- `ChatWindow.tsx`: cache-hit path now calls `checkCachedHitSafety()` before ever rendering; a rejected verdict evicts + falls through to live; a recheck-only verdict replays downweighted. Clones now carry `origin_thread_id`/`origin_artifact_id` in metadata instead of severing lineage.
- Tests: `src/test/review.test.ts` (+6): safe / dismissed / wrong / recheck-only / fail-closed-on-error.

### Verification (this session, local + CI)
- `npx tsc --noEmit -p tsconfig.app.json` — clean.
- `npx vitest run` — **1051/1051 passed**.
- `npm run build` — clean.
- `npm run lint` — 0 errors (12 pre-existing warnings only).
- GitHub CI on PR #352 (latest commit `9122327`): **Frontend, Edge (deno test), Migrations — all green.** `mergeable_state: clean`.
- Deno not runnable locally in this environment (egress-blocked to `dl.deno.land`) — CI's Edge job is the real gate for `reviews_test.ts` / cluster / recovery changes, and it passed.

---

## Immediate next steps for #352 (nothing below has been done yet)

1. **You review + merge** PR #352 into `main` (still draft on purpose — no auto-merge was set up).
2. `node scripts/stamp-build.mjs` on `main` and commit `build-info.ts` — the `/health` build SHA will not move without this.
3. Surgical mirror sync (`cp -R` **only the changed files**, not blanket overwrite) into `seeker-spark-search-5362c57c`:
   `supabase/functions/osint-agent/{index.ts,reviews.ts,reviews_test.ts,orchestrator-finalize.ts,lib/cluster.ts,recovery.ts}`
4. Explicit Lovable deploy — message project `4ce11bc3-039d-4439-b293-acacca9e1e3a` to pull `main`, confirm the `BUILD_MARKER`, and run `supabase--deploy_edge_functions` with `function_names: ["osint-agent"]` (as-is, no frontend publish).
5. Verify: `curl https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1` — confirm the `build` SHA moved. That's the only proof.
6. Frontend half (`ChatWindow.tsx`, `src/lib/review.ts`) ships automatically on the `main` merge via Vercel — no separate step.

---

## All other open PRs (live query, 2026-07-19 — 11 more beyond #352)

| PR | Title | Branch | Draft | Status/blocker (from PR body) |
|---|---|---|---|---|
| #347 | Reconcile analyst-feedback `digest()`/search_path defect + CI parity | `fix/analyst-feedback-migration-reconcile-ci-parity` | yes | Both migrations already applied to prod; this just reconciles repo+CI. No prod action needed to merge. |
| #343 | OathNet victim-reveal parity (`trimVictimItems` honors `REVEAL_BREACH_DATA`) | `fix/oathnet-victim-reveal` | yes | Split off #341 for focused review. Backend — needs gated Lovable deploy to take effect. |
| #341 | OathNet: IP seeds now query the breach corpus (was geo/ASN only) | `claude/oathnet-ip-breach-reveal` | yes | Live bug (an IP reported "clean" with real breach hits on manual check). Backend — needs gated deploy. |
| #331 | Orchestrator budget limits → env-configurable (wall-clock/tool-cap/finalize-reserve) | `feat/orchestrator-budget-env` | yes | Defaults unchanged; explicitly "do not merge/deploy yet" pending your review + setting the Supabase secret. **Relevant to the BYOK/cap discussion below.** |
| #330 | Cap chat column at readable prose width | `claude/chat-column-readable-width-gsi1ga` | yes | Frontend/CSS only, trivial — safe to merge whenever. |
| #326 | Structured pivot-loop foundation (types/schemas/migrations) | `feat/structured-pivot-loop-clean` | yes | Foundation-only rebuild of #325. New migrations included — review before merging. |
| #324 | Circuit breaker: stop one timeout suppressing a whole provider | `claude/beta-release-deployment-d4eo2m` | yes | Backend; needs gated deploy. Full edge suite not run in-sandbox (jsr.io egress-blocked) — CI is the gate. |
| #321 | WIP transactional auto-persistence foundation | (stacked on #307) | yes | Explicitly `BLOCKED_ON_DATABASE_EXECUTION` / not merge-ready; depends on #307 merging first. |
| #307 | Selector-scope-aware artifact dedup + canonical provenance merge | `fix/artifacts-selector-scope-dedup` | yes | Data-loss fix for #305's destructive migration. **Must merge before #321/#326 sequencing matters** — check for conflicts if #305 ever reappears. |
| #320 | Stop the agent quitting mid-investigation on narration-only steps | `fix/stop-mid-investigation` | yes | Needs live verification post-deploy (can't exercise the live DeepSeek/MiniMax loop from sandbox). Recommends pairing with an orchestrator flip to MiniMax. |
| #198 | Self-service account deletion (audit F14/F15) | `fix/account-deletion` | **no** (ready for review) | Irreversible destructive RPC — flagged for careful review of the live schema before merging. Oldest open PR (since 07-02). |

None of the above were touched this session — listed as-is from GitHub so you have the full current backlog in one place.

---

## Other known open threads (carried over from earlier this session's context — NOT re-verified today)

- **P0 stuck-active investigations** — root-caused to a non-atomic finalize sequence in `index.ts` (~1083→1195); **fix not started**. You explicitly deferred this ("finish dismissals fix first").
- **socialfetch (LinkedIn/YouTube/etc.)** — `SOCIALFETCH_API_KEY` confirmed present after a deploy; you reported "still" not working after that. Needs a fresh live test — status unknown as of now.
- **Budget cap / BYOK** — the $25 budget-bar UI shipped (#349, merged). The bigger ask (bring-your-own-key so deep investigations don't hit engine caps) has **not** been started; #331 above (env-configurable orchestrator budgets) is adjacent/relevant but is a different mechanism (raises internal per-run limits, not BYOK).
- **Situation Board 2.0 / Evidence Workspace 2.0** — confirmed (again, via fresh grep) it was **never built** — it's a `claude.ai` design-preview artifact only, zero references in `src/`. Awaiting your call: build it for real, or leave it parked.

---

## Verify commands
- `npx tsc --noEmit -p tsconfig.app.json`
- `npx vitest run` (1051 tests)
- `npm run build`
- `npm run lint`
- Edge/Deno: no local runtime here (egress-blocked) — rely on CI's `Edge functions (deno test)` check.
