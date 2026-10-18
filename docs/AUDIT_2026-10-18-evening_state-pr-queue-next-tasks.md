# Current-state audit: PR queue, deploy state and next tasks (2026-10-18, evening)

> *Measured 2026-10-18 between 20:00Z and 20:30Z against `origin/main` `8fae8c8`. This is a dated measurement, not a standing state: re-verify before acting.*
> It follows the morning audit `docs/AUDIT_2026-10-18_full-code-review-lovable-vercel-github.md` (PR #793) and records only what changed since then or was re-measured. Finding numbers F1–F33 refer to that report.

## 1 · Executive summary

**Verdict: in sync and green, and blocked on decisions and money rather than on code.**

**Sync.** Production Vercel serves `main` `8fae8c8`. The `osint-agent` source in the mirror is byte-identical to canonical, in all four shared function folders. Since the last recorded deploy (`cabfeb9`, 10-15) nothing has merged that touches edge runtime code, so there is no deploy lag; the frontend and the edge simply ship on separate channels.

**Gates.** Every gate passed on a clean `npm ci`:

| Gate | Result |
|---|---|
| Lint | 0 errors (10 warnings) |
| Typecheck | passed |
| Vitest | 2653 passed |
| Build | passed |
| Edge suite | 2449 passed, 0 failed |
| e2e | 52 passed, 2 skipped |

**The single most important finding is operational, not code.** Four parts of the stack sit on paid credit, and three of them are short or out:

- **Lovable** ran out of credits today, at 19:55Z according to its own agent. Every edge deploy goes through a message to that agent, so #797 cannot ship until the credits are topped up.
- **Z.AI**, the primary orchestrator, ran dry in the middle of a run at 06:31Z today, for the second time in five days.
- **Anthropic**, the backup orchestrator, has not run since 10-14. The 10-14 handoff says its promotional credit expires 10-23 (Unverified).
- **OathNet** still returns 401 on every call. JD is handling it with the provider.

**Queue.** It is the bottleneck again. There are 11 open canonical PRs, and 10 of them are drafts:
- Only #797 is ready, green and clean.
- Five edge drafts (#764, #741, #738, #701, #613) and one stale mixed PR (#516) conflict with `main`.
- #764 is superseded.
- #763 would break a frontend test on merge, a failure GitHub cannot show.

**Top open question.** Lovable's "free tool fill-ins" prompt arrived today; JD uploaded v2. As written it is about 28 items in one edge change. It runs into three project rules: small PRs, nothing added inside the finalize window, and no blind auto-runs of tools that submit the target publicly. It also needs a plan JD approves before any code is written. §8b is that plan, cut into small PRs.

## 2 · Method and what could NOT be verified

| Source | Reached | Reliability | Notes |
|---|---|---|---|
| Gates, run here | Yes | High (primary) | Isolated worktree on `origin/main`, clean `npm ci`. Durations in §3. |
| Git refs: `main`, `deploy/live`, mirror `main`, tree hashes | Yes | High | Full clone, not shallow. |
| GitHub API: PRs, checks, review threads | Yes | High | Read-only PR sweep with `git merge-tree` conflict tests. |
| Vercel API: production deployments | Yes | High | |
| Production DB | Yes, **SELECT only** | High | Through the Lovable connector's `query_database`. No writes. |
| Lovable project chat, read-only | Yes | Medium | Source for the credits-exhausted claim and the GitHub-secret save. It is the agent's own account, not a billing record. |
| **Live `/health`** | **Deliberately not called** | — | `/health` is not passive (F9): every hit makes a paid GLM call and runs recovery and sweep writes. JD's rule is SELECT-only. So the live edge build is **Likely** `cabfeb9` (ledger, `deploy/live`, mirror tree equality, no edge commit since), **not Confirmed**. |
| Provider balances (Z.AI, Anthropic, Lovable) | No | — | No read-only API was used. Inferred from DB error strings and Lovable's message. |
| Mirror CI logs | No | — | Mirror #117's failures are taken from its PR body. |

## 3 · Measured gates (clean install, `origin/main` `8fae8c8`)

| Gate | Result | Duration | Docs say | Divergence |
|---|---|---|---|---|
| `npm ci` | ok | 21 s | — | |
| `npm run lint` | 0 errors, 10 warnings | 23 s | 10 pre-existing warnings | matches |
| `npm run typecheck` | 0 errors | 27 s | — | |
| `npx vitest run` | **2653 passed / 1 skipped / 210 files** | 114 s | CLAUDE.md: 2560 / 198 (10-14) | CLAUDE.md is stale (F30) |
| `npm run build` | ok | 20 s | — | |
| Edge (`test:edge` flags plus `--no-lock`) | **2449 passed / 0 failed / 6 ignored** | 110 s | CLAUDE.md: 2316 | CLAUDE.md is stale (F30) |
| `npm run test:e2e` (pinned Chromium) | **52 passed / 2 skipped** | 124 s | 52 / 2 | matches |
| `main` CI on `8fae8c8` (push, run 39135642357) | 4/4 jobs green, including e2e | about 6 min | — | Confirmed |

## 4 · Deploy and live state

**Frontend.** Confirmed. Vercel production `dpl_9s1eJWCKUwQNWwFbGccw1JAuvmen` is READY on `8fae8c8`, which is `main`. The previous four production deploys are `940d793` (#794), `14f26fe` (#795), `91bfefb` (#796) and `719b057`, all READY.

**Edge (`osint-agent`).** Likely live as `cabfeb9`.
- `deploy/live` points to `cabfeb9`. The newest ledger row (2026-10-15 14:30Z) records:
  - `runtime_marker` = `cabfeb9`;
  - `mirror_tree_equality` = `equal`;
  - `mirror_push_status` = `pushed`;
  - `deployed_bytes_verified` = `false` (the inherent ceiling).
- `BUILD_MARKER` is `cabfeb9` in both canonical and the mirror.
- The only commit since `cabfeb9` that touches `supabase/functions/` is its own stamp, `df6b6e7`. Everything merged since is frontend or the ledger.
- **So this is not a lag; the edge and the frontend ship separately.**

**Mirror** (`seeker-spark-search-5362c57c`). `main` is at `98c015e`. All four shared function trees are identical to canonical (Confirmed):

| Folder | Tree hash |
|---|---|
| `osint-agent` | `121cb64` |
| `evidence-export` | `3ffcadb` |
| `security-test-lab` | `2c85781` |
| `_shared` | `305af5d` |

- **New today:** two `gpt-engineer-app[bot]` commits at 19:40Z, `4d667bc` "Work in progress" and `98c015e` "Audited 10 scans, 5 issues". Both touch **only** `src/integrations/supabase/previewAuthStorage.ts` (+16/−4), which is the mirror's own frontend. Edge code is not affected, and the Vercel app is not affected. It does reach the deprecated `*.lovable.app` frontend if that is republished (F19).
- `mcp` still exists only in the mirror, and nothing measures whether it is deployed.

**Lovable credits.** Per Lovable's own agent at 19:55Z: "your credits ran out … Continuing here needs more credits." The edge deploy recipe, step 5, is a message asking that agent to run `supabase--deploy_edge_functions`. **Until the credits are topped up, no edge PR can be deployed.** This is new: F34.

**GitHub key.** At 19:48Z, through Lovable's secure form, JD saved a new fine-grained, read-only, public-repo token as `GITHUB_API_TOKEN`.
- The code reads that exact name: `env.ts:288` is `Deno.env.get("GITHUB_API_TOKEN") ?? Deno.env.get("GITHUB_TOKEN")` (Confirmed). New isolates should pick it up without a redeploy (Likely).
- `github_code_search` has not been called since 10-15, so **it is unproven that the key works**. Lovable says the same. See F38.

## 5 · Production measurements (SELECT only, full corpus for each window)

**Orchestrator runs, last 5 days** (`orchestrator_invocations`):

| Day | Provider / model | Runs | Errors | Clean `stop` | Tool calls | Credits |
|---|---|---|---|---|---|---|
| 10-18 | GLM-5.2 (Z.AI) | 20 | 1 | 19 | 255 | $3.93 |
| 10-15 | GLM-5.2 | 21 | 0 | 21 | 351 | $5.93 |
| 10-14 | Anthropic `claude-sonnet-5` | 38 | 19 | 18 | 162 | $13.34 |
| 10-14 | GLM-5.2 | 21 | 0 | 20 | 237 | $3.83 |
| 10-16, 10-17 | — | 0 | — | — | — | — |

- **10-18 06:31Z, GLM.** The run died with `"Failed after 3 attempts. Last error: Insufficient balance or no resource package. Please recharge."` (`stream_error`). It had already done 12 steps and 21 tool calls on thread `035a1a4e`. The next run, at 06:34Z, succeeded.
  - The balance gap was minutes long; the cause (auto-recharge, a manual top-up, or a billing race) cannot be seen from here.
  - By design (#769) the Anthropic backup takes over only when a run *starts* on a failure, never mid-run, so this run was lost. That is F8 again.
- **The 10-14 Anthropic errors**, all from before the fixes:

| Count | Error | Status |
|---|---|---|
| 11 | HTTP 400 `tool_use.input` | fixed by #765 |
| 5 | 401 invalid key | the key was rotated the same day |
| 2 | `premature_client_cancel` | fixed by #758 |
| 1 | workspace-header error | |
| 1 | `"You have reached your specified API usage limits … regain access on 2026-11-01"` | at 02:15Z, on the key that was replaced |

- **Anthropic has not run since 10-14.** Whether the backup works today is **Unverified**.
- The last activity was 19:28–19:37Z today (thread `7e502e78`, 3 invocations, all clean).

**Threads** (`threads`):
- **0** `active` threads carry a run marker, so nothing is stuck right now.
- 5 `active` threads have no run marker. These are blank threads the analyst never typed into; invariant I-1 rightly leaves them alone.
- Finished threads: 178 never recovered, 82 recovered. 11 `stopped` threads have a run marker.

**Tool health, last 4 days** (`tool_usage_log`, `outcome` counts):
- `oathnet_lookup`: **12 failed / 13 ok** (401). Last ok 10-15 14:55Z; last failure **today at 19:31Z**. Still down; JD is handling it.
- `oathnet_subdomains`: 401. `oathnet_stealer_search`: 0 ok / 5 empty.
- `jina_reader_scrape`: 13 failed of 56 (403).
- `gemini_deep_dork`: 6 failed of 18.
- `socialfetch_web_read`: 5 failed of 21.
- `github_code_search`: 2 failed (401, 10-15).
- `reddit_user`: 2 failed (403).
- `deepfind_disposable_email`, `nominatim_geocode`: 403.
- `fofa_search`: error returned with HTTP 200.

**30-day check of the Lovable prompt's "failing tools" figures:** every figure matches the database (calls / failures / typical code):

| Tool | Calls | Failed | Typical code |
|---|---|---|---|
| `reddit_user` | 17 | 15 | 403 |
| `fofa_search` | 10 | 10 | 200 + error |
| `deepfind_email_breach` | 10 | 8 | 403 |
| `deepfind_disposable_email` | 6 | 5 | 403 |
| `deepfind_telegram_channel` | 9 | 6 | 403 |
| `deepfind_telegram_search` | 5 | 4 | 403 |
| `deepfind_ssl_inspect` | 5 | 4 | 403 |
| `deepfind_tech_stack` | 4 | 3 | 403 |
| `nominatim_geocode` | 13 | 9 | 403 |
| `jina_reader_scrape` | 341 | 44 | 403 |
| `socialfetch_web_read` | 203 | 43 | |
| `gemini_deep_dork` | 85 | 25 | |
| `wayback_cdx_search` | 49 | 21 | 503 |
| `crtsh_lookup` | 12 | 6 | 502 |
| `github_code_search` | 12 | 3 | 401 |
| `minimax_web_search` | 441 | 1 | 429 |
| `opsis_search` | 26 | 2 | 402 |
| `opsis_results` | 13 | 1 | |

**The prompt's input-repair (C1) figures are stale.** They are 30-day totals, and most of those rejections predate #747 (memory input normalization) and #790 (google_dorks kind inference). **Since the `cabfeb9` deploy (10-15 14:30Z) there have been only 6 schema rejections in about 23 runs:**

| Tool | Rejections | Shape |
|---|---|---|
| `memory_save` | 2 | `entries` missing |
| `google_dorks` | 1 | `seed` **and** `kind` both missing, so the #790 inference has nothing to infer from |
| `record_artifacts` | 1 | tool-call text did not parse as JSON |
| `minimax_correlate` | 1 | `artifacts` missing |
| `breach_check` | 1 | `value` is a number |

The stored `input_json` keeps only the `runtime` key, so the alias the model used for `memory_save` cannot be recovered. That is the right privacy choice, but it rules out a targeted fix from data alone.

## 6 · PR reconciliation (read-only sweep, all `mergeable_state` read on the first call)

| PR | What | Draft | Mergeable | CI on head | Behind / conflicts | Channel | Status and recommendation |
|---|---|---|---|---|---|---|---|
| **#797** | F3: dispatch checks see Serus, Indicia and CordCat selectors | **ready** | clean | green (`d467e19`) | 3 / none | edge | Codex-clean; 3 threads resolved. **Waiting on JD to merge**, then a deploy that also needs Lovable credits (F34). |
| #793 | Morning audit (docs) | draft | clean | green (`148323c`) | 4 / none | docs | The PR body was stale (it listed #794–#796 as unmerged and #593 as conflicting); corrected with this report. Merge when JD wants it. |
| **#593** | Dedupe never transfers authority between rows (F6 remainder) | draft | clean | green (`4afe07a`) | 1 / none | frontend | Needs JD's sign-off (evidence authority). The Codex P1 of 09-13 is outdated; `9f85623` addresses it, and the design question was handed to JD on 10-18. |
| #772 | Workspace "case console" redesign | draft | clean | green, but stale (10-15) | 24 / none in text | frontend + 6 jpgs | 27 files. `main` has since changed ChatWindow, ThreadSidebar and CaseView, so CI and e2e need a re-run after a `main` merge. JD's call (UI redesign). |
| #764 | Invalid-JSON tool args wedge Anthropic | draft | **dirty** | green (old) | 31 / 2 files | edge | **Superseded by #765** (`0a67138`, deployed). Close it, or salvage only its `history_invalid` error label. |
| #763 | `apify_skip_trace` (new paid tool) | draft | clean | green (old) | 31 / none in text | edge | **The merged tree would fail `edge-deploy-bundle.test.ts`**: its tests sit in `supabase/functions/`, the layout before #774 moved them (F35). New paid provider, so it needs JD's go. |
| #741 | F4/A1: the model cannot write review, release or dismissal keys | draft | **dirty** | green (old) | 60 / 2 files | edge | **Still needed.** The defect is still live on `main`. Rebase, move its tests, sign-off. |
| #738 | Recalled memory is context, not evidence | draft | **dirty** | green (old) | 61 / 3 files | edge | Still needed: `system-prompt.ts:145` still says to cite `[MEMORY] previously corroborated`. 18 files and +2,923 lines, so split it before rebasing. Codex never reviewed it. |
| #701 | LeakCheck key probe for `/health` | draft | **dirty** | green (old) | 98 / 1 file | edge | Its risk premise ("200/day") was overturned by #756 ("fixed query pool"): a probe would drain the pool for good. **Close it.** |
| #613 | Lineage schema (not applied) | draft | **dirty** | green (old) | 98 / `ci.yml` | schema + CI | Prerequisite for the learning layer. It has to go through Lovable and be verified on the live DB. Rebase when it is next in line. |
| #516 | Self-service account deletion (dark) | draft | **dirty** | green (08-29) | **293** / `ci.yml` | **mixed** frontend, schema and CI | 2 Codex P1s and 1 P2 unresolved; parked by its owner on 10-01. Close it or start over from `main`. |
| mirror #117 | Sync `package-lock.json` | draft | unstable | **red** | 6 / none | mirror CI only | Fixes `npm ci`, but mirror CI was already red (F21). Low value, so fold it into the F21 decision. |

## 7 · Findings and action-list delta since the morning audit

**Merged and live (Confirmed: `main` CI including e2e, then Vercel production READY):**

| Finding | PR | Commit |
|---|---|---|
| F6 (Breach Exposure authority) | #794 | `940d793` |
| F10 (sidebar "finished" write) | #795 | `14f26fe` |
| F13 (second billed run on one thread) | #796 | `91bfefb` |
| F10 follow-up (Cases list and case page show a dead run as Interrupted) | #798 | `8fae8c8` |

**Fixed but not merged:**
- **F3:** #797 is ready, green and Codex-clean. It waits on JD's merge, and on Lovable credits for the deploy.
- **F6 remainder:** #593 is a draft waiting on JD's sign-off.

**Still open, unchanged today** (no code merged for them):
- F2, F4 (#741), F5, F7, F9, F11, F12, F14–F22, F24–F32.
- **F33** still needs JD's decision.

**Still open, re-measured today:**
- **F8 (provider money).** Z.AI ran dry mid-run at 06:31Z today. Anthropic has not run since 10-14, and its 10-23 expiry is Unverified.
- **F23 (credentials).**
  - OathNet: still 401 at 19:31Z today (JD handling).
  - DeepFind: still 403.
  - `nominatim_geocode`: still 403.
  - GitHub: new key saved today, untested.

**New this pass:**

- **F34 — Lovable credits exhausted.** Medium confidence, from the Lovable agent's own message at 19:55Z. Every edge deploy, #797 first, needs a Lovable agent message, so the edge channel is blocked until JD tops up. Frontend merges are unaffected because Vercel builds from canonical.
- **F35 — Five edge PRs still carry their tests in the old location.** Confirmed by inspecting the trees. #763 merges without a textual conflict, yet the result would fail `src/test/edge-deploy-bundle.test.ts`, and `test:edge` would no longer run its tests. #764, #741, #738 and #701 need the same `supabase/tests/` move when they are rebased.
- **F36 — The #793 PR body was stale.** Confirmed. It listed #794–#796 as unmerged, #593 as conflicting and #797 as a draft. Corrected alongside this report.
- **F37 — CLAUDE.md baselines are stale.** Confirmed: vitest 2560/198 is now 2653/210, and the edge suite at 2316 is now 2449. This is part of F30, and it rides separately.
- **F38 — The GitHub key is saved but unproven.** The first scan that calls `github_code_search` is the test. Read the result from `tool_usage_log` (`outcome`, `status_code`), not from `/health`.
- **F39 — Small residual of input-schema rejections.** 6 since the 10-15 deploy (§5). Real but small; covered by PR-1 in §8b.

## 8 · Recommended next actions (priority order)

**Everything below needs JD's go. Nothing here merges or deploys by itself, and a mirror merge is not a deploy.**

1. **Money first (F8, F34).**
   - Top up **Lovable**. Without credits no edge fix can ship.
   - Put **Z.AI** on auto-recharge: it ran dry mid-run today.
   - Decide the **Anthropic** budget before **10-23**.
   - *Cost:* account settings only, no code.
2. **Merge and deploy #797 (F3)** once Lovable credits exist. It is ready, green and Codex-clean. Deploy cycle: stamp, surgical sync, `verify:deploy` gate, Lovable message, verify. Each step needs JD's go. The `/health` read in the verify step is the one deliberate, labelled `/health` call.
3. **Sign off #593 (F6 remainder).** Frontend only; it ships when merged.
4. **Decide F33**: option (a), (b) or (c).
5. **Queue hygiene**, all closures needing JD's go:
   - close **#764** (superseded) and **#701** (wrong premise);
   - close or restart **#516**;
   - fold **mirror #117** into the F21 decision.
   - Each closure removes a conflicting draft from the queue.
6. **Free-tool fill-ins (Lovable prompt v2): approve the plan in §8b.** Then build it as small edge PRs, one in flight at a time, **after #797 is deployed**.
7. **Rebase and sign off #741 (F4)**, with the F35 test move. Then split #738 before rebasing it.
8. The rest of the morning audit's list, unchanged:
   - F9: gate `/health`;
   - F7/F12: run-state fixes;
   - F11/F22: schema hardening via Lovable;
   - F20, F21, F29: release tooling;
   - F30/F37: refresh CLAUDE.md.

### 8b · Plan for Lovable's "free tool fill-ins" prompt (v2): needs JD's OK before any code

*Being completed from a line-by-line check of the prompt against the code; see the PR-by-PR plan below.*

## 9 · Gaps in this audit

- **The live edge build was not re-probed** (no `/health`; F9 and JD's rule). "Live = `cabfeb9`" rests on the ledger, the ref and tree equality. A deploy made since the ledger row, without a record, would not show here.
- **Provider balances were not read** (Z.AI, Anthropic, Lovable). They are inferred from error strings and an agent's message.
- **The GitHub key's validity is unknown** until a scan calls `github_code_search`.
- **Mirror CI logs were not read.**
- **Lovable's "Audited 10 scans, 5 issues" commit is opaque.** Its message names an audit, but the diff is a 20-line auth-storage change, and the "5 issues" report exists only in Lovable's sandbox (`/mnt/documents`).
- **CI runs on the PR heads are from their own dates.** "Green" on #772, #764, #763, #741, #738, #701, #613 and #516 says nothing about those PRs against today's `main`.
