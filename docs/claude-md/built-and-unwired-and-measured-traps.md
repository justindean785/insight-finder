# Built-and-unwired audit, instrument truth, and measured traps (moved out of CLAUDE.md)

Read before implementing anything from a plan or audit: grep for it first.

## ⛔ BUILT AND UNWIRED — check before you build (2026-09-12)

Five separate times in one session, the thing a plan said to build turned out to be
already built and either disconnected at the call site or mislabelled. The work in this
repo is not missing; its **instruments and labels** have been reporting something else, so
each session diagnosed from bad readings and built beside the thing that already worked.
That is the real answer to "we do all these upgrades and it never changes the app."

**Before implementing anything from a plan or audit, grep for it first.** Verified cases:

| Thing | Status on `main` |
|---|---|
| `toolAgentRole()` / `toolActionLabel()` (`src/lib/tool-display.ts`) | exported, unit-tested, **zero component consumers** until #587 |
| `tool_health` view → `scoreExpectedValue` reliability prior | fully wired and loaded per run — but `runtime-policy.ts:373` states EV is **advisory and never blocks a call**, so nothing is ever suppressed by it |
| `shouldAllowToolCall` (`runtime-policy.ts:556`) | complete, tested, **unreferenced**. Has `QUERY_FAMILY_NO_YIELD_LIMIT = 3` → `action:"suppress"` — i.e. most of the "stop calling what never yields" feature |
| `tool-routing-policy.ts` | **100% dead code**; `RouteContext` already carries `highYieldTools`, `failedQueryFamilies`, `duplicateQueryKeys` |
| `circuit.applyBaselineDisables(threadId)` (`circuit.ts:634`) | an **explicitly empty hook**, already called once per thread, kept for a persisted skip list |
| `capabilities.seedTypes` | the gate is **fully enforced** at `capabilities.ts:184` — and no tool declares it, AND `index.ts:441` passes `null` as the seed type, so it can never fire ⚠️ |
| Evidence board "Leads drawer" | **already shipped** (#543). Default filter is `analyst`, hiding weak/quarantined/excluded, with Leads and Excluded chips. `STATUS_FILTER_GROUPS` warns that a kind-based filter beside the authority states would be "a second, drifting source of truth" — do not add one |
| **finding synthesis** (`finding-synthesis.ts`, `finding-synthesis-sweep.ts`, `lib/finding-row.ts`) | **complete, deployed, and switched OFF** behind `FINDING_SYNTHESIS_ENABLED` / `_BACKFILL_ENABLED` / `_DRY_RUN`. Runs in the HEALTH SWEEP — a separate request — so it is structurally incapable of failing finalize. Its header measures the gap it closes: **9,615 artifacts / 181 threads / 13 `kind='finding'` rows in the product's lifetime**, because `workflow_prompt.ts:34` makes `record_finding` advisory and the model almost never calls it (the `@wopdell` run: 87 tool calls, **zero**). ⚠️ Prerequisite before any flag flips: confirm migration `20260907000000` (`artifacts_synthesis_cluster_uniq`) is applied **against the live DB** — the sweep is an unlocked read-then-write fired every 60s |
| `useDensity` (`src/hooks/useDensity.ts`) | complete, persists to `localStorage`, applies `<html data-density>`, and has **ZERO consumers** — no control anywhere sets it. Worse, its CSS is not inert while dark: `[data-density-row]` sets symmetric `padding: … !important` UNLAYERED, so it beat `.ledger-row`'s own rule and pulled the evidence ledger's left inset from 1rem to 0.75rem while the column head and group rule stayed at 1rem. Fixed in #617 by giving the ledger back its horizontal inset; density still owns the vertical rhythm. Wiring a control is still unbuilt, and it is a global preference, so decide WHERE it lives (command palette is the cheap answer) before building one |
| `SweepSite.confirm` | the documented lever for a platform whose not-found page echoes the handle — **and unreachable until #594**, since no site configured it. Populating it honestly needs a KNOWN-REAL profile per platform, which is why #594 encodes the measured NEGATIVE (`echoUnsafe`) instead |

### ⚠️ Do NOT populate `seedTypes` to shrink the tool-schema payload

It looks like the obvious fix for the ~95–105k chars of tool schemas re-serialized every
step. It is the wrong mechanism: OSINT pivots **derive** new selector types mid-run — an
email seed yields a domain, a username, a phone. Gating `crtsh_subdomains` off because the
SEED was not a domain breaks the run's ability to follow the domain it just discovered.
The real duplication is that `catalog.ts` exists to hold when-to-use guidance and is
fetched once, while each tool's `description` still carries paragraphs of the same prose
on every step. Cut there instead — and only after `prompt_size_step` reports the real
number, not an estimate.

### Instruments that were lying — #587 shipped in `c87c07b` 2026-09-13

**Read the per-item status, not the heading.** #587 made all four *legible*; it repaired
exactly one of them. Two now have an honest meter beside the broken reading, and the
defect they measure is still there — which is the point, because the number that sets the
cap has to come from production, not from an estimate.

- **`approxPromptChars` — MEASURED, not fixed, deliberately.** It still omits the workflow
  addendum, `analystDecisionsBlock` (0 → ~30k), the per-step directives and **every tool
  schema**, so the ~175k average `initial_context_chars` in telemetry is still a floor.
  `approxPromptChars` was left alone because it *routes providers*; changing it changes
  behaviour. The honest meter is separate: `prompt-size.ts` → `prompt_size_initial` and
  `prompt_size_step`, the latter logged from each of the three `prepareStep` return
  branches so a nudge step reports the tool set it actually ships. It names
  `tool_input_schemas_serialized` as unmeasured rather than estimating it — zod@3 has no
  JSON-Schema export, so those bytes cannot be counted from inside the function.
- **The run caps are per ISOLATE, not per investigation — STILL TRUE, now measured.**
  `index.ts:331` calls `clearRuntime(threadId)` on every request and that is
  `THREADS.delete(threadId)`, while `runtime-policy.ts:296-299` claims only "a brand-new
  investigation" clears them. An investigation is 2–12 invocations, so `MAX_PAID_CALLS = 12`
  is really **24–144 per case**. Production: 130 calls/12 invocations, 112/9, 102/6. This
  also explains 74 `minimax_correlate` calls against a documented cap of 2. #587 adds
  `run_budget_prior`, which classifies prior `tool_usage_log` rows into what actually
  consumed a paid slot (cached replays and `outcome === "skipped"` consumed nothing; failed
  and empty paid calls did), with the paid predicate **injected, not imported**, so it
  cannot drift from the admission gate. **A2b — enforcing the per-investigation cap — is
  deliberately NOT done and is blocked on a week of this data.** `MAX_PAID_CALLS` is a
  settled operator decision; setting the replacement number from an estimate is the error
  that condemned a healthy provider.
- **`/health`'s tools line is STILL a PRESENCE test** (`has(env.X_API_KEY)`) and #587 did
  not touch it. What it adds is **`checks.credentials`** beside it, which reads `outcome`
  and `status_code` over a rolling 7 days and so can tell a dead key from a working one and
  can confirm a rotation. It earned its keep on the first probe: it caught that
  `github_code_search` is still 401 (see the dated state above). Read the two together —
  the tools line says a secret is *set*, `checks.credentials` says whether it *works*.
- **The cache sweep could not have drained a row — FIXED and deployed.** It handed all
  5,000 identified ids to one `DELETE`, and PostgREST renders `.in()` into the URL query
  string: a ~185 KB URL against a ~24 KB gateway cap. It now chunks at
  `CACHE_SWEEP_DELETE_CHUNK = 300` and a chunk fault returns, so `deleted` reports only what
  was actually removed. ⚠️ **`CACHE_SWEEP_ENABLED` is still OFF** — the chunking landed
  first so that flipping the switch is a separate, reversible decision. ⚠️ **And it must be sequenced AFTER the payload store, never before:** measured 2026-09-19, `tool_call_cache` is the largest table at 47 MB / 12,701 rows back to 2026-06-25 with only 129 unexpired, so it is currently the only — accidental — copy of historical tool outputs. Draining it destroys them. Before tuning TTLs,
  measure **key-miss vs expiry**: L2 is keyed on full-param `input_hash`, which may be the
  real reason for the 1.6% hit rate.

### ⚠️ Where each number DURABLY lives — measured 2026-09-13, before planning any week-long read

A meter nobody can read a week later is not a meter. Checked against the live DB:

| Store | Retention as measured | Holds |
|---|---|---|
| `tool_usage_log` | **15,136 rows back to 2026-06-08** — three months | every tool call: `outcome`, `status_code`, `cached`, cost. **Durable.** |
| `evidence_log` / `artifacts` / `threads` | back to 2026-06-08 / 07-05 / 07-05 | case data. Durable. |
| `orchestrator_invocations` / `orchestrator_step_metrics` | **only 2026-09-11 onward** (58 / 350 rows) | per-invocation and per-step timing + context |
| `prompt_size_initial` / `prompt_size_step` / `run_budget_prior` | **nothing — `console.log` only** | the honest prompt terms and prior spend |

**The two-day floor on the orchestrator tables is NOT a purge — do not report it as one.**
There is no `pg_cron`, no trigger on either table, and every other table holds months. They
are a two-day-old feature: `supabase/migrations/20260908000000_orchestrator_telemetry.sql`
from #560, applied live around 2026-09-11. They accumulate normally from here. (Note the
live migration ledger tops out at `20260825024640` and does **not** list it — more evidence
for the rule above that `supabase/migrations/` is intent, not mechanism.)

