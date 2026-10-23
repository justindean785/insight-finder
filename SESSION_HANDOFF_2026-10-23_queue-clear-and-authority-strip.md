# Session handoff — merge queue cleared, analyst-authority strip live (2026-10-23)

> Every number here is a dated measurement (2026-10-23, ~03:55 PDT). Re-measure before relying on it.
> Measured by me unless marked **Unverified**. Nothing below changes a protected decision.

## 1. State at hand-off

| Thing | Value |
|---|---|
| canonical `main` | `352eaf469a3c1d8090bfdf4d3a2abf8d436a6818` (ledger PR #829) |
| live edge build (`/health`) | `cdb13c1` (committed 2026-10-23T03:34:37-07:00); `selected_model` glm-5.2; `checks.analyst_authority_boundary` ok; `checks.dispatch_selector_aliases` ok |
| marker commit / stamp commit | `cdb13c1e` / `47d5a9ba` (#828, parent == marker) |
| `deploy/live` ref | `cdb13c1ece0813fc564c6c8f74a4c0e2a209a3a8` |
| last ledger line | marker `cdb13c1`, stamp `47d5a9b`, mirror tree equal, `deployed_bytes_verified: false` (always false on this path) |
| mirror `seeker-spark-search-5362c57c` `main` | `447fa6a` (#123); canonical osint-agent tree `92799deed870` == mirror tree |
| open PRs | 13, all drafts (list in §5) |
| Vercel production | frontend merged through #826 (`750b029f`); deployment SHA **Unverified** (no Vercel check made) |
| flags | run lease still `RUN_LEASE_DISABLED=true` (`/health` `LEGACY`); `reveal_breach_data` true; GLM-5.2 primary, Anthropic backup |

## 2. What shipped this session (all squash-merged, branches kept)

| PR | Merge SHA | What |
|---|---|---|
| #814 | `dcdad195` | CLAUDE.md trimmed (72.9k → 38.1k chars); edge-deploy skill; emails scrubbed |
| #810 | `e4d1fc4c` | ledger: `aae1152` |
| #822 | `87885824` | frontend: consolidated #811 #816 #817 #818 #819 #820 (the six originals are closed "superseded by #822") |
| #797 | `9946ea93` | edge: dispatch checks see Serus / Indicia / CordCat selectors |
| #823 | (stamp) | build marker `9946ea9`; deployed |
| #824 | | ledger: `9946ea9` |
| #825 | `66f0202c` | e2e: wait for the cases drawer to be ready before Escape (test race, not an app bug) |
| #826 | `750b029f` | Sources tab reliability counted on `outcome` over real attempts (see §4) |
| #827 | `cdb13c1e` | edge: strip analyst-authority keys from model-supplied metadata |
| #828 | `47d5a9ba` | build marker `cdb13c1`; deployed |
| #829 | `352eaf46` | ledger: `cdb13c1` |

Closed unmerged: #764 (superseded by #765), #741 (superseded by #827), #811 #816–#820 (superseded by #822).

## 3. #827 independent review (read-only subagent, SHAs `750b029f..cdb13c1e`)

Verdict: **no Critical; patch forward, do not roll back.** It ran both test files from a clean worktree: 31 passed, 0 failed.

Confirmed good: the strip runs before `collapseRecordArtifactsBatch` and before `applyMemoryContext`; the module never throws (null, arrays, frozen objects, case/whitespace/tab/newline key variants all probed); the disclosure key is itself reserved so a model cannot forge its audit record; lowering paths (`conflict`, `collision`, `subject_unlinked`, `possible_minor`, …) are untouched; no other write path found that lets model input reach the three keys on `artifacts`. Interaction with the `metadata.source` P0: none (the strip is top-level only; that P0 stays open).

| # | Sev | Finding | My measurement |
|---|---|---|---|
| 1 | Important | Legacy rows with model-written `reviewed` / `linkage_confirmed` / `false_positive` are still trusted by readers (`intel.ts:628`, `evidence-status.ts:221`, `quarantine.ts`, `reviews.ts:143`, `dispatch-quarantine.ts`). | **SELECT on all 17,505 artifacts:** `reviewed` 0 rows, `linkage_confirmed` 0 rows, `false_positive` 3 rows (2 `true`), 0 rows with `linkage_confirmed=true` AND `subject_unlinked`, 0 `user_provided`/`analyst_provided`, 0 rows carrying `analyst_authority_stripped`. So the hole was not exploited via these keys. The 3 `false_positive` rows were not traced to a writer (**Unverified** whether model- or analyst-written). |
| 2 | Important | `checks.analyst_authority_boundary` only exercises the pure function; if the call sites were dropped the key would stay ok. Only the source-level test guards the wiring (CI, not production). | Matches the repo's self-test pattern; relabel the detail text to "module present" or add a wiring probe. |
| 3 | Minor | `metadata.user_provided` / `analyst_provided === true` (`src/lib/name-conflict.ts:78`) is a sibling analyst-authority key that is not reserved; a model can anchor `detectNameConflict`. Banner impact, not confidence. | one-line add to the reserved list + a deploy |
| 4 | Minor | `record_evidence` (~`tool-registry.ts:6377-6395`) writes model `metadata` to `evidence_log._metadata` unstripped. Nothing reads the three keys there today. | defense in depth |
| 5–6 | Minor | The notice is missing on three early-return paths (~5930, ~6189, ~6282); a collapsed batch keeps the per-row disclosure only on the surviving row (the tool result still has the union). | cosmetic |

Also noted: `analyst_authority_stripped` count is 0 because no run has called the tool with those keys since the deploy (or none has tried) — it is not evidence either way.

Follow-up PR if wanted (edge, own `/health` key, own build): reserve `user_provided` / `analyst_provided`, strip in `record_evidence`, fix the proof-key wording.

## 4. Other audit findings (read-only unless stated)

- **Sources tab "100%" (fixed in #826).** It read `tool_usage_log.ok`, stored as `outcome !== "failed"` (`cache.ts:1050`), so skips/empties counted as successes, and it read an unordered, unwindowed `.limit(5000)` of a 21,253-row table. Real figures (main user, all history): `deepfind_disposable_email` 71% (0 ok / 3–5 failed in the last 7–14 days), `leakcheck_lookup` 94%, `triage_seed` 99%, `username_sweep` 100% on 434 runs (36 skipped/empty). Now: outcome over real attempts, live calls, 30 days, newest first, stated in the UI. `tool_health` view unchanged. No before/after screenshots (harness has no tool-log rows).
- **"Analyst-confirmed" includes `key`.** `src/lib/evidence-status.ts:221`: `analystConfirmed = review === "confirmed" || review === "key" || meta.reviewed === true`. On the Brendan Loza case the "Verified · Multi-source · breach · Analyst-confirmed" row (id `06f2665b`, confidence 65) has review state `key` (2026-10-21 13:10), not `confirmed`; its source field names serus StockX breach + breach_check Twitter breach + socialfetch Instagram (the first two are the same breach class — independent classes not recomputed). Same case: "Brandon Loza" has a `confirmed` row at confidence 15 (usnews) and a `key` row at 35 beside "Brendan Loza" `key`. These are analyst decisions and may be right. **Open question for JD:** should a "key finding" mark read as confirmation? Not changed.
- **Anthropic backup.** 81 orchestrator runs in the last 8 days, all GLM-5.2 (deepseek slot); zero Anthropic runs, so the fallback has not been exercised. One run on 2026-10-18 died with Z.AI "Insufficient balance"; later runs fine. Credit balance/expiry (reported to expire 2026-10-23) is **Unverified** — check the Anthropic console; no non-secret diagnostic exposes it.
- **Graph tab `useState` crash:** a Vite dev-server artifact (two optimizer hashes `?v=1a02190c` / `51a504a2` in one stack → two React copies after a mid-session re-optimize). Production builds use fixed Rollup chunks (build not run — **Unverified**). Fix locally: `rm -rf node_modules/.vite`, restart, hard-reload; optionally `optimizeDeps.include: ["reactflow"]`.
- **Visual verification** was done on the synthetic harness only (390/768/1440, 25 screenshots; outputs were in a scratch dir and are gone with the session). Production cannot be signed into from here, so **production interaction testing is still outstanding.** Findings: no horizontal page overflow in any view; phone Investigate clips a table at the card edge with no scroll cue; case title truncated on phone (breaks DESIGN.md's never-truncate rule); Evidence has 85 controls under 24 px at every width (WCAG 2.5.8); phone `/brain` has two tab buttons past the right edge.

## 5. Queue

13 open drafts: #821 (tier-word ladder, integrity sign-off), #804 (Cold Room; reuse `run-timeline.ts` in Stage C1, no global CSS), #801 (media_leads/geo), #800 (wayback parallel), #799 (Jina 403), #793 (old docs), #772 (case-console redesign; carry items into Stage C1), #763 (`apify_skip_trace`), **#738 (memory authority)**, #701 (LeakCheck probe), #613 (lineage schema, unapplied), #593 (artifact dedupe authority), #516 (account deletion, dark).

### #738 rebase prerequisites (from a read-only review; nothing run)
- Conflicts: `health-handler.ts` (imports, trivial); `index.ts` (main added the E4 cross-case log block beside `baseSystemPrompt`; the PR swaps in `assembleBaseSystemPrompt` — **keep the E4 block**); `supabase/tests/osint-agent/memory_context_test.ts` (imports). `lib/memory-context.ts` auto-merges.
- Its new test files sit at `supabase/functions/osint-agent/*_test.ts`; they must move to `supabase/tests/osint-agent/` with imports and `new URL(...)` paths rewritten to `../../functions/osint-agent/…` (the 4.5 MB deploy cap; `edge-deploy-bundle.test.ts` fails otherwise).
- Integrity: changes what the model may believe about recalled memory (system-prompt wording, history labels, `[MEMORY]` tagging, `minimax_plan_pivots` cache-key version); **widens `MEMORY_TOKEN_RE`** (`lib/memory-context.ts:18`) to bracketed forms — needs JD sign-off. Three kill switches (`MEMORY_AUTHORITY_WORDING_DISABLED`, `HISTORY_LABEL_DISABLED`, `HISTORICAL_MEMORY_MARK_DISABLED`) and three proof keys in one build → a regression cannot be bisected; consider splitting.
- Same approach that worked for #827: new branch off main, merge the PR head in (never rebase a pushed branch), fix the stale fixtures.

### Still unrun (need JD's go)
- SELECT-only pg_cron state and the `20260907000000` synthesis index presence (`artifacts_synthesis_cluster_uniq`); engine-adjudicated findings count (Phase 1 prerequisites of the agentic plan, `docs/plans/2026-10-20-agentic-upgrade-plan.md`).

## 6. Protected decisions (unchanged)

GLM-5.2 primary, Anthropic backup (do not re-pin `ORCHESTRATOR_PROVIDER`); `REVEAL_BREACH_DATA` stays ON; run lease stays off until S1b; finding synthesis stays OFF; `MAX_PAID_CALLS` bounded; no secret changes; no migrations applied without JD; evidence-integrity changes (caps, quarantine, analyst authority, corroboration, tier thresholds) need JD's sign-off; one edge PR per build; merges, deploys and Lovable messages only on JD's explicit go; never close a PR without JD's say.

## 7. Traps found this session

- **Stale GitHub snapshots.** Pasted status summaries repeatedly lagged the repo (listed #828 as pending after it merged). Re-read `gh pr view`/`git ls-remote` before acting.
- **`deno.lock` is rewritten** by `npm run test:edge` and by `deno check` unless `--no-lock`. Check `git status` before `git add -A`; I staged tests before `deno check` and it left an unstaged lock change (reverted).
- **Stamp with 7-char abbreviation:** `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=7 node scripts/stamp-build.mjs` (git abbreviates to 8 now); an 8-char marker breaks the gate's pickaxe.
- **`verify:deploy` before the stamp merges** reports `marker_offset_mismatch` (x2) and "not reachable from main" — expected; a stale local `deploy/live` ref also reports `ledger_ref_divergence` — `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` first.
- **`edge fixtures vs main's breach guard`:** `breach_exposure` rows are rejected unless a breach-class tool actually ran in the thread AND the row's `source` names it. Old test fixtures with `source: "dark-web scan"` fail on main.
- **Radix drawer Escape race:** Escape pressed right after a click is lost; wait for focus inside the dialog, not just `toBeVisible` (#825). CI e2e is push-only with `retries: 1`, so such flakes show as passes there.
- **A test mock returning a new object per render** (`useAuth: () => ({ user: {...} })`) re-runs `[user]` effects forever and leaves a component stuck on "Computing…"; hoist a stable object.
- **Playwright locally:** the cached Chromium is `chromium-1243`; set `PLAYWRIGHT_CHROMIUM_PATH` to its `…/Google Chrome for Testing` binary. A foreground e2e run is killed if the turn is interrupted — run long suites in the background.
- **`gh pr merge` refuses drafts** — mark ready first (and that wakes review bots; re-check the head SHA).
- **Subagent and bot reports are not proof.** The Lovable deploy reply and bot reviews ("no blocking issues", graph out of date, tests not run) never established a deploy; only the moved `/health` build and key did.

## 8. Opening prompt for the next session

> Read `CLAUDE.md`, `tasks/lessons.md` and `SESSION_HANDOFF_2026-10-23_queue-clear-and-authority-strip.md`. Re-measure first: `git ls-remote origin refs/heads/main refs/heads/deploy/live`, `gh pr list --state open`, and one `/health` read (build should be `cdb13c1` or newer). Then ask me which of these to do, one at a time, report-only until I say go: (a) rebase #738 onto current main as a new draft PR per §5 (merge the PR head in, keep main's E4 block, move tests to `supabase/tests/`, run the full edge suite, stop for my integrity sign-off); (b) the small #827 follow-up (reserve `user_provided`/`analyst_provided`, strip in `record_evidence`, fix the proof-key wording); (c) the SELECT-only pg_cron / synthesis-index measurement; (d) decide whether a `key` review should read as "Analyst-confirmed". Do not merge, deploy, change flags or secrets, or close any PR without my explicit go.
