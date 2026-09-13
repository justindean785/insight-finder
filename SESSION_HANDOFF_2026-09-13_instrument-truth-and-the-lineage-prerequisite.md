# Session handoff — 2026-09-13

## Instrument truth, the deploy that landed, and the lineage prerequisite

> Every number in this file is a **dated measurement, not a state**. Re-verify before acting.
> This file corrects the ones before it. The one after it will correct this one.

---

## 0 · Start here — five minutes, before anything else

```bash
git fetch origin main && git log --oneline -5 origin/main
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live   # fresh clones lack this ref
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
```

**Expect `main` = `811c2cd` or later, and live edge build = `c87c07b`.**

If either moved, another session has worked this repo — find the newest `SESSION_HANDOFF_*.md`
and read it before this one. That has now happened **five** times, and once produced two
conflicting PRs for one task (#548 / #551).

**Then, before writing any code, run `list_pull_requests` and look at `draft`.** Nine PRs were
open at the close of this session. The merge queue — not the deploy — is this project's
documented bottleneck.

If the sandbox clone is fresh, also run `git fetch --unshallow --filter=blob:none`. The clone is
shallow at depth 50, which fabricates merge-bases and makes every divergence measurement wrong.
This session unshallowed it (838 commits); a new sandbox will be shallow again.

---

## 1 · Verified state — 2026-09-13T00:30Z

| Axis | Value |
|---|---|
| `origin/main` | `811c2cd` (#587 `c87c07b` → #588 stamp `4bdd1b4` → ledger `95b8d50` → #589 → #590 `811c2cd`) |
| Live `osint-agent` build | **`c87c07b`** — deployed and verified 2026-09-13T00:02Z |
| `deploy/live` | `c87c07b`, local and remote |
| Mirror `main` | `71b79c4`; `diff -rq` **empty** for `osint-agent`, `evidence-export`, `security-test-lab`, `_shared` |
| `verify:deploy` | **VERIFIED**, `mirror tree -> equal` (`e0330dd1bf66`) |
| Vercel production | READY, `target: production`, on `c87c07b` |
| Edge suite | **1832 passed / 0 failed / 5 ignored** |
| Frontend suite | **2104 passed / 1 skipped / 172 files** |
| e2e (by hand only) | **52 passed / 2 skipped** |
| Open PRs | **9** — #586, #579, #574, #570, #567, #564, #541, #516, #502 |
| Undeployed edge code | **none** — the only `supabase/functions/` change since `c87c07b` is `build-info.ts` itself, which is the documented stamp offset |

**Nothing of this session's work is pending deploy.** Re-confirmed at 00:30Z against `/health`,
`git diff c87c07b..origin/main -- supabase/functions/`, and `diff -rq` on all four function dirs.

Deliberately dark, so you do not expect behaviour that is not there:
`cache_sweep: disabled` (the chunking fix is live; the switch is a separate call) and
`synthesis: disabled` (unchanged, two flags).

---

## 2 · What this session did

### 2.1 Shipped and deployed — build `c87c07b`

Four instruments, three new modules, 27 new edge tests, and one real bug fix.

| Item | What it is |
|---|---|
| `prompt-size.ts` | Counts the prompt terms that can be measured **exactly**, and names the one that cannot (`tool_input_schemas_serialized`) rather than estimating it. zod@3 has no JSON-Schema export, so those bytes are not countable from inside the function. `toolCount` is a count and is never summed into a char total. Emitted as `prompt_size_initial` and `prompt_size_step`. |
| `lib/run-budget.ts` | Classifies prior `tool_usage_log` rows into what actually consumed a paid slot — cached replays and `outcome === "skipped"` consumed nothing; failed and empty paid calls did. The paid predicate is **injected, not imported**, so it cannot drift from the admission gate. Emitted as `run_budget_prior`. |
| `lib/credential-health.ts` | Auth-refusal / recovery summary over a rolling 7 days. "Recovered" means a success strictly **after** the last refusal. EMPTY negatives count as a working credential; governance skips count as nothing. Surfaced as `/health` → `checks.credentials`. |
| `cache-sweep.ts` | **A real fix.** It handed up to 5,000 uuids to one `DELETE`, and PostgREST renders `.in()` into the URL query string — roughly a 185 KB URL against a ~24 KB gateway cap. The sweep could never have drained a row. Now chunks at `CACHE_SWEEP_DELETE_CHUNK = 300`; a chunk fault returns, so `deleted` reports only what was actually removed. |

Frontend, shipped on Vercel in the same merge:

- **`LiveActivityCard`** — a live run now collapses to one expandable `<details>` row instead of
  flooding the chat with tool cards. `role="status"` is on the one-line summary only, never a
  `role="region"` named `/run/i`, which an e2e contract forbids.
- **Evidence badge counts analyst-actionable artifacts**, with a `title` hint reconciling it
  against the header's total. Moved 55 → 42 on the harness fixture.

### 2.2 The deploy itself

Executed the full canonical recipe without skipping a step: merge → `npm run stamp:build` →
surgical mirror sync of exactly 11 files → **hard gate re-run immediately before the deploy
message** → explicit Lovable deploy → confirmed the `/health` SHA moved → recorded the ledger and
pushed `deploy/live`.

The mirror sync went in as **mirror PR #84** rather than a direct push, because this session was
branch-scoped. That worked and is fine, but note the extra step: the mirror PR must be **merged**
before the Lovable deploy message, since Lovable pulls the mirror's `main`, not a branch.

**Proof of deploy was behavioural, not just the marker.** `checks.credentials` is a key that only
`c87c07b` introduces, so its presence proves the deployed *bundle* contains the new handler —
which `BUILD_MARKER` alone never could, since that is a static string the running code echoes
about itself. **Do this every time**: each deploy should introduce one new observable key.

### 2.3 Documentation and record

- `CLAUDE.md` dated-state block rewritten; baselines re-measured (not carried over).
- A new section recording **where each telemetry number durably lives** (§3.3 below).
- The "instruments that were lying (all fixed)" heading was itself a lying label and was rewritten
  per item — #587 made all four legible and repaired exactly **one**.
- Deploy ledger row + `deploy/live` published.

---

## 3 · Findings that change the plan — all verified against primary sources

### 3.1 `github_code_search` has never once succeeded — and the fix did not take

Measured against `tool_usage_log`, not inferred. **Every** call in the 21-day window failed
`github 401`, including one at `2026-09-12T20:53Z` — hours after the token was reported fixed.
There is not one `ok` row in the window.

The secret the code reads is **`GITHUB_API_TOKEN`**, falling back to `GITHUB_TOKEN`
(`env.ts:256`), and it lives in **Supabase → project `skzqwbyvmwqarfgfvyky` → Edge Functions →
Secrets**. It is *not* the Claude Code GitHub MCP connector — that is a separate system and works
fine. This confusion already happened once; do not repeat it. A PAT with `public_repo` scope is
enough; it only raises the code-search rate limit from 60/hr to 5,000/hr.

By contrast **`rapidapi_breach_search` is 19 ok / 0 failed over 7 days** — that fix is confirmed.
`reddit_user`'s single failure is 2026-09-07 (datacenter-IP block, expected).
`deepfind_email_breach` is 3 ok / 2 failed and appears in the refusing list only because its most
recent event was a failure. **Do not read `checks.credentials` as four dead providers.**

### 3.2 There is no call-to-artifact lineage — and it blocks the entire learning layer

This is the most important structural finding of the session and it was not in any prior plan.

`artifacts` columns are: `id, thread_id, user_id, kind, value, confidence, source, metadata,
created_at, cluster_id, subject_id`. **There is no join key to `tool_usage_log`.**

Measured on 14 days of production:

- `metadata.tool` exists on **714 of 1,868** artifacts — **38% coverage**, and only on
  auto-persisted rows (`auto_persist_source` and `via` have the identical 714 count).
- It stores a tool **name**, not a call id. It cannot distinguish which of 74 `minimax_correlate`
  calls produced a row, and it cannot join to `tool_usage_log` at all.

**Consequence: per-source yield cannot be computed honestly today.** Every "which sources are
worth calling" feature — the whole learning layer, and JD's original "15 false positives" ask —
depends on joining an analyst verdict back to the call that caused the artifact. That join does
not exist. **Lineage is a prerequisite, not a nice-to-have, and it must come first.**

### 3.3 Where each number durably lives

A meter nobody can read a week later is not a meter.

| Store | Retention, measured | Holds |
|---|---|---|
| `tool_usage_log` | **15,136 rows back to 2026-06-08** — three months | every tool call: `outcome`, `status_code`, `cached`, cost. **Durable.** |
| `evidence_log` / `artifacts` / `threads` | back to 2026-06-08 / 07-05 / 07-05 | case data. Durable. |
| `orchestrator_invocations` / `orchestrator_step_metrics` | **only 2026-09-11 onward** (58 / 350 rows) | per-invocation and per-step timing + context |
| `prompt_size_*` / `run_budget_prior` | **nothing — `console.log` only** | the honest prompt terms and prior spend |

**The two-day floor is NOT a purge.** No `pg_cron`, no trigger on either table, every other table
holds months. They are a two-day-old feature —
`supabase/migrations/20260908000000_orchestrator_telemetry.sql` from #560, applied live around
2026-09-11. They accumulate normally. (That migration is absent from the live ledger, which tops
out at `20260825024640` — more evidence that `supabase/migrations/` is **intent, not mechanism**.)

**The real gap is narrower and worse: the durable table records the WRONG number.**
`orchestrator_invocations.initial_context_chars` and `orchestrator_step_metrics.context_chars` are
fed by `approxPromptChars` (`telemetry.ts:175,223`) — the meter that omits the workflow addendum,
the analyst-decisions block, the per-step directives and every tool schema. The honest measurement
reaches only short-lived edge-function logs.

So: **A2b (the budget) is safe** — it reads `tool_usage_log`. **A context-size target is not
safe to set from telemetry yet** — give `prompt_size_step` a durable home first.

### 3.4 The run caps are per ISOLATE, not per investigation — still true, now measured

`index.ts:331` calls `clearRuntime(threadId)` on **every request**, and that is
`THREADS.delete(threadId)` — while `runtime-policy.ts:296-299` claims only "a brand-new
investigation" clears them. An investigation is 2–12 invocations, so `MAX_PAID_CALLS = 12` is
really **24–144 paid calls per case**. Production corroborates: 130 calls/12 invocations, 112/9,
102/6. It also explains 74 `minimax_correlate` calls against a documented cap of 2.

`run_budget_prior` now measures it. **Enforcing it is deliberately not done** — see §4.

---

## 4 · Deliberately NOT done, and why

Read this before "finishing" anything here. Each was a decision, not an omission.

- **A2b — enforcing the per-investigation cap.** Blocked on production data on purpose.
  `MAX_PAID_CALLS` staying bounded is a settled operator decision; setting the replacement number
  from an estimate is the exact error that once condemned a healthy provider (RapidAPI, which was
  serving 391 successful lookups while a datasheet called it permanently dead).
- **`approxPromptChars` was not fixed.** It **routes providers**, so changing it changes
  behaviour. The honest meter ships beside it instead. Do not "clean this up."
- **`seedTypes` was not populated.** It looks like the obvious way to shrink the ~95–105k char
  tool-schema payload, and it is the wrong mechanism: OSINT pivots **derive** new selector types
  mid-run — an email seed yields a domain the run must then follow. Gating on the *seed* type
  breaks pivoting. Cut tool `description` prose instead, and only after `prompt_size_step` reports
  a real number.
- **`CACHE_SWEEP_ENABLED` left OFF.** The chunking fix shipped first so flipping the switch is a
  separate, reversible decision. Before tuning TTLs, measure **key-miss vs expiry** — L2 is keyed
  on full-param `input_hash`, which may be the real reason for the 1.6% hit rate.
- **No schema changes.** Everything shipped is code-only, precisely so the deploy stayed inside
  one well-understood channel.

---

## 5 · The goal — what "done" actually looks like

The product outcome, unchanged since the operator stated it:

> **~3 minutes instead of 8. ~25 high-signal artifacts instead of 123 mixed ones. And a system
> that visibly sharpens with use.**

Today: **7.6% signal** (1,151 artifacts over 20 runs, 88 at confidence ≥70), **16% of invocations
end on purpose** (59% are `finalize_forced` at the wall clock, 22% die in `stream_error`), and
**nothing is learned** (1,003 human labels, 1,384 memory rows, a 12,212-row cache at a 1.6% hit
rate).

The differentiator is the last clause. Across the eleven platforms analysts compare this to —
Maltego, SpiderFoot, Lampyre, Skopenow, Social Links, OSINT Industries, IntelX, ShadowDragon,
PenLink, Babel Street, espectrosint — **none learns from its operator.** A closed, auditable loop
(execution → evidence → analyst verdict → smarter future routing) is the thing nobody else has.

| Gate | Today | Target |
|---|---|---|
| Initial prompt, all terms counted | ~275K chars | ≤135K |
| `finalize_forced` / `stream_error` / `natural_stop` | 59 / 22 / 16% | <30 / <8 / >45% |
| Median run wall | ~500s+ | <200s |
| Primary-board artifacts per run | ~44 median | 20–35 |
| Share ≥70 confidence | 7.6% | >25% |
| Cache hit rate | 1.6% | >20% |
| Calls to dead providers | every run | 0 |

---

## 6 · The roadmap — ordered, with the reasons for the order

This folds in four ideas cherry-picked from Codex's planning PR #586 (see §9). The **ordering is
the point**: lineage before learning, measurement before targets.

### Gate 0 — establish truth (do this first, it unblocks everything)

**G0.1 — Set `GITHUB_API_TOKEN`.** Operator action, five minutes, restores a dead capability.

**G0.2 — Call-to-artifact lineage.** §3.2. An `artifact_tool_lineage` junction table plus
`run_id` and a stable `call_id` on `tool_usage_log`. **A junction table, not an array column on
the call row** — an array re-creates the PostgREST `.in()` URL-length failure that broke the cache
sweep. Also carry **selector *type*, not raw selector value**, for cross-case analytics: that is
privacy-correct *and* it solves the standing problem that rejection keys are per-thread only.

**G0.3 — Replay benchmark.** 20 sanitized cases with **frozen tool responses**, so a change can be
compared deterministically instead of against drifting live traffic. This is the single biggest
gap in the current process: it is why nobody can tell whether a change helped. It would also have
let A2b be decided in an afternoon instead of a week.

**G0.4 — Normalized outcome taxonomy.** `usable | no_record | duplicate | skipped | blocked |
malformed | timeout | upstream_error`. Extends the half-built `outcome` column.
`checks.credentials` had to special-case 401/403 precisely because the taxonomy is too coarse.

### Phase 1 — volume at the source

**P1.1 — `coverage_observations`.** A checked-and-clear breach lookup was never evidence *about
the subject*; it should not enter the analyst's triage queue as an artifact. This cuts the "123
artifacts" number **at the write path** rather than hiding it in the UI. **Guardrail: they stay
persisted and visible.** "We checked X and found nothing" is real chain-of-custody value in a
defensible report — *quarantine is disclosure, not deletion*, and that rule extends here.

**P1.2 — Prompt clauses that mandate volume.** `system-prompt.ts:114` ("MANDATORY… EVERY seed, no
exceptions"), `:118` (exhaustion), `:139` (record everything). Replace with a seed-kind minimum
set plus an explicit stop condition. **Largest single lever on volume, and it is a prompt edit.**
Ship it alone, on one seed kind, and compare on the G0.3 corpus.

**P1.3 — `{{FINDINGS_TABLE}}` server-side expansion.** `record_finding` already derives the true
independence count and persists a capped confidence; the model then **retypes the table in prose**
and the correct numbers never reach the report. Expand a marker server-side before the message is
stored. No markdown parsing of model output. **It must never be able to fail finalize.**

### Phase 2 — budget and context

**P2.1 — A2b.** Persist `paidCalls` / `totalCalls` / `toolCounts` / the correlate counter across
invocations of one thread, so the caps mean what their own comment claims. Then set the
per-investigation number **from the measured distribution**, with operator sign-off. Pre-agreed
starting proposal, subject to the data: 24 paid / 60 total / 16 same-tool / 3 correlate, all
env-overridable, recording and finalize tools exempt.

**P2.2 — Durable prompt-size telemetry**, then a context target. §3.3.

**P2.3 — Tool-schema payload.** Cut duplicated `description` prose (the when-to-use guidance
already lives in `catalog.ts`, fetched once). **Not `seedTypes`** — §4.

### Phase 3 — the learning loop (only after G0.2 and G0.4 are live)

**P3.1 — Shadow mode.** Record what the layer *would* have suppressed for two weeks; publish the
list; graduate to enforcement on the operator's word. Only 36 `wrong` labels exist, and the DB's
CHECK constraint rejected `'wrong'` entirely before 2026-07-27, so historical depth is thinner
than the counts suggest.

**P3.2 — The "15 false positives" rule.** Adopt Codex's specification essentially whole; it is the
most complete statement of this feature anyone has written:
1. Count only **validated** false positives — analyst dismissal for wrong subject, or a
   deterministic contradiction with an auditable reason.
2. Require 15 independent scans, preferably 15 distinct subjects, for the same **contextual** key.
3. **Never** treat `no_record`, timeout, malformed, rate limit or unlabeled output as a false
   positive. *This is the RapidAPI mistake encoded as a rule.*
4. Move the key to `quarantined`, never deleted, and show the reason in the UI.
5. Keep a manual override and a ~5% recovery sample.
6. **Reset or decay** when the endpoint/parser/workflow version changes.
7. Before 15 labels exist, use conservative Wilson intervals and minimum-sample gates.

Why **contextual** and not global: measured at tool grain the rule fires on nothing — the worst
tool-level reject rate in production is `oathnet_lookup` at 17/85, an **80% keep rate**. A source
can be junk for usernames and excellent for domains. It only bites at
`(source_origin × artifact_kind × seed_kind)` and dork-template grain.

Non-negotiables for this layer: sample floor (≥15, mirroring `HEALTH_MIN_SAMPLES = 20`); epsilon
re-probe or suppression becomes permanent blindness; analyst `force` always wins; kill switch
`OPERATIONAL_MEMORY_DISABLED` read at call time; and **the refusal must be legible as a refusal**
in `tool_usage_log` — never `ok:true`, and its text must not match `SKIP_REASON_RE` or `SKIP_RE`,
which is the exact laundering bug #519 fixed.

### Phase 4 — experience

Report card + an explicit **Finalize / Summarize** button; full graph, correlation and timeline
synthesis run **only** there, as an idempotent job tied to a case revision. This is also what
makes tiered context safe to enable — and note it moves work **out** of the finalize window, which
is the right direction, because that window owns this project's worst incidents.

Then: memory modes (default **Smart** — see §9), the Brain "What I've learned" tab, `ReportCardV2`.

### Phase 5 — model routing

The orchestrator slot is **vendor-agnostic and secret-only switchable** (`GLM_API_KEY` +
`DEEPSEEK_BASE_URL` + `DEEPSEEK_ORCHESTRATOR_MODEL_ID`) — no code change, no deploy. Keep GLM-5.2
for the many short tool-routing turns and route **only the finalize/synthesis turn** to a stronger
long-context model. The *split* is a code change (`models.ts` / `orchestrator_select.ts` + a
`FINALIZE_MODEL_ID` env), unlike a wholesale swap. **Benchmark on the G0.3 corpus with identical
replayed tool results** so you are comparing synthesis quality, not luck. Run it after Phase 3 so a
model change is not confounded with the learning layer.

---

## 7 · Ship in SMALL PRs — do not attempt the roadmap in one

**This is not style advice. In this repo a large PR cannot be deployed safely or reverted at all.**

### Why, specifically here

1. **`/health` proves a BUILD, not a change.** The only instrument for what is running in
   production is a build SHA. Ship six changes in one build, and when behaviour regresses you
   cannot bisect — there is nothing finer-grained to look at.
2. **The behavioural-proof-key trick is per-build.** Each deploy should introduce exactly one new
   observable key (`checks.synthesis` → `checks.rejected_cluster_sweep` → `checks.credentials`).
   One key cannot prove six changes landed.
3. **Edge deploys are serialized and manual.** Every edge PR needs its own
   stamp → surgical mirror sync → hard gate → Lovable message → `/health` verify → ledger cycle.
   That is the unit of work. Batching changes does not batch the risk; it concentrates it.
4. **Frontend and edge ship on different channels.** Frontend goes live on merge to `main` via
   Vercel. Edge does **not** ship on merge at all. A PR mixing both cannot be cleanly deployed or
   reverted. **Never mix them.**
5. **Review catches what CI cannot.** Every defect caught in review in this repo was a *timeline or
   identity* error, not a logic error — and every one passed the full suite, typecheck, lint and
   build. Large diffs hide exactly that class.
6. **The merge queue is the bottleneck.** Nine finished, green PRs once sat in draft for three days
   with zero functional commits on `main`. Big PRs sit. Small PRs merge.
7. **Revert granularity.** A 30-file roadmap PR cannot be reverted without losing everything in it.

### The rules

- **One PR = one behaviour change + its tests + its kill switch.**
- **Never mix frontend and edge changes** in one PR.
- **Never mix a schema change with the code that depends on it.** Schema first, applied through
  Lovable, verified against the live DB, *then* the code that reads it. `supabase/migrations/` is
  intent, not mechanism — the live ledger tops out at `20260825024640`.
- **Every edge PR that changes behaviour adds one new `/health` key or durable log event**, so its
  deploy is provable.
- **At most one edge PR in flight**, because the deploy queue is serialized. Frontend PRs can run
  in parallel with it — that is the whole reason the plan has two tracks.
- **Docs and ledger updates ride in their own PR.**
- **Run `npm run test:e2e` by hand** for anything touching `src/` — PR CI skips it
  (`if: github.event_name == 'push'`), so a PR can go green and merge while breaking the tab
  contract. That is a revert, not a block.

### Worked example — G0.2 lineage as six PRs, not one

| PR | Contents | Ships how |
|---|---|---|
| 1 | Migration only: `artifact_tool_lineage` junction, `run_id` + `call_id` on `tool_usage_log`. Nothing reads it yet. | Through Lovable; verify against the live DB |
| 2 | Write path: stamp `call_id` on every call, insert lineage rows. Kill switch. Adds `checks.lineage` to `/health`. | Full edge recipe |
| 3 | Measure coverage (% of artifacts with lineage) and publish it. No behaviour change. | Docs/telemetry |
| 4 | `coverage_observations`: divert checked-and-clear rows at the write path. Kill switch, new health key. | Full edge recipe |
| 5 | Frontend: triage queue excludes coverage observations; a separate view surfaces them. | Vercel; **e2e by hand** |
| 6+ | The learner reads lineage in shadow mode. | Full edge recipe |

Each one is independently revertable, independently provable, and independently useful. PR 1 alone
makes the data model correct even if nothing else ever lands.

---

## 8 · Trap list — instruments that lied, and things that will mislead you

1. **Check whether it is already built before building it.** Five separate times in one session,
   the thing a plan said to build was already built and either disconnected at the call site or
   mislabelled. See CLAUDE.md's **BUILT AND UNWIRED** table. Codex's roadmap proposed "one
   collapsed live run card" — which shipped the same day in #587. **Grep first.**
2. **A 403 is not a dead credential.** Always measure on `outcome` over real attempts
   (`outcome IN ('ok','failed')`), skips and empties excluded from **both** numerator and
   denominator. Counting them is what made `gravatar_profile` read 35% reliable when it was ~100%.
3. **`marker_offset_mismatch` between stamp and deploy is EXPECTED.** The hard-gate condition to
   read at that moment is `mirror tree -> equal`, nothing else. It flips to VERIFIED on its own
   once `/health` moves.
4. **A fresh clone has not fetched `deploy/live`**, which leaves that axis blind and surfaces as a
   false `ledger_ref_divergence`. Fetch it first.
5. **The clone is shallow at depth 50.** Unshallow before trusting any divergence measurement.
6. **CI's "there will be 137 files uploaded" is the coverage artifact count, not the suite's test
   file count.** That error already reached a commit message.
7. **`verify:deploy` reads the mirror's LOCAL HEAD**, not `origin/main` — an unpushed sync commit
   reads green. PR **#574** fixes exactly this and is still open. Until it merges, confirm the
   mirror is actually pushed by hand.
8. **The GitHub MCP connector is not `GITHUB_API_TOKEN`.** §3.1.
9. **Workflow subagents inherit the session model.** A fan-out of Opus agents for mechanical work
   burns tokens fast. Pass `model: 'haiku'` / `effort: 'low'` on mechanical stages and reserve the
   expensive model for a single synthesis step — or just do it inline.

---

## 9 · Codex's planning PR #586 — the cherry-pick ruling

#586 is planning-only (a 572-line roadmap, a 484-line `.tasks/` board, `.cursorrules`, and edits to
`CLAUDE.md`/`AGENTS.md`). No code, no migration, nothing deployed. Its base predates
#581/#587/#588/#589/#590 and it patches `CLAUDE.md` at the Misc section, **which will conflict**.

**Take as-is** — folded into §6 above:
- `artifact_tool_lineage` as a junction table (verified as a real gap, §3.2)
- `coverage_observations` (better than capping artifacts in the UI)
- The "15 false positives" production rule (§6 P3.2)
- The 20-case replay benchmark with frozen tool responses
- Normalized outcome taxonomy; `run_id` / `call_id` / selector-type on `tool_usage_log`

**Take with correction:**
- *"Default Fresh memory"* — **conflicts with the operator's decision.** Default is **Smart**
  (operational statistics + identity rows whose subject exactly matches a seed selector, capped
  ~4K, ranked by hit count and recency). Keep Smart. Take Quick mode and no-auto-dossier.
- *"One bounded server prefetch replaces agent-driven recall"* — right direction, incomplete.
  Recall arrives by **three** paths: the `memory_recall` tool, an auto-recall fan-out on **every**
  `record_artifacts` (up to 12 subjects × 5 rows, `tool-registry.ts:5297`), and a planner hint
  (`:1037`). A prefetch that does not kill all three saves nothing. **And `memory_save` must stay
  callable even in Off mode** — `resolveFinalizePhase` blocks the report phase until `memory_save`
  or `finalize_skip_memory` succeeds, so removing it wedges finalize.
- *"Gate critical e2e on PRs"* — the task itself is sound (path filters, a narrow case-integrity
  slice, full suite still on push). Keep it genuinely narrow: #483 drained the shared Actions
  allowance and took CI down on every PR for ~70 hours.

**Already shipped, do not rebuild:** the collapsed live run card (#587, live).

**Decline:** the `.tasks/` board, `.cursorrules`, and the TaskPlanner block injected into
`CLAUDE.md`. That is a **second source of truth** for what to work on, beside `CLAUDE.md` and the
handoff series — and this repo's own history is the argument against it: every handoff was
overtaken by a later session, which is why `CLAUDE.md` now tells you to distrust their status
tables. Take the 27 tasks as *content*; put the ordering where the plan already lives.

---

## 10 · The open PR queue — nine, oldest from 2026-08-25

A triage was started and deliberately abandoned mid-run (it was fanning out expensive subagents for
what is a cheap set of API calls). **It has not been completed — treat every row below as unverified.**

| PR | Draft | What it is | First read |
|---|---|---|---|
| #586 | yes | Codex roadmap + `.tasks/` board | §9. Conflicts with `CLAUDE.md`. |
| #579 | no | report / print / Tools views tell one truth | Overlaps the report work in §6 P1.3 — resolve before starting it |
| #574 | no | catch an unpushed mirror sync as `mirror_local_not_pushed` | **Merge first.** Closes trap #7, a real hole in the deploy gate |
| #570 | yes | handoff doc | Check whether its content is still true before landing stale prose |
| #567 | yes | audit doc | same |
| #564 | no | handoff doc | same |
| #541 | yes | handoff doc | same |
| #516 | yes | account deletion (#476), split out of #502 | Overlaps #502 — operator call |
| #502 | no | audit remediation + run-wedge fix + #476 | Overlaps #516 — operator call |

**Do this cheaply**: `list_pull_requests`, then `pull_request_read` with `get_check_runs` per PR.
Nine calls. Do not fan out subagents for it.

---

## 11 · Scheduled

A Routine (`trig_01UYacwJhyKVF2STJ5yXytLf`) fires **2026-09-20T17:00Z** to do the A2b measurement
from a week of production data.

⚠️ **It was created without MCP connectors**, so the session it fires may not have
`mcp__Lovable__query_database`. Its prompt is written to detect that and stop rather than invent a
number — but to make it work, attach the Lovable connector from the claude.ai Routines UI, or just
run the task by hand from an interactive session.

---

## 12 · Verification

```bash
npm ci && npm run typecheck && npm run lint && npx vitest run && npm run build
npm run test:edge     # Deno; install first in a web sandbox, pass --no-lock
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e
npx vite --config vite.harness.config.ts   # screenshot the SIGNED-IN workspace, before/after
```

Deno is **not** preinstalled in the web sandbox:
`DENO_INSTALL=/usr/local sh <(curl -fsSL https://deno.land/install.sh) -y`

**Baselines to beat, not merely match:** edge **1832 / 0 / 5**, frontend **2104 / 1 / 172 files**,
e2e **52 / 2 skipped**. PR CI does **not** run e2e.

---

## 13 · Non-negotiables

- `REVEAL_BREACH_DATA` stays **ON**. Settled; the recommendation to flip it was rejected once
  already. Flipping it gives masked-by-default, not click-to-reveal — the release posture is a
  small feature build, not a deploy-day config change.
- `MAX_PAID_CALLS` stays **bounded**. Never `Infinity`.
- **Intent is never inferred from prose.** Structural signals only.
- **Never touch** `toolChoice`, `stopWhen`, the finalize window, or termination logic.
- **Quarantine is disclosure, not deletion.** A change that makes a quarantined row disappear is a
  regression, not a tightening.
- Integrity-critical changes (evidence ranking, confidence caps, chain-of-custody, minor-safety,
  merge semantics) need written sign-off **before** code.
- Every live-behaviour change ships behind a **call-time** kill switch.
- **No real investigated selectors** in code, comments, tests or PR bodies.
