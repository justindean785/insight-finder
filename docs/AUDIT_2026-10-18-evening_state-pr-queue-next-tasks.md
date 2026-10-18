# Current-state audit: PR queue, deploy state and next tasks (2026-10-18, evening)

> *Measured 2026-10-18 between 20:00Z and 20:30Z against `origin/main` `8fae8c8`. This is a dated measurement, not a standing state: re-verify before acting.*
> It follows the morning audit `docs/AUDIT_2026-10-18_full-code-review-lovable-vercel-github.md` (PR #793) and records only what changed since then or was re-measured. Finding numbers F1–F33 refer to that report.

## 1 · Executive summary

**Verdict: in sync and green; blocked on decisions, on reported provider credit, and on unmerged evidence-integrity fixes.**

> **Corrected at 21:15Z after an outside review.** The first version said "blocked on decisions and money rather than on code". That understated the integrity defects that are still open on `main`:
> - the model can write analyst-only keys on non-name rows (#741);
> - recalled memory can produce a `confirmed` finding with no tool run;
> - display deduplication donates authority between rows (#593).
>
> §10 records the re-trace and the revised order. The gate results in §3 apply to `main` `8fae8c8`, not to every open PR merged with it.

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

- **Lovable** *reported* running out of credits at 19:55Z (its own agent's message). This review did not verify the balance or whether another authorized deploy route exists. Treat it as a dated report. If it holds, it blocks the Lovable deploy step for #797.
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

- **F34 — Lovable credits reported exhausted.** Unverified. The only source is the Lovable agent's own message at 19:55Z. Nobody has checked the current balance, or whether every authorized deploy route is unavailable. If it holds, the Lovable deploy step for every edge PR (#797 first) is blocked. Frontend merges are unaffected because Vercel builds from canonical.
- **F35 — Five edge PRs still carry their tests in the old location.** Confirmed by inspecting the trees. #763 merges without a textual conflict, yet the result would fail `src/test/edge-deploy-bundle.test.ts`, and `test:edge` would no longer run its tests. #764, #741, #738 and #701 need the same `supabase/tests/` move when they are rebased.
- **F36 — The #793 PR body was stale.** Confirmed. It listed #794–#796 as unmerged, #593 as conflicting and #797 as a draft. Corrected alongside this report.
- **F37 — CLAUDE.md baselines are stale.** Confirmed: vitest 2560/198 is now 2653/210, and the edge suite at 2316 is now 2449. This is part of F30, and it rides separately.
- **F38 — The GitHub key is saved but unproven.** Wait for the next real scan that happens to call `github_code_search`; **do not trigger a scan just to test the key.** Read the result from `tool_usage_log` (`outcome`, `status_code`), not from `/health`.
- **F39 — Small residual of input-schema rejections.** 6 since the 10-15 deploy (§5). Real but small; covered by PR 5 in §8b.
- **F40 — A raw 403 from r.jina.ai suppresses Jina for the rest of the run.**
  - The suppression is Confirmed in code (`circuit.ts` `http_403` → `suppressProvider`) and in production: 4 skips read "provider 'jina_reader_scrape' suppressed", the latest at 05:13Z today.
  - **That these 403s are not a dead key is Likely.** Jina succeeded within minutes before and after each one, and returned 257 ok in 30 days.
  - **The cause of each individual 403 is Unverified.** Response bodies are not stored, and Jina documents no meaning for a 403.
  - Covered by PR 1 (#799), which §10 proposes to amend.
- **F41 — `wayback_cdx_search` returned 1 ok in 49 calls over 30 days** (21 failed with 503s, 19 empty, 8 skipped). Confirmed. Covered by PR 2 in §8b.
- **Opsis ran out of credit twice** (402 "out of API credits" on 10-09 and 10-14), but `opsis_search` succeeded again today. Intermittent; it joins the F8 money list.

## 8 · Recommended next actions (priority order)

**Everything below needs JD's go. Nothing here merges or deploys by itself, and a mirror merge is not a deploy.**

*Re-ordered at 21:15Z after the outside review and the §10 re-trace. The evidence-integrity work now comes before any new tool fallbacks.*

1. **Provider credit (F8, F34): JD's decision, treated as reported conditions.**
   - Confirm the Lovable balance, or another authorized deploy route.
   - Decide Z.AI recharge settings (do not assume auto-recharge exists).
   - Decide the Anthropic budget before the reported 10-23 expiry.
   - No code.
2. **#797 (F3): ready for JD's merge decision.**
   - Re-verified 21:03Z, merged locally onto current `main` in an isolated worktree:
     - lint 0 errors, typecheck clean;
     - vitest 2653 passed;
     - edge suite 2475 / 0 / 6;
     - working tree and lockfiles unchanged.
   - Deploy follows the normal cycle. The `/health` read in its verify step is the one deliberate, labelled `/health` call.
3. **#741: rebase it onto `main`, so the model can no longer write analyst-only keys (§10, Confirmed).**
   - Mechanical rebase: two import-only conflicts, plus moving the tests to `supabase/tests/`.
   - Proposed addition: a model-supplied protective flag may only be `true`.
   - Evidence-integrity work, so it needs JD's sign-off.
4. **Executed-source gate (§10, new, not built).** A tool named in `supporting_sources` grants a source class only if that tool ran in the case. It closes the memory-to-`confirmed` path, which #738 does not close. Needs JD's sign-off.
5. **#593: JD's decision, A, B or C (§10).**
   - Re-verified 21:08Z on current `main`:
     - lint and typecheck clean;
     - vitest 2736 passed;
     - build passed;
     - e2e 52 / 2.
6. **#738: land only its tokenizer slice** (`lib/memory-context.ts`). Its prompt-wording parts are guidance, not enforcement. Split, don't rebase whole.
7. **Decide F33**: option (a), (b) or (c).
8. **Queue hygiene**, each closure needing JD's go:
   - close **#764** (superseded) and **#701** (wrong premise);
   - close or restart **#516**;
   - fold **mirror #117** into the F21 decision.
9. **Tool reliability and fill-ins, after the integrity items:**
   - #799 (amend first; see §10);
   - #800;
   - then the §8b plan, as corrected.
10. The rest of the morning audit's list, unchanged:
   - F9: gate `/health`;
   - F7/F12: run-state fixes;
   - F11/F22: schema hardening via Lovable;
   - F20, F21, F29: release tooling;
   - F30/F37: refresh CLAUDE.md.

### 8b · Plan for Lovable's "free tool fill-ins" prompt (v2): needs JD's OK before any code

The prompt says "plan first, wait for the user's OK", and this section is that plan. Every item was checked read-only against `main` `8fae8c8` and against production.

**Why it is not built as one change.**
- **Size.** It is about 28 items. CLAUDE.md requires one behaviour per edge PR, each with its own tests, kill switch and `/health` key, and at most one edge PR in flight. #797 is in flight now.
- **Deploy cost.** Every edge PR also has to go through the Lovable deploy step, which is blocked on credits (F34).
- **Precedent.** Merged PRs can share one deploy, and #765/#769/#766/#768 did, but each keeps its own proof key.

**What the code check found** (Confirmed unless marked):

| Prompt item | Reality on `main` | Consequence for the plan |
|---|---|---|
| C2 "skip a provider after 401/402" | **Already built**, per invocation: `circuit.ts:474-492` disables the tool and suppresses its whole provider group on 401/403/402. | Nothing to build. The real gap is persistence across invocations, and that is the deferred A2b/C3 work. |
| C1 input repair | **Mostly built**: `lib/memory-input-normalization.ts`, `lib/tool-input-coercion.ts`, `lib/exact-boolean-repair.ts`, `validation.ts:265`, and #790's kind inference. | Only the 6 residual rejections in §5 remain. That is one small PR. |
| B1–B9 "queue tool calls automatically" | **No auto-dispatch mechanism exists.** `playbooks.ts` and `pivot-checklists.ts` produce advisory text, at most 3 pivots per cycle. The comment in `playbooks.ts` that says "queued automatically" is false. | Building a dispatcher runs into `MAX_CONCURRENT_CALLS=3` (lowered to stop bursts), the settled `MAX_PAID_CALLS`, and the termination-oscillation history. **Do B as guidance, not as an engine.** |
| B1 fetch Opsis results "before finalize" | The finalize window opens at about 90 s, step 21 or 36 tool calls (`index.ts:1284-1333`). After that, live lookups are skipped (`cache.ts:1562`). | Adding `opsis_results` to the finalize exemption would put work inside the finalize window, which **CLAUDE.md forbids** (the worst incidents happened there). Do it through guidance, before 90 s. |
| B7 "run urlscan, urlscanner, VirusTotal and archive_url on every URL" | `archive_url` makes a **public** Wayback Save Page Now capture, and the url playbook already lists it as **required**. `urlscanner_scan`, `jina_reader_scrape`, `deepfind_tech_stack`/`ssl_inspect` and `http_fingerprint` all make the target, or a third party, fetch it; `http_fingerprint` does so from Supabase IPs with a self-identifying user agent. | **OPSEC: rejected as written.** Passive lookups (`urlscan_search`, `virustotal_lookup`) can be recommended. Active and public tools stay opt-in. Recommend taking `archive_url` out of "required" (JD's call). |
| A12 raise `gemini_deep_dork`'s timeout to 35 s | `cache.ts:84-96` says "DELIBERATELY NOT RAISED", and a test pins it. The call is non-streaming, so a timeout leaves no partial result. | Reversing a recorded decision needs JD's ruling. Recommendation: **leave it.** |
| A14 GitHub | Already sends Bearer auth, and reads `GITHUB_API_TOKEN ?? GITHUB_TOKEN`. On 401 it retries **without auth**, which cannot work, because GitHub code search requires auth (Likely). There is no `X-GitHub-Api-Version` header and no rate-limit backoff, and the description's "5,000 req/hr" is wrong for search. | One small PR, **after** F38 proves the new key works. |
| A2 FOFA | There is no query builder; the model writes the FOFA query. `{error:true}` handling exists (`tool-registry.ts:2972-2976`). It failed 10 of 10 calls in 30 days. | Either guidance ("no `org=` on this plan") or disabling it with a reason in `capabilities.ts`. JD's call. |
| A10 Nominatim | The user agent already carries a contact address: `insight-finder-osint/1.0 (justindean785@gmail.com)` (`:3747`). There is no 1 req/s limiter and no fallback. It failed 9 of 13 calls. | That user agent sends **JD's email to OpenStreetMap on every call**. Changing it is JD's call. Photon fallback plus a limiter is one small PR. |
| A1 Reddit | No fallback exists. `capabilities.ts:138-140` says disabling it "needs a ruling". It failed 15 of 17 calls, and has never succeeded since the log began. | Needs JD's ruling. PullPush and Arctic Shift are **new third parties that would receive the subject's username.** |
| A3–A9 DeepFind | All `deepfind.me` calls have returned 403 since about 10-10. `circuit.ts` suppresses the whole family after the first 403. | First decide: **fix DeepFind's key or plan (F23), or replace it.** Each replacement is its own PR, and some disclose selectors to new third parties (see below). |

**New defects found by the check** (not in the prompt):
- **F40 — Jina: a 403 from one target suppresses Jina for the rest of the run.** Confirmed in code and in production.
  - When `r.jina.ai` answers HTTP 403, the circuit treats it as a dead credential (`circuit.ts` `http_403`) and suppresses the provider.
  - Jina's key works (257 ok in 30 days), so these 403s are **Likely** not a dead key. Whether each one came from the target or from Jina's own refusal is Unverified: the bodies are not stored. See §10.
  - Production logged 11 such 403s and then 4 skips reading `"401/403 unauthorized — provider 'jina_reader_scrape' suppressed"`, the latest today at 05:13Z.
- **F41 — `wayback_cdx_search` is effectively broken: 1 ok in 49 calls over 30 days** (21 failed with 503s, 19 empty, 8 skipped).
- `urlscanner_scan` has a 45 s internal budget but the 12 s default wrapper, with no override. It is **latent, not observed**: 8 of 8 production calls succeeded, in 2–12.4 s.

**Proposed sequence.** Each item is one small edge PR with tests, a kill switch and a proof key. Fallbacks live **inside the existing tool**, so no new tool schemas are added to every model step, and each result is labelled with the provider that actually answered (`via: "PullPush (Reddit fallback)"`). Each starts only after the previous edge PR is merged; deploys can be batched.

| # | PR | Fixes | Third parties that would receive selectors | Needs a ruling? |
|---|---|---|---|---|
| 1 | A 403 from a target no longer suppresses Jina for the run. Shield it like the 200-wrapped target errors and skip **that URL** only. | F40 | none | no |
| 2 | Wayback reliability: `fl=`, smaller limits and an 8 s budget per query in `wayback_cdx_search`, falling back to the availability API. | F41, A13 | none (archive.org already) | no |
| 3 | crt.sh → **CertSpotter** fallback inside `crtsh_lookup`/`crtsh_subdomains` on a 5xx or a timeout. | A6 (crt.sh failed 9 of 17) | CertSpotter receives **domains** (public CT data) | provider OK |
| 4 | Two **separate** operations as the fallback for `deepfind_disposable_email`: (a) a **local** match against the open disposable-domains list, cached per cold start; (b) an **optional** MX lookup over the existing DoH path. | A4 | (a) discloses nothing. (b) discloses the **domain** to the DoH resolver (Cloudflare), as `dns_records` already does. *(corrected 21:15Z)* | (b) needs OK |
| 5 | Input-repair residuals, *corrected 21:15Z*:<br>– **no blind number → string repair.** A number cannot regain lost leading zeros or precision, so repair only when the selector is unambiguous (for example a safe integer for a field that never has leading zeros); otherwise keep the clear rejection;<br>– `minimax_correlate` with no `artifacts`: check the intended contract first. It must return an explicit skip or error, never a fake success;<br>– a keys-only shape log for `memory_save` with no `entries`, so the next occurrence names the alias the model used. | C1 residual (6 rejections) | none | no |
| 6 | GitHub: add `X-GitHub-Api-Version`, drop the unauthenticated retry for code search, respect `X-RateLimit-Remaining`/`Retry-After`, and correct the description. | A14 | none (GitHub already) | after F38 |
| 7 | Guidance-only update to `playbooks.ts`/`pivot-checklists.ts`:<br>– fetch Opsis results before 90 s;<br>– `exa_find_similar` after a strong profile URL;<br>– OpenCorporates/GLEIF for an organisation;<br>– HIBP k-anonymity for exposed passwords;<br>– Hudson Rock for stealer hits;<br>– ransomware.live for a domain or org.<br>Also correct the false "queued automatically" comment and drop the unregistered `osintnova_phone_lookup`. Measure the prompt size before and after. | B1–B6, B9 as guidance | none | no |
| 8 | Nominatim: a 1 req/s limiter and a **Photon** fallback, with `census_geocode` first for US addresses. | A10 | Photon receives **addresses** | provider OK; user agent is JD's call |
| 9 | Telegram public preview (`t.me/s/<channel>`, first party) as the fallback for `deepfind_telegram_*`. | A5 | Telegram itself | DeepFind decision |
| 10 | Reddit fallback through PullPush, then Arctic Shift. | A1 | both receive **usernames** | **Reddit ruling** |
| 11 | XposedOrNot as the breach fallback; leads only, capped at 60. | A3 | receives **email addresses** | **provider OK** |
| — | MAC vendor lookup (A8), tech-stack fingerprint (A7), `bosint` disable (A15), FOFA disable or guidance (A2), `minimax_web_search` cap (B10). | | | Low volume. Each needs a ruling, and B10's cap is per isolate (A2b). |

**Not proposed:**
- the auto-dispatch engine;
- raising `gemini_deep_dork`'s timeout;
- auto-running active or public tools on every URL;
- fetching Opsis inside the finalize window;
- C3, the cross-scan pause. Its pieces are built but not wired (`tool_health`, `shouldAllowToolCall`, the empty `applyBaselineDisables`). Wiring them blocks calls, so it needs operator sign-off and the A2b week of data. CLAUDE.md: "a 403 is not a dead credential".

**Decisions JD needs to make before any of this starts:**
1. Approve the sequence above, or reorder it.
2. Approve or refuse each **new third party** that would receive a subject's selectors:
   - CertSpotter (domains);
   - Photon (addresses);
   - PullPush and Arctic Shift (usernames);
   - XposedOrNot (emails).
3. Reddit: replace with the fallback, disable, or leave as is.
4. DeepFind: fix the key or plan, or replace it.
5. Nominatim's user agent, which currently sends JD's email.
6. Whether to take `archive_url` out of the url playbook's "required" list.
7. Top up Lovable credits (F34). Nothing ships without them.

## 9 · Gaps in this audit

- **The live edge build was not re-probed** (no `/health`; F9 and JD's rule). "Live = `cabfeb9`" rests on the ledger, the ref and tree equality. A deploy made since the ledger row, without a record, would not show here.
- **Provider balances were not read** (Z.AI, Anthropic, Lovable). They are inferred from error strings and an agent's message.
- **The GitHub key's validity is unknown** until a scan calls `github_code_search`.
- **Mirror CI logs were not read.**
- **Lovable's "Audited 10 scans, 5 issues" commit is opaque.** Its message names an audit, but the diff is a 20-line auth-storage change, and the "5 issues" report exists only in Lovable's sandbox (`/mnt/documents`).
- **CI runs on the PR heads are from their own dates.** "Green" on #772, #764, #763, #741, #738, #701, #613 and #516 says nothing about those PRs against today's `main`.

## 10 · Review corrections and integrity re-trace (2026-10-18, 20:56–21:15Z)

*Prompted by an outside review of this report. Read-only throughout: no merges, deploys, PR closures, Lovable messages, `/health` calls or scans. Production was read with SELECT only.*

### 10.1 · State re-verified at 20:57Z

- **Unchanged since the evening audit.** `main` is `8fae8c8`, `deploy/live` is `cabfeb9`, `BUILD_MARKER` is `cabfeb9`, and mirror `main` is `98c015e`.
- **Function trees.** All four shared folders are EQUAL between canonical and mirror (`osint-agent` `121cb64`, `evidence-export` `3ffcadb`, `security-test-lab` `2c85781`, `_shared` `305af5d`).
- **Ledger row (10-15 14:30Z).** It records `runtime_marker cabfeb9`, `mirror_tree_equality equal`, `deployed_bytes_verified false` and `deployed_artifact_digest null`.
- **Four layers, which this report keeps apart:**

  | Layer | Status |
  |---|---|
  | Repository equality | Confirmed |
  | Recorded deployment | Confirmed that the record exists |
  | Runtime marker *now* | Unverified: no `/health` call; `npm run verify:deploy` also calls `/health`, so it was not run |
  | Runtime behaviour | Unverified, as it always is |

- **No new commits on older PRs.** Every older PR's head is unchanged since the evening sweep. The only new PRs are #799 and #800. Both are drafts, and CI is green on both heads (`8d2db98`, `666ec8c`).
- **No concurrent session** is working on the repo (`list_sessions`).

### 10.2 · Integration tests on current `main` (isolated worktrees, local merge commits, never pushed)

| PR + `main` | lint | typecheck | vitest | edge | build | e2e | tree after |
|---|---|---|---|---|---|---|---|
| #797 (`d467e19`) | 0 errors / 10 warnings | ok | 2653 / 1 / 210 files | **2475 / 0 / 6** | — | — (edge only) | clean |
| #593 (`4afe07a`) | 0 errors / 10 warnings | ok | **2736 / 1 / 213 files** | — | ok | **52 / 2** | clean |

- **#797:** all 4 review threads are resolved.
- **Test locations.** The tests for #797, #799 and #800 live in `supabase/tests/osint-agent/`. The tests for #741, #738, #763, #764 and #701 still live under `supabase/functions/` and would fail `src/test/edge-deploy-bundle.test.ts` (F35).

### 10.3 · The highest-impact unresolved defects (each traced with file:line on `main` `8fae8c8`)

**A. The model can write analyst-only keys onto artifacts. Confirmed in code; #741 fixes it and is not merged.**
- **Where it happens.** `record_artifacts` (`tool-registry.ts:5712-5713`) and `record_artifact` (`:6182-6183`) build `metadata` as `{...(a.metadata ?? {}), …server keys}`. After that, the server overwrites only status/category/cluster/reason/contradiction/cap keys. `scrubArtifactRow` (`safety.ts:47-135`) never removes a key.
- **Which client writes.** These paths use the user-JWT client (`auth.ts:114`), and RLS checks only `auth.uid() = user_id`. The database therefore cannot tell a model write from an analyst write.
- **The only guard.** The one `delete meta.linkage_confirmed` sits inside the name-quarantine branch (`:5749-5755`, `:6216-6221`). Username, email, phone and unquarantined-name rows keep whatever the model wrote.
- **Keys the model can write, and what they do:**

  | Key | Effect |
  |---|---|
  | `reviewed` | ATTESTED label (`src/lib/intel.ts:625`); "verified" status |
  | `linkage_confirmed` | Releases quarantine (`src/lib/quarantine.ts:58`) |
  | `false_positive` | Self-dismissal |
  | `parent*` / `seed` | Changes labels to CORRELATED and adds graph edges |
  | `source_quote` / `ownership_proof` | Cluster promotion to 90 / CONFIRMED (`lib/cluster.ts:280-283`) |
  | `subject_unlinked:false` / `possible_minor:false` | Release a quarantine through the frontend dedupe merge (C below) |

- **Production prevalence (SELECT, 11,082 non-auto-persisted, non-finding rows since 07-05):**

  | Model-written key | Rows |
  |---|---|
  | `reviewed=true` | **0** |
  | `linkage_confirmed` | **0** |
  | `false_positive=true` | 2 |
  | `source_quote` / `ownership_proof` | 4 (none promoted ≥ 90) |
  | Protective flags written `false` | 7 (none with a quarantined twin) |
  | Parent pointers | 373 (53 containing `@`) |

  The path is live but has barely been used. Whether the 53 `@` parent pointers changed any label is Possible, not measured.
- **What #741 does.** It strips `reviewed`, `linkage_confirmed(_at)`, `false_positive`, `review_state`, `analyst_confirmed`, `analyst_review`, `attested` and `human_verified` from P1 and P2, and discloses `analyst_authority_stripped`. Kill switch: `ANALYST_AUTHORITY_STRIP_DISABLED`. Proof key: `checks.analyst_authority_boundary`.
- **Rebase needs.** Base `32f5ddb`, 60 commits behind. There is one import-only conflict in each of `tool-registry.ts` and `health-handler.ts`, and two test files must move.
- **What #741 does not cover** (each is evidence-ranking work and needs JD's ruling):
  - protective flags written `false`;
  - `source_quote` / `ownership_proof`;
  - `parent*` / `seed`;
  - `user_provided` / `analyst_provided`;
  - custody `classification:"hard"`;
  - `label:"triage_decision"`;
  - re-recording a quarantined non-name selector, which yields an unquarantined row.

**B. Recalled memory can become a `confirmed` finding with no tool run. Confirmed in code and by a local probe; not closed by #738.**
- **The prompt invites it.** `system-prompt.ts:145` tells the model to cite memory as `"[MEMORY] previously corroborated"`.
- **Nothing checks the citation.** `record_finding` takes `supporting_sources` as free "Tool names that produced the evidence" (`tool-registry.ts:6856`). `lib/finding-row.ts:95-97` counts those names as source classes, and `confidence.ts:714` gives `independent >= 2 && !contra → "confirmed"`. Nothing checks that a cited tool ran; the only such check is for `breach_exposure`.
- **The E3 guard does not catch it.** `MEMORY_TOKEN_RE` in `lib/memory-context.ts:18` only strips tokens that start with "memory".
- **Probe result.** A memory row naming `court_record_search` plus a news site, re-cited by `record_finding`, persists as classes `court_record` + `news`, independent count 2, status `confirmed`.
- **Production use (SELECT):**
  - 25 finding rows ever, 7 in the last 30 days;
  - **0** with status confirmed or verified;
  - `record_finding` called 8 times and `memory_recall` 160 times in 30 days;
  - of 199 cited sources, 105 are known tool names, and **1** names a tool that never ran in its thread.

  The path is reachable and rarely exercised today.
- **Related gap.** 94 citations are free text, and free text can classify into a counted class (probe: "county assessor parcel record" → `government_property_record`).
- **Smallest fix (not built).**
  - A `lib/executed-source.ts` filter in `record_finding`, then `record_artifacts` and `record_artifact`: a known tool name that has no run in this thread grants no class.
  - The originals are kept in metadata.
  - It only ever lowers, and fails open with a logged event.
  - Kill switch `UNEXECUTED_SOURCE_GATE_DISABLED`; proof key `checks.executed_source_gate`.
- **#738.** Its only enforcement change is the `MEMORY_TOKEN_RE` widening (about 70 runtime lines). The rest is prompt and history wording, which is guidance, not enforcement. It is 18 files, +2,923 lines, 61 commits behind, with conflicts in 3 files and 5 test files in the old location.

**C. Display dedupe donates authority between rows, and the release button can save the donated metadata. Confirmed in code; #593 fixes the merge.**
- **The merge.** `dedupeArtifacts` (`src/hooks/useThreadArtifacts.ts:70-99`) groups by kind + value, spreads the later row's metadata over the earlier one, and takes max confidence. Which row survives depends on arrival order.
- **The release button.** It writes `{...meta, ...patch}` from the *merged* item back onto the surviving row (`ResourcesPanel.tsx:957`). So a display merge can become stored data (Confirmed in code; whether it has happened in production is Unverified).
- **#593 shows each row under its own authority.** It also brings three value-level rules that are themselves evidence-integrity changes:
  - rejections spread across rows of a value;
  - the minor-safety ceiling spreads across rows of a value;
  - corroboration is counted per value.
- **Side effect.** Counts become "N values (M records)" on some surfaces, while other surfaces still count records, so the numbers will differ (Confirmed by grep).
- **JD's choice:**

  | Option | What it means |
  |---|---|
  | **A** | Approve #593 as built, including the three value-level rules. |
  | **B** | Collapse to one item per value, using the weakest authority. Not built; it restores #794's over-exclusion. |
  | **C** | Keep #593 parked; the donation continues. |

  Ship #741 regardless: it is complementary.

### 10.4 · Corrections applied to this report

| Was | Now |
|---|---|
| "blocked on decisions and money rather than on code" | Integrity defects A–C are open code defects |
| Lovable credit exhaustion stated as fact | A dated, reported condition; balance and alternative routes unverified |
| Jina 403s are "about the target, not the key" | Not a dead key is Likely; the cause of each 403 is Unverified (bodies not stored) |
| PR 4 "nothing is disclosed" | The local list match discloses nothing; the MX lookup discloses the domain to the DoH resolver |
| PR 5 "number → string" | Repair only when unambiguous; a missing-`artifacts` call returns an explicit skip or error, never a fake success |
| F38 "the first scan is the test" | Wait for a natural scan; do not trigger one to test the key |
| Tool fill-ins at position 6, #741 at 7 | Integrity work (#797, #741, executed-source gate, #593, #738 slice) before tool work |

- **The old cheatsheet is historical only.** `INSIGHT_FINDER_AGENT_CHEATSHEET.md` was last verified 2026-07-05. Its model details, and its instruction to call `/health` first, are stale.
- **Proposed #799 amendment (not pushed; needs JD's OK).** Keep provider suppression for a 403 whose Jina error body indicates auth, billing or quota. Treat a 403 as page-level only when the body says nothing of the kind. Also record Jina's error `name` in the error string (for example `jina 403 (<name>)`), so future 403s become measurable. No page content is logged. The alternative is to park #799 and ship only that measurement first.