**The real gap is narrower and worse: the durable table records the WRONG number.**
`orchestrator_invocations.initial_context_chars` and `orchestrator_step_metrics.context_chars`
are fed by `approxPromptChars` (`telemetry.ts:175,223`) — the meter that omits the workflow
addendum, the analyst-decisions block, the per-step directives and every tool schema. The
honest measurement from #587 goes to `console.log` and therefore only to Supabase edge-function
logs, which are short-lived and awkward to query. So a week from now the durable store will
still hold the floor, and the accurate figure may be gone.

Consequences for the ordered plan, so nobody mis-sequences it:

- **A2b (per-investigation budget) is SAFE.** `run_budget_prior` classifies rows it reads from
  `tool_usage_log`, which retains three months, so the week of evidence will be there even
  though the log line is not. The plan stands.
- **The context-size target is NOT safe to set from telemetry yet.** Before using
  `prompt_size_step` for a threshold, give it a durable home — add the term breakdown to
  `orchestrator_step_metrics` (a schema change, so **through Lovable and verified against the
  live DB**, per the rule above), or persist it beside the existing row. Do **not** "fix"
  `approxPromptChars` to close the gap: it routes providers, and changing it changes behaviour.
  That is exactly why #587 left it alone.

### ⚠️ OPEN mirror PR #41 — Lovable-authored, un-backported (as of 2026-09-13T00:55Z)

