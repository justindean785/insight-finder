# Audit report — Insight Finder, the `@glitterkittens12` failure and the post-#557 state

> **Measured 2026-09-08T07:55Z–08:06Z against `origin/main` `0efd6e5` (live `osint-agent` build `e50db9e`). Re-verify before acting.**
> Scope: the state of the repo, the deploy and the production corpus after the `e50db9e` deploy and the #557 handoff merge, measured against the `@glitterkittens12` investigation the operator reported as "completely failing" (thread `b74049ad-999e-4a49-9b17-8d236c98f76f`, its artifact dump and exported report, nine workspace screenshots), the Lovable project agent's independent weak-spot audit of the same thread, and PR #558 (Phases 1–2 of the fix, green, draft, **not deployed**).

## 1 · Executive summary

Every gate is green on an isolated checkout of `0efd6e5` with its own `npm ci`, and every number matches what `CLAUDE.md` and `NEXT_SESSION_PROMPT.md` claim to the unit: frontend 1957 / 1 skipped / 159 files, edge 1634 / 0 / 5 ignored, lint 0 errors, typecheck and build clean. The live backend, the `deploy/live` ref and the `/health` marker all read `e50db9e`; the only edge file between that build and `main`'s tip is the `build-info.ts` stamp, so the two-commit gap is the documented one-commit offset plus a docs commit, not a lag. Vercel production is `0efd6e5`. All four mirrored function directories diff empty against clean `main`. On the deploy axis this repo is in the healthiest state any audit in this series has recorded: nothing merged is undeployed, and nothing deployed lacks a source commit.

The headline finding is that the `@glitterkittens12` run did not fail because the username scanner was missing — `username_sweep` ran, resolved its site list and proved most of it absent. It failed because **rejected evidence never lost its authority**. Five separate mechanisms produced the operator's one symptom ("I marked it false and it still says it's most likely that data"): the cycle planner built its relationship graph from an unfiltered `artifacts` read while the persisted-cluster path beside it filtered rejections; rejection bound to the clicked row but not to the rows derived from it, so the two plaintext breach passwords extracted from a rejected email stayed in the report's active network section (both are still unreviewed in production — measured, not inferred); the rejected-dispatch guard memoised its key set once per run, so a mid-run Wrong could not bind before the next paid call; and the agent's own pre-review identity memory (confidence 60, with `dgoff1276@gmail.com` and `diamond nicole` in its `related_values`) sat beside three 95-confidence analyst FALSE lessons about those very selectors, all retrievable by the planner in one prompt. All five are fixed in #558 with failure-first tests and a clean CI run on its head — and every one of them is **unmerged and undeployed**, so the production behaviour the operator saw is the production behaviour today.

The top unresolved question is an instrument that reports something other than what it names, the recurring shape in this repo's trap list. `/health` says `rejected_cluster_sweep: clean … 0 stale assignment(s)`, and on its own axis that is true: no analyst-rejected artifact has a non-null `cluster_id` **column**. But 351 artifacts corpus-wide carry a `metadata.cluster_id` with no column value, every one an LLM-shaped label (`carlos_morales_primary`) rather than the pipeline's `clus_…` form, two of them analyst-rejected — and the sweep's stale detector is column-scoped while the function that would clear the metadata copy runs only when the detector finds something. `contradictions.ts` groups by that metadata field. Alongside it: all three inherited open PRs (#502, #516, #541) now report `mergeable_state: dirty`, where the handoff recorded only #502 as conflicting; and `tool_call_cache` is 99.6 % expired rows with `cache_sweep` disabled, the 09-03 handoff's open question, still open.

## 2 · Method & what could NOT be verified

