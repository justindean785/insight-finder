# SESSION HANDOFF — 2026-10-10 — evidence guards shipped, the learning loop is the next job

> **Take the state from `/health`, `git log origin/main` and the ledger, never from this file's numbers.** Everything dated below is a
> measurement from 2026-10-10 and was already moving when written. Address the user as **JD**. Engineering only — never investigate any
> person who appears in a scan.
>
> Read order for a fresh session: this file → `CLAUDE.md` (rules; dated state now lives in `docs/archive/`) → `docs/proposals/` →
> `SESSION_HANDOFF_2026-10-06_release-train-and-audit-queue.md` (the draft-PR queue and release-recipe traps).

## 0. JD's priority (verbatim intent)

Improve workflow and the ability to **pivot**, make the agent **smarter**, fix the **memory** problems, and make it able to **grow and
learn after every run**: learn from its tools, find what worked and what did not, and keep getting smarter. §5 is the plan for that.
Everything in §2–§4 exists to leave a clean base for it.

## 1. State at the end of this session (re-measure, do not trust)

- Live `osint-agent` = `f9fc281` (E2, confirmed via `checks.user_supplied_status`, ledger row recorded VERIFIED; ledger PR #727). Re-check
  `curl "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"`. Proof keys now present, newest last:
  `checks.run_end_log` (#714), `checks.breach_origin_cap` (#718), `checks.memory_context` (#721), `checks.user_supplied_status` (#724).
- Canonical `main`: E2 `f9fc281`, stamp `5395fb2`, docs slim `bc953cd`, E2 ledger `#727`, this handoff PR (see the PR list).
- Mirror `seeker-spark-search-5362c57c` main: `296bba5` (PR #109). Edge baseline **2217 passed / 0 failed / 6 ignored**.
- Frontend ships on merge via Vercel; **edge does not** — it needs stamp → surgical mirror sync → `verify:deploy` gate → Lovable
  deploy message → `/health` → `record:deploy` → ledger PR (recipe in `CLAUDE.md`). One edge PR in flight at a time.
- Lovable project `4ce11bc3-039d-4439-b293-acacca9e1e3a`, Supabase `skzqwbyvmwqarfgfvyky`, DB readable with the Lovable
  `query_database` tool (read-only SELECTs only; column names learned the hard way: `created_at`, `thread_id`, `parts`, `tool_name`,
  `outcome`, `source`, `metadata`).

## 2. What was done this session (all merged unless marked)

| PR | What | Class | Live |
|---|---|---|---|
| #713 | Auto-run no longer overlaps a still-working server run (poll up to 120 s, `run_overlap` stop reason, send guards use `serverRunActive`) | frontend | yes |
| #715 | Presentation fixes: interrupted-reply notice, no-adjudication footer, rejected-pivot card details, nameserver-pivot filter, count-scope tooltips | frontend | yes |
| #714 | Run-end logging: `run_end` log event + `orchestrator_invocations.error_message = run_end:<cause>` when persistence ran before the loop finished (`premature_client_cancel` / `premature_unknown`); clean runs write nothing | edge | yes (`991c08a`) |
| #718 | **E1** breach-material provenance: a source qualifier naming breach/leak/stealer material + a file noun classifies as `breach` (cap 60). Prod bug: `jina_reader_scrape (FloeIntel breach PDF)` scored 75 | edge | yes (`fceeff4`) |
| #721 | **E3** recalled memory is context, never a source: token leaves the source label (`metadata.context_from_memory`); memory-only rows → `needs_review`. NOTE: the cap engine already ignored memory — scores unchanged, this fixes disclosure | edge | yes (`2e5f78c`) |
| #724 | **E2 (c)** analyst-supplied-only rows keep confidence but can never be `verified`/`confirmed` (→ `observed`, `metadata.user_supplied_unreviewed`). Prod bug: docket pasted by the analyst stored `verified`/90 because the `unicourt.com` host classified it `court_record` | edge | yes (`f9fc281`) |
| #725 | `CLAUDE.md` 83 KB → 65 KB; stale dated-state blocks archived verbatim to `docs/archive/CLAUDE_STATE_HISTORY_2026-09.md` | docs | n/a |
| ledgers/stamps/mirror | #716/#717/#719/#720/#722/#723/#726 and mirror #106–#109 | release plumbing | n/a |
| this PR | proposals preserved in `docs/proposals/`, this handoff, reading-order pointer | docs | n/a |

Also produced (read-only): the 2026-10-07..09 production audit (565 tool calls, ~11 % failed, ~40 % of failures were the model
sending wrong inputs), the `b5d26018` "Interrupted" false-alarm diagnosis (a natural-stop pivot run with no report is labelled
Interrupted by design I-2 — wording problem, not a crash), and the `7a2968e1` case review.

**Corrections to earlier claims (so nobody re-reports them):** (1) E2's audit diagnosis was wrong — status is derived server-side, a
model-supplied `status` is only a request; (2) E3 changes disclosure, not scores; (3) E3's proposed "cap 55" would have *raised*
memory-only rows from 50 and was dropped; (4) the F1 "All, then an unrelated Findings Report" bug is a salvage generation appended to a
prematurely persisted partial message (flush vs cancel in ai@6 `handleUIMessageStreamFinish`), real-world cancel cause still unproven.

## 3. Open work queue (ordered)

**A. Finish / verify what shipped**
1. Confirm the E2 ledger PR (#727) is merged and `deploy/live` == the live build (it was `f9fc281` when this was written).
2. **Production validation owed (needs a real scan):** (a) breach-PDF row now caps ≤ 60; (b) a row citing memory shows
   `metadata.context_from_memory`; (c) a pasted docket stores `observed` + `user_supplied_unreviewed` at the same confidence; (d) a scan
   with the phone backgrounded mid-run → read `orchestrator_invocations.error_message` for `run_end:premature_client_cancel`.
3. Manual check of #715 on case `21e8bc95` (interrupted notice, scope tooltips, rejected-card details).
4. **Relabel PR (UI only, not started):** a `natural_stop` pivot run with no report shows yellow "Interrupted / Run ended without a
   report". Better: "Pivot finished · no report yet" + Write report. Read the RUN_STALLED/RUN_INCOMPLETE derivation first; touch no
   recovery logic (I-1/I-2). Also a 90 s window where the banner reads stalled before the thread flips `finished` (heartbeat lag).

**B. Evidence-integrity leftovers (protected → sign-off first)**
- E4: password-like keys in metadata (21 rows by a broad regex). **Conflicts with the settled `REVEAL_BREACH_DATA` ON decision** — JD must
  say whether masking is wanted; first classify the 21 rows by origin; c93b047a needs a reviewed, reversible plan, never a delete.
- E2 known gap: a MIXED source (`user_supplied (...) + exa_search (...)`) can still reach `verified`.
- Hygiene: 32 duplicate (thread, kind, lower(value)) rows; `kind=other` at confidence > 40; `weak_lead` without `metadata.reason`.
- Draft PRs from the 2026-10-06 queue still untouched: #667 #666 #695 #698 #699 #700 #701 #702 #703 #593 #612 #613 #516.
  `#698` (catalog names) is the base for §3C.

**C. Tool-input coercion (evidence-neutral, cheapest, ~30 failures per audit window — ship as small edge PRs)**
`serus_darkweb_scan` `identifier`→`identifierValue`; `memory_save` accept single object / JSON string for `entries` and validate `kind`;
`google_dorks` `seed`/`kind` types; `exa_search numResults` and `memory_recall limit` numeric strings; `rapidapi_breach_search` validate
email first; `urlscan` query must be a string; `indicia_web_dbs` default `snusbaseType`; `record_artifacts "(unspecified)"` — log the
zod issue path/code when `sent_keys` and `invalid_fields` are empty.

**D. Provider handling:** treat OathNet 401 (check whether JD's fix took — pre-fix 25/44 failed), Opsis 402, FOFA 820001 as *account
states*: suppress after first failure per session, show in Health. `deepfind_*`/`reddit_user`/`gemini_vision` 403 → degraded, drop from
planner while failing. Timeouts: `wayback_cdx_search` 10 s ×1, `gemini_deep_dork` 12 s, `gemini_vision` 20 s, cap `minimax_correlate`
context. (A 403 is not a dead credential — see `CLAUDE.md`.)

**E. Behaviour proposals awaiting JD (do not code until approved):** `docs/proposals/P1_early_save`, `P2_salvage-prompt`,
`P3_next-three-pivots`. P3 is JD's "finish the next 3 pivots inside the same run" — see §5 L4.

## 4. Decisions only JD can make
E4 masking (above) · P1/P2/P3 approval · whether to spend credits on OathNet/Opsis/FOFA/deepfind/reddit or remove those tools · Auto-run
limit stays 3 (JD ruled: do NOT simply raise it) · `CACHE_SWEEP_ENABLED` stays OFF until the payload store exists.

## 5. THE PRIORITY — making the agent learn from every run

### 5.1 What actually exists today (measured; do not rebuild it)
- **Memory is capturing the right things.** `agent_memory`: ~1,395 rows from 2026-05-27, ~517 `kind='lesson'`, ~246 about tool
  reliability. The problem is **retrieval**: `memory_recall` matches on `subject` only (`tool-registry.ts` ~`agentMemoryOrFilter(subj)`),
  so a lesson about a *tool* is filed under the *selector* it was learned on and **101 tool lessons can never resurface**.
- **`tool_usage_log`** keeps 3 months (outcome, status_code, cached, cost) — the durable ground truth for what worked.
- **`tool_health` view → `scoreExpectedValue`** is wired and loaded per run, but `runtime-policy.ts` states EV is **advisory and never
  blocks a call**.
- **Built and unwired** (check before building anything): `shouldAllowToolCall` (`runtime-policy.ts`, has
  `QUERY_FAMILY_NO_YIELD_LIMIT = 3` → `suppress`), `tool-routing-policy.ts` (100 % dead; `RouteContext` already carries
  `highYieldTools` / `failedQueryFamilies` / `duplicateQueryKeys`), `circuit.applyBaselineDisables(threadId)` (an explicitly empty hook,
  called once per thread, meant for a persisted skip list), and the **finding-synthesis** layer (complete, deployed, OFF behind
  `FINDING_SYNTHESIS_*`; prerequisite: confirm migration `20260907000000` `artifacts_synthesis_cluster_uniq` is applied on the live DB).
- **There is NO call-to-artifact lineage.** `artifacts` has no join key to `tool_usage_log`; `metadata.tool` exists on ~38 % of rows
  (auto-persisted only) and stores a tool *name*. So the system can say "this tool returned 200" but not "an analyst kept what this tool
  produced". **Everything below that needs yield is blocked on lineage.** `#613` is the unapplied schema draft (junction table + RLS).
- `/health`'s tools line is a presence test; `checks.credentials` reads real outcomes — read them together.
- Run budgets are per ISOLATE, not per investigation (`clearRuntime(threadId)` each request); `run_budget_prior` (#587) measures spend
  from `tool_usage_log`. A per-investigation cap (A2b) is deliberately not built.

### 5.2 The loop to build (small PRs, in this order; one behaviour + tests + kill switch + new `/health` key each; schema through Lovable first)
- **L0 — instruments (no behaviour):** persist the honest prompt-size terms (`prompt_size_*` is `console.log` only) into
  `orchestrator_step_metrics`; add `run_id` + stable `call_id` to `tool_usage_log`. Needed so any later threshold is set from data.
- **L1 — lineage (the prerequisite):** apply `#613`'s `artifact_tool_lineage` junction table **through Lovable and verify against the live
  DB**; then the write path behind a kill switch. Carry selector *type*, not raw selector value, for cross-case analytics. Never an array
  of ids on the call row (PostgREST URL cap broke the cache sweep that way).
- **L2 — memory retrieval (fixes JD's "memory issues", can ship in parallel with L1 because it needs no schema):** a second recall axis
  keyed by tool name (`tool:<name>`), recalled every run regardless of seed, so tool lessons stop being filed under case selectors.
  Keep tool-level lessons separate from case-level facts. A tool that is wrong *by construction* is a code defect → fix in code, not in
  memory (worked example: 12 HackerRank lessons in memory while `sweeper.ts` had no suppression input).
- **L3 — outcome scoring that acts:** wire the built-but-unwired pieces instead of writing new ones — feed `highYieldTools` /
  `failedQueryFamilies` from `tool_usage_log` into the router context; turn `shouldAllowToolCall`'s `suppress` on behind a flag; implement
  `applyBaselineDisables` from a persisted per-tool skip list; provider *account states* (§3D) are the first clean customers. Report
  what was suppressed and why (a suppressed call must never read as ok — see the dispatch-refusal rules in `CLAUDE.md`).
- **L4 — learn what worked (needs L1):** per tool/dork/query-family yield = artifacts the **analyst kept** (reviews exist) ÷ attempts;
  surface "worked / didn't" in Health and feed it to L3. Add a **tool cache version** bump whenever a tool's result *interpretation*
  changes (`lib/tool-cache-version.ts`) or the cache replays pre-fix rows and the lesson looks like it did not land.
- **L5 — smarter pivoting:** finish the next 3 pivots inside the run (`docs/proposals/P3`), choosing from structured pivot data
  (`pivotSuggestionSchema` / `validatePivotSuggestion`, shared-infra demotion from #715) — never regexes over prose. Needs the
  server-side run lease first (overlapping runs make per-run budgets unreliable; schema + edge, unbuilt).
- **L6 — turn on synthesis** (`finding-synthesis`) only after the migration check above; it runs in the health sweep so it cannot fail
  finalize.

### 5.3 Guardrails for the learning loop (non-negotiable)
Learning may change **which tools run and in what order**; it must never change **evidence authority**: no learned score may raise a
confidence cap, create a `verified`/`confirmed` status, or turn a failed/empty lookup into a finding. Provider failure/empty = coverage
limitation. Generated prose is never a finding. Analyst review stays the only path to Verified. Protected semantics need JD's sign-off.
Ship each step dark (flag OFF) and compare before enabling: self-completion rate (the 61 %→25 % regression metric), `finalize_forced`
share, duration p50/p90, cost per run, failures per 100 calls.

## 6. Traps this session hit (read before the next release)
1. `expectedHeadSha` must be the FULL 40-char SHA — a guessed one gives a misleading 409 "Head branch was modified".
2. `git push` often prints "negotiation failed; proceeding anyway" and still lands — verify with `git ls-remote`.
3. `ledger_ref_divergence` at the gate means an earlier ledger PR is **unmerged** (merge it first, then `record:deploy`).
4. The stamp PR must merge while `main` is still the marker commit; merge the stamp immediately after the code PR, hold other PRs.
5. `marker_offset_mismatch` before the deploy is expected; the hard gate is `mirror tree -> equal` + `mirror pushed`.
6. Subscribing to a PR returns two ~6k-token boilerplate wakes plus bot chatter; the harness may subscribe automatically when a PR is
   opened. **Unsubscribe from stamp/ledger/mirror/docs PRs** (`unsubscribe_pr_activity`) and watch only PRs where CI matters.
7. A `deno check` baseline is ~24 error lines both with and without a change — compare counts, do not read it as a gate.
8. Mixed `git stash` use is shared across worktrees — use worktrees per PR (`/home/user/wt-*` pattern) instead.
9. Proposals and drafts in a container scratchpad die with the container — they are in `docs/proposals/` now.

## 7. Workspace hygiene (JD asked; settings are JD's to change)
~230 skills are listed every turn and almost none are used (~6.8k of ~9.9k tokens/turn is unused packs: writing-skills, twilio-developer-kit,
design-skills, design-superpowers, superpowers, design/engineering/productivity/data, datarobot, agent-army, handoff). 41 `anthropic-skills:*`
sync from claude.ai (keep `code-task`, `osint-*`, `evidence-intake`, `case-ledger-and-improvements`, `google-dorks`). Fix or remove
failing MCP servers: `plugin:github` (400 bad auth header — built-in GitHub tools already work), `plugin:data:definite` (dead endpoint),
`agent-memory` (drops). Disconnect connectors not used for this project. Biggest saving: **one session per workstream** — this session
reached 55 % of a 1M window, 438k of it messages.

## 8. First commands for the next session
```bash
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | python3 -m json.tool | head -60   # build + proof keys
git fetch origin && git log --oneline -8 origin/main
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live && git log --oneline -1 deploy/live
npm run verify:deploy -- --mirror <mirror-clone>        # read-only; expect only marker_offset_mismatch pre-deploy
```
Then ask JD which of §3A/§3C/§5 to start. If JD says "learning loop": start with **L2** (no schema, directly fixes the memory complaint)
in parallel with preparing **L1** (apply `#613` through Lovable, verify against the live DB). One edge PR in flight at a time.