`seeker-spark-search-5362c57c#41` — *"silence ai sdk warning spam and treat memory_save dedup as
benign"* — is **open and not a draft**, and touches two real runtime files: `index.ts` (sets
`AI_SDK_LOG_WARNINGS = false` on `globalThis`) and `tool-registry.ts` (a `memory_save` dedup
collision returns `{ok:true, deduped:true}` rather than `{ok:false}`).

The content looks correct — the second is arguably a finalize-wedge fix, since
`resolveFinalizePhase` blocks the report phase until `memory_save` or `finalize_skip_memory`
succeeds, and a collision is a genuine no-op rather than a laundered refusal. **The hazard is the
channel, not the content:** it is authored where this repo cannot see it and **it does not touch
`build-info.ts`**, so merging it on the mirror means the next deploy ships it while `/health`
reports the SHA we stamped. That is the 2026-08-29 incident exactly.

**Do not merge it on the mirror. Backport both hunks here** and let them flow through the normal
pipeline; then close #41 as superseded. `diff -rq` is empty today only because #41 is unmerged —
re-check it as part of the hard gate, and check `git log origin/main` in the mirror clone, not
just `diff -rq`.

### ⛔ There is NO call-to-artifact lineage — it blocks the whole learning layer

**Measured 2026-09-13 against the live DB.** `artifacts` columns are exactly
`id, thread_id, user_id, kind, value, confidence, source, metadata, created_at, cluster_id,
subject_id`. **There is no join key to `tool_usage_log`.** The closest thing is `metadata.tool`,
present on **714 of 1,868** recent artifacts — **38%**, and only on auto-persisted rows
(`auto_persist_source` and `via` carry the identical count; anything from `record_finding` /
`record_artifacts` has nothing). It stores a tool **name**, not a call id, so it cannot say which
of 74 `minimax_correlate` calls produced a row and cannot be joined at all.