| Source | Reached | Reliability | Notes |
|---|---|---|---|
| Test gates, run by me | Yes | High, primary | Isolated `git worktree` of `origin/main` `0efd6e5` with its own `npm ci` (11 s); Deno 2.9.6 with `--no-lock`. Durations in §3. |
| Live health endpoint | Yes | High, primary | `osint-agent?health=1` at 07:55:19Z; earlier probe at ~07:17Z agreed. |
| Production database | Yes | High, primary | `mcp__Lovable__query_database`: full-corpus counts, the `b74049ad` thread, `agent_memory`, `memory_merge_candidates`, `pg_indexes`, `tool_call_cache`. Read-only. |
| CI run records | Yes | High | GitHub check runs on #558 head `e421277`: Edge 1 m 26 s, Frontend 3 m 56 s, Migrations 34 s — real durations. `main` itself has no run of its own to read (squash-merge; the PR runs are the record). |
| PR state | Yes | High | GitHub API: head SHA, draft flag and `mergeable_state` for all four open PRs. |
| Vercel deployments | Yes | High | `list_deployments`: latest `target: production` is `0efd6e5`; #558's three commits produced `target: null` previews only. |
| Deploy ledger + refs | Yes | High | `deploy/live` fetched explicitly (the un-fetched-ref trap); `deploy-log.jsonl` last row `previous_build 4e6888a`, `deployed_bytes_verified: false` as always. |
| Mirror repo | Yes | High | `seeker-spark-search-5362c57c` fetched to `e73b50c`; per-function `diff -rq`; `git log` for Lovable-authored commits. |
| Lovable edge-function logs | **No** | — | Not read this audit. Retention is sub-30-minutes (09-03 handoff §4) and the run under audit ended 07:05Z; nothing would have survived. Every runtime claim below rests on the artifact and review tables instead. |
| A live re-run of `@glitterkittens12` on #558 | **No** | — | #558 is not deployed. Its behaviour is proven by tests that drive the shipped control flow, not by a production measurement. |
| Prior handoffs / Lovable audit | Yes | Medium, secondary | Read as leads. Where they disagree with a primary source the primary source wins and the disagreement is a finding (§7). |

## 3 · Measured gates

Clean worktree of `origin/main` `0efd6e5`, own dependency install, 07:56:20Z → 07:58:58Z.

| Gate | Result | Duration | Docs claimed | Divergence |
|---|---|---|---|---|
| `npm ci` | ok | 11 s | — | — |
| `vitest run` | **1957 passed / 1 skipped / 159 files**, 0 failed | 48.6 s | 1957 / 1 / 159 | none |
| `npm run typecheck` (`tsconfig.app.json` + `node`) | clean | 15 s | clean | none |
| `npm run lint` | 0 errors / 11 warnings | — | 0 / 11 | none |
| `npm run build` | clean | 10.5 s | clean | none |
| `deno test *_test.ts` (osint-agent) | **1634 passed / 0 failed / 5 ignored** | 61 s | 1634 / 0 / 5 | none |

The same gates on PR #558's head `e421277` (17 files over `main`): vitest 1965 / 1 / 161 (+8, two new files), edge 1643 / 0 / 5 (+9), `lib/*_test.ts` 25 / 0, typecheck clean, lint 0 errors, build clean; CI agrees (Frontend 3 m 56 s, Edge 1 m 26 s, Migrations 34 s, all `success`). `deno check` on `tool-registry.ts` and `cache.ts` reports 24 and 9 errors respectively **on both `main` and #558** — identical lists of pre-existing supabase/AI-SDK type-graph noise; the PR adds none.

One process note that is itself a finding: a hand-rolled `tsc --noEmit -p tsconfig.json` passed on #558 while CI's `npm run typecheck` failed, because `tsconfig.app.json` is the config that includes `src/test/`. The repo's own script is the instrument; a substitute that agrees most of the time is exactly the kind that lies when it matters.

## 4 · Deploy & live state

`/health` at 07:55:19Z: `build e50db9e`, `build_committed_at 2026-09-07T23:52:46-07:00`, `version 1.2.2`, `selected_provider deepseek`, `selected_model glm-5.2`, `orchestrator_reason pinned`, `reveal_breach_data true`. Checks: `orchestrator ok`, `core ok`, `tools ok (17/20 optional APIs configured)`, `deepseek ok (active)`, `minimax ok (fallback)`, `recovery ok (0 stale runs)`, `rejected_cluster_sweep ok (clean: 309 rejected review(s), 0 stale assignment(s))`, `synthesis ok (disabled)`, `cache_sweep ok (disabled)`.

| Axis | Value | Reconciliation |
|---|---|---|
| `origin/main` | `0efd6e5` (#557) | — |
| `deploy/live` | `e50db9e` | fetched explicitly |
| Live `/health` build | `e50db9e` | equals `deploy/live` |
| Commits `e50db9e..origin/main` | `4a5eb1c` (#556 stamp), `0efd6e5` (#557 docs) | only edge file touched: `build-info.ts` — the documented one-commit offset. **No deploy lag.** |
| Vercel production | `0efd6e5`, READY | equals `origin/main`. #558's commits are `target: null` previews. |
| Mirror `origin/main` | `e73b50c` | four `gpt-engineer-app[bot]` commits today after our `571cb9e` sync |
| Mirror runtime parity | `osint-agent`, `evidence-export`, `security-test-lab`, `_shared`: **0 differing paths each** | the four Lovable commits touched only `.lovable/plan.md` (+62) and `roadmap.md` (+3) — runtime-inert; mirror `BUILD_MARKER` is `e50db9e` |
| Edge-function inventory (from the mirror) | `osint-agent`, `evidence-export`, `security-test-lab`, `mcp` + `_shared` | matches `CLAUDE.md`'s "4 deployed" |
| Ledger | last row records `4e6888a → e50db9e`, `deployed_bytes_verified: false` | the known ceiling; unchanged |

The Lovable commits deserve one sentence: `.lovable/plan.md` is where the Lovable agent wrote the weak-spot audit the operator pasted into this session ("Built Claude-ready fix prompt"). It is the mirror being written by a second agent — the standing hazard `CLAUDE.md` describes — and this time it was inert. The check that caught it (`git log origin/main` on the mirror after fetching) took four seconds and should stay in the routine.

## 5 · Production measurements

Corpus, 08:00Z–08:05Z, read-only.

| Metric | Value | Note |
|---|---|---|
| Threads | 219 total · 208 finished · 1 active · 2 touched in 24 h | the 1 active thread has `run_started_at` NULL — a blank thread, which invariant I-1 correctly protects from the recovery sweep (`recovery ok, 0 stale`) |
| Artifacts | 11,113 | |
| Artifact reviews | 882 total · **309** rejected (`wrong`/`dismissed`) · 38 written in the last 24 h | 309 equals the `/health` sweep figure |
| Rejected artifacts with a non-null `cluster_id` **column** | **0** | agrees with `/health` "0 stale" |
| Rejected artifacts with `metadata.cluster_id` set | **2** | both thread `61d1eede` (2026-08-28), kind `email`, `metadata.cluster_id = carlos_morales_primary`, column NULL |
| Artifacts with `metadata.cluster_id` but column NULL | **351** | 7,725 with the metadata key vs 7,374 with the column; **all 351 carry a non-`clus_` id** |
| Quarantined (`subject_unlinked`) | 784 across 34 threads · 0 released (`linkage_confirmed`) | `CLAUDE.md`'s "104 across 4 threads" figure is from 08-14 and is stale; the boundary has been busy since |
| `artifact_linkage_releases` | 0 | #529's release path has never been exercised in production |
| `agent_memory` | 1,323 rows · **121** analyst FALSE lessons | the corpus Phase 2's supersession would act on |
| `memory_merge_candidates` | 283 | the C-2 gate's landing zone; two rows from `b74049ad` (§7) |
| `tool_call_cache` | **11,720 of 11,771 expired (99.6 %)** | 09-03 handoff §6.1 measured 11,475 of 11,646. Still open; `cache_sweep` is `disabled` in `/health` |
| `artifacts_synthesis_cluster_uniq` (#547) | **absent** (`pg_indexes` → 0) | handoff §4 claim confirmed: merged, CI-validated, not applied |

Thread `b74049ad` (`@glitterkittens12`), the run under audit:

| Metric | Value | Cross-check |
|---|---|---|
| Artifacts | 34 (12 social_profile, 5 breach_exposure, 4 weak_lead, 3 username, 2 hash, 2 organization, 1 each email / infrastructure / ip_address / name / social_footprint / triage_decision) | workspace shows 32: `triage_decision` is a meta kind excluded by the 08-17 migration; the second is Likely an alias-twin fold in the report layer — not confirmed |
| Analyst decisions | 16 — 8 `wrong`, 3 `dismissed`, 3 `key`, 2 `confirmed` | equals the Lovable audit exactly |
| Rejected rows still carrying a column `cluster_id` | 0 | detachment worked |
| Accepted/key rows without a cluster | 0 | |
| **Unreviewed artifacts with `parent_selector = dgoff1276@gmail.com`** | **2** | the two plaintext passwords the report published under Breach / Exposure — the provenance-cascade defect, measured |
| Tool calls | 45 | equals the workspace |
| Status | `finished` | |

Memory for the thread, in order: an `identity` row at 06:59:35Z (confidence 60) whose `related_values` are `[dgoff1276@gmail.com, sac archives, sacramento ca, diamond nicole, springfield mo, 104.54.98.171]` and whose content reads "CONFLICT: Breach data … ties this username to dgoff1276@gmail.com / Diamond Nicole / IP 104.54.98.171 … possible account transfer/takeover"; three `lesson` rows at 07:00:59Z–07:01:27Z, confidence 95, `Analyst marked "Diamond Nicole" (name) as FALSE / incorrect data`, likewise for `dgoff1276@gmail.com` and `diamondnicole7`; a `connection` row at 07:04:52Z (confidence 80) about SGA that asserts no rejected selector. In `memory_merge_candidates`: an `identity` entry at 06:56:35Z (proposed 65) **blocked** by C-2 ("2 distinct C-1 subjects referenced"), and a `lesson` at 07:04:52Z (proposed 80) blocked for the same reason.

## 6 · PR & issue reconciliation

| PR | Head | Draft | `mergeable_state` | Checks | Risk |
|---|---|---|---|---|---|
| **#558** fix(authority): analyst rejection binds the planner, the live run, memory, and the report | `e421277` | yes | (clean; not returned by API for this PR) | Edge 1 m 26 s ✅ · Frontend 3 m 56 s ✅ · Migrations 34 s ✅ · e2e skipped | Six edge files need the mirror-sync + Lovable deploy after merge; touches `safety.ts` (disclosed in the body). The repo runs no Claude Approvals check. |
| #502 Audit remediation, run-wedge fix, #476 | `0896e00` | **no** | **dirty** | — | 39 files / 21 commits; base `4cc7573` is far behind. Operator decision vs #516 (handoff §5). |
| #516 feat(account): self-service deletion, shipped DARK — split out of #502 | `918fe2f` | yes | **dirty** — **new since the handoff** | — | 8 files, additive. Now also conflicts; the handoff said only #502 did. |
| #541 docs(handoff): 2026-09-03 | `f621a1d` | yes | **dirty** — **new since the handoff** | — | Docs only, superseded twice. Close. |

Cited issues: **#476** (account deletion) — open; two competing PRs (#502, #516), neither mergeable as-is. **#547**'s index — merged, not applied (§5). **#519** — merged and deployed at `e50db9e`; its observability claim corrected in #557 (it emits a `console.warn`, not durable telemetry) — Confirmed by reading `cache.ts` ~:674.

## 7 · Findings & action-list delta

Classification: **fixed & live** / **fixed, not deployed** / **still open** / **regressed** / **newly found**. Confidence per JD's scale.

**F1 — The planner read artifacts raw (Lovable audit P0 #1). Fixed, not deployed. Confirmed.** `tool-registry.ts` (`minimax_plan_pivots`, not the audit's `plan_next_cycle`, which does not exist) built the relationship hint from `.from("artifacts").select("kind,value,confidence,source,metadata")` with no review filter, while `lib/cluster.ts:477` applies `loadReviewsForThread` + `dropRejectedArtifacts` on the same table. Two defects: no filter, and no `id` in the select (the filter matches reviews by id). #558 filters at the boundary, fails closed, and emits `analyst_decisions_applied`. Graph-ranked pivots (`selectPivots`) were **not** a contributor: `GRAPH_PIVOTS_ENABLED` defaults off. The audit's phrasing was wrong; its substance was right.

**F2 — Rejection did not cascade through provenance (Lovable P0 #3). Fixed, not deployed. Confirmed in production.** Two unreviewed descendants of the rejected email exist in `b74049ad` (§5). #558 walks `parent_selector`/`queried_selector` — explicit provenance, never text similarity; the CLAUDE.md hazard (a rejected `name` suppressing an unrelated `username`) is pinned by test.

**F3 — Contradictory memory (Lovable P0 #2). Fixed, not deployed. Confirmed, with a correction.** The audit said a "confidence-74 lesson asserting Diamond Nicole / transferred handle" remained active. It does not exist in `agent_memory`: the C-2 gate blocked the 65-confidence identity entry into `memory_merge_candidates` at 06:56:35Z — the gate worked. What **did** persist is the 06:59:35Z identity row (60) whose `related_values` name two rejected selectors and whose content restates the breach linkage as a live hypothesis. That row and the three 95-confidence FALSE lessons are all retrievable by confidence order. #558 supersedes it at read time (three live recall sites) and refuses conflicting positive writes before the `GREATEST(old,new)` ratchet; rows are retained. Applies to 121 analyst FALSE lessons corpus-wide.

**F4 — Mid-run rejection did not bind (brief §5). Fixed, not deployed. Confirmed by code and test.** `cache.ts` memoised `rejectedKeysPromise` once per run. #558 expires it on a 5 s TTL with an injectable clock; the test proves 1 → 1 → 2 reads across the boundary and a refusal on the post-TTL dispatch. `force` still cannot override.

**F5 — Report published rejected evidence in active sections (Lovable P1). Fixed, not deployed. Confirmed.** #558 adds an *Excluded by Analyst* appendix with the exclusion reason; every row stays in the forensic table. Also stops `inferToolGaps` recommending email tooling off a rejected email.

**F6 — `bare-10` minor-safety false positive. Fixed, not deployed. Confirmed.** `safety.ts`'s bare-age boundary `[^\d]` admitted a letter, so `"Over 10mil on YouTube."` read as age 10 — capping the seed's own verified 29 k-follower Instagram to 35, setting `auto_pivot_blocked` on it, and headlining the export with a minor-safety banner. Tightened in #558 with recall preserved by test. **Conflicts with the operator brief's "do not change minor-safety detection"; flagged in the PR body for an explicit decision rather than landed quietly.**

**F7 — The sweep looked like it never ran. Fixed, not deployed. Confirmed.** `username_sweep` resolved its list and could not decide 40 platforms (Instagram among them — datacenter egress is blocked); only the hit count reached the analyst. #558 puts the undetermined count in the artifact value and keeps the platform names. The Lovable audit's "approximately 95 sites" is the registry's own description; the sweeper source lists 109 URLs.

**F8 — Cluster codes disagreed between workspace and export; Timeline silently `.slice(-15)`. Fixed, not deployed. Confirmed** from the operator's screenshots and export against `intel.ts` / `ClustersTab.tsx`.

**F9 — `/health` "0 stale assignments" is column-scoped; 351 metadata-only cluster remnants exist, 2 on rejected rows. Newly found. Confirmed (counts) / Likely (impact).** `rejected-cluster-sweep.ts:90-98` detects stale rows with `.or("cluster_id.not.is.null,subject_id.not.is.null")` and returns early (10-minute clean memo) when none match; `clearStaleClusterAssignments` (`lib/cluster.ts:437-444`), which also nulls `meta.cluster_id`, therefore never runs for them. The remnants are LLM-authored labels the pipeline's `clus_…` writer never produced. No frontend module reads either field (clustering is client-side from selectors); `contradictions.ts:591/627` groups by `metadata.cluster_id`, so the two rejected Carlos-Morales emails are still one "candidate" there. Low blast radius, but the health string over-claims by one word.

**F10 — #516 and #541 now conflict with `main`. Newly found (delta vs the 09-08 handoff). Confirmed.** The handoff recorded only #502 as `dirty`. All three inherited PRs are.

**F11 — `tool_call_cache` 99.6 % expired, `cache_sweep` disabled. Still open. Confirmed.** 11,720 / 11,771 today vs 11,475 / 11,646 on 09-03. The sweep shipped in #513 and is off by flag.

**F12 — `#547` index not applied. Still open. Confirmed** (`pg_indexes` → 0). Safe to defer while both synthesis flags are off, as the handoff says.

**F13 — Durable dispatch-boundary telemetry. Still open. Confirmed.** #519 emits `console.warn`; nothing persists that a run went out with the boundary degraded. #558 adds `analyst_decisions_applied` at three surfaces, also `console.log` — an improvement in coverage, not in durability.

**F14 — The Pivots tab's "17 contradictions" badge counts artifacts below confidence 50. Newly found. Confirmed** (`PivotsTab.tsx:86`; every artifact's `contradictions` array in the dump is `[]`; Overview reads `CONFLICT 0`). Not fixed in #558.

**F15 — Mirror written by the Lovable agent again. Newly found. Confirmed, runtime-inert.** Four commits today; `.lovable/plan.md` and `roadmap.md` only.

**F16 — `deno.lock` rewritten by the Deno installer, not by `deno test`. Likely.** In this session the lockfile showed modified after the install with every test run using `--no-lock`, consistent with the 09-08 handoff's trap #3 and inconsistent with the older `CLAUDE.md` wording. Not isolated step-by-step.

Settled decisions checked and left alone: `REVEAL_BREACH_DATA` is `true` on `/health` as intended; `MAX_PAID_CALLS` untouched; no intent-from-prose logic introduced; the termination area (`toolChoice`, finalize window) untouched.

## 8 · Recommended next actions, in priority order

1. **Rule on `safety.ts` in #558** (F6). Keep in the PR, split out, or revert — the operator's call; the tests are in either case. Cost: a sentence.
2. **Merge #558 and run the full backend recipe** (F1–F8): stamp, surgical sync of the six edge files plus tests, `verify:deploy` → `mirror tree -> equal`, explicit Lovable deploy of `osint-agent`, confirm `/health` build moved, record. Merging alone ships only the frontend half; the planner filter, cache TTL and memory supersession are edge code.
3. **Re-run `@glitterkittens12` on the deployed build** and mark the breach branch Wrong mid-run. Three measurements replace this audit's test-based claims: the planner prompt stops naming the rejected branch, `memory_recall` returns the 06:59:35Z identity row as `superseded`, and the report's *Excluded by Analyst* appendix populates.
4. **Widen the sweep's stale detector to the metadata copy** (F9): add `metadata->>cluster_id.not.is.null` to the `.or()` at `rejected-cluster-sweep.ts:93`, so the existing clearer runs over the 351 remnants. One line plus a test that seeds a metadata-only row. Then the health string is true.
5. **Decide #502 vs #516 and close #541** (F10). All three are `dirty`; the longer they sit the more `main` moves under them. Merge `main` into whichever survives — no rebase on another session's branch.
6. **Enable or delete `cache_sweep`** (F11). 99.6 % of the cache table is dead rows; the sweep exists and is off.
7. **Apply `artifacts_synthesis_cluster_uniq` through Lovable** when synthesis is next touched (F12); not before.
8. **Rename or recompute the Pivots badge** (F14): "17 low-confidence" is what it measures.
9. **Phase 3 of the brief**: superseded-message annotation in chat, SocialFetch dedupe, cycle-vs-thread duration, stale `[195s, 240s]` comments in `orchestrator-finalize.ts:33-40` (constants verified: `FINALIZE_RESERVE_MS = 90_000`, `ORCHESTRATOR_WALL_CLOCK_MS = 180_000`).

Standing constraints: no auto-merge, no auto-deploy — JD authorizes both. A mirror merge is not a deploy; the only proof is a moved `/health` SHA. Nothing was deployed, merged or written to production during this audit.

## 9 · Gaps in this audit

No Lovable edge-function log was read; the run under audit ended before the retention window, so every runtime claim rests on tables, code and tests, not on observed log lines. #558 has not run against a live investigation — its five fixes are proven by tests that drive the shipped control flow (and a failure-first case on each that fails on `main`), which is the strongest evidence short of a deploy, and short of a deploy. The "34 in the database vs 32 in the workspace" reconciliation is Likely, not Confirmed: `triage_decision` accounts for one, the second is inferred from the report layer's alias-twin fold. F9's impact through `contradictions.ts` was traced by grep, not executed. F16 was not isolated. The production counts are a point-in-time read at 08:00Z–08:05Z of a live database that the operator's own session was writing to (38 reviews in 24 h). The `project_write` delivery step in the audit routine was not available in this session's toolset; the report lives in the repo and was sent as a file instead.