**Consequence:** you can measure how often a tool returned HTTP 200, and how many artifacts exist —
but not *how often a source produced something an analyst kept*. Operational memory, per-dork
yield, EV ordering and the operator's "15 false positives" ask are **all blocked on this**. It is a
prerequisite, not a nice-to-have, and it comes before any learning code.

Fix shape: an `artifact_tool_lineage` **junction table**, plus `run_id` and a stable `call_id` on
`tool_usage_log`, carrying selector **type** rather than raw selector value for cross-case
analytics (privacy-correct, and it also fixes rejection keys being per-thread only).
**Never an array of artifact ids on the call row** — that re-creates the exact failure that broke
the cache sweep: PostgREST renders `.in()` into the URL query string, ~5,000 uuids is a ~185 KB URL
against a ~24 KB cap. Schema first, through Lovable, verified against the live DB; then the write
path behind a kill switch with a new `/health` key. Full detail:
`mem://architecture/artifact-tool-lineage-gap`.

### ⛔ Memory IS learning — the RETRIEVAL is what is broken (measured 2026-09-14)

Do not rebuild the memory layer, and do not accept "it never learns" at face value. Measured against
the live DB: **1,395 `agent_memory` rows back to 2026-05-27, 517 of them `kind='lesson'`, 246 of
those about tool reliability.** It captures exactly the right things —

> *"rapidapi_breach_search returned 0 hits for this email while breach_check (leakcheck) returned 21"*
> *"Instagram profile could not be scraped (HTTP 451 block + SocialFetch not_found)"*

— and then buries them. **`memory_recall` matches on `subject` only** (`tool-registry.ts:5707`,
`.or(agentMemoryOrFilter(subj))`), so a lesson about a TOOL is filed under the SELECTOR it was
learned on (`<case-email>`, `baig_azhar`). **101 tool-reliability lessons are filed
under a case-specific subject and can never surface again.**

Fix shape: a second recall axis — key tool lessons by tool name (`tool:rapidapi_breach_search`) and
recall that set every run regardless of seed.

**Do NOT conflate this with a broken detector.** A tool that is wrong by construction is a code
defect and must be fixed in code; memory carries genuinely case-specific knowledge. Conflating them
is why this has felt broken from both ends. Worked example: 12 lessons about HackerRank existed in
memory while `sweeper.ts` had **no suppression input at all** (the platform list is a hardcoded
array) and rejection keys were per-thread — so the lesson was recorded twelve times with no lever to
act on it even once.

### ✅ `lib/*_test.ts` now runs in CI — CLOSED by #597 (2026-09-14)

Kept because the *shape* recurs. `test:edge` was `deno test … *_test.ts`, a shell glob matching the
osint-agent **top level only**, so five test files had never been executed by CI or by the
documented local command — `lib/cluster_test.ts` (the C-1 suite guarding against false identity
merges), `lib/memory_save_test.ts`, `lib/memory_supersession_test.ts`, `tools/serus_core_test.ts`
and `evidence-export/text-sanitize_test.ts`. All 34 passed on first run, so nothing was being
hidden — but nothing was being *checked* either. The script now passes directories so Deno
discovers recursively. **Baseline 1845 → 1879: the number moved because coverage moved, not
because tests were added.** When a suite total jumps, check the runner before crediting the code.

### ⛔ `promoteConfidence`'s corroboration branch is a mathematical no-op

`lib/cluster.ts` advertises confidence promotion from cluster corroboration. The expression is
`conf = Math.max(conf, Math.min(TIERS.LIKELY, member.confidence))`, and
`Math.max(c, Math.min(75, c)) === c` for every `c`. It is an identity function. The branch can only
ever CAP (contradicted → 40) or jump to 90 on a verified self-admission — confirmed across 64
production rows, not one promoted upward. Either the expression is wrong or the comment is.
**Evidence-ranking, so it needs explicit sign-off — do not "fix" it as a drive-by.**

### ⛔ Report readiness punishes collection

`confidence-dimensions.ts:196-201`: `readiness = reportSafe / TOTAL artifacts`, where report-safe
means label ∈ `{CONFIRMED, ATTESTED, CORRELATED}`. The denominator includes `weak_lead`,
`excluded_collision`, avatar placeholders and the engine's own notes — rows that can never be
report-safe. **A more thorough run scores worse.** Measured: 7/64 = 11% on `@wopdell`, 2% on a
120-artifact person case.

