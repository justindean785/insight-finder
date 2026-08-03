# Option B — revision 2: amendments after read-only audit

**Status:** design only, superseding parts of `automatic-slices.md`. No implementation.
PR 1 is **not** started.

This document answers the audit finding by finding. Where a finding is accepted, the
corrected specification is given here and the original section is obsolete. Where the
evidence says something different from *both* prior accounts, that is stated with the
query that shows it.

Two of my own claims were wrong. Both are corrected below, first.

---

## A. My errors

### A1 — #383's primitive is already on `main`. Confirmed; my claim was wrong.

I read the PR *diffs* for #377 and #383 and concluded the reservation primitive was
unlanded and sitting in two competing drafts. I never checked `main`. It is on `main`:

```
$ git log origin/main --oneline -S "export function isToolBudgetExhausted" \
    -- supabase/functions/osint-agent/orchestrator-budget.ts
cb429f8 fix(osint-agent): union orchestration hardening + Jina/circuit fixes (#384)

$ git show origin/main:.../orchestrator-budget.ts | grep -n "^export function reserve\|^export function isTool"
178:export function reserveToolCall(
204:export function isToolBudgetExhausted(

$ git show origin/main:.../cache.ts | grep -n reserveToolCall
17:import { reserveToolCall } from "./orchestrator-budget.ts";
962:  if (ctx.toolCallBudget && !reserveToolCall(ctx.toolCallBudget, ALWAYS_ALLOW_TOOLS.has(name))) {

$ git show origin/main:.../cache_budget_race_test.ts | grep -n "Deno.test"
51:Deno.test("budget race: N concurrent calls at the cap boundary …")
86:Deno.test("budget race: recording tools (ALWAYS_ALLOW) are never capped …")
```

`cb429f8` (#384) landed all three: the primitive, the live `cache.ts` gate, and the
un-quarantining of `cache_budget_race_test.ts` (quarantined by `0378fc5` (#375),
released by `cb429f8`). `main`'s own docstring for `isToolBudgetExhausted` names the
defect: *"the correction to the #377 decoupling: admission caps on `reserved`, so a run
that spent its budget on reserved-but-rejected calls has `genuine < cap` yet must still
be forced to finalize."*

**Parity check — `main` is the strict superset.** `main` has `reserveToolCall`,
`isToolBudgetExhausted`, `toolCapExceeded`, and both race tests live. #377 has
`reserveToolCall` + `toolCapExceeded` and **no** `isToolBudgetExhausted`. #383 adds
`isToolBudgetExhausted` but predates `main`'s version. **Recommend closing both #377 and
#383 as superseded by #384.** Neither should be merged. I am not authorised to close them
and have not.

Correction to rev 1 §1a: the composition story stands unchanged — the in-memory reserve
is the advisory pre-filter, the DB row lock is the authority — but it composes with
**code already in production**, not with a PR to be adopted. That makes PR 1 smaller.

### A2 — the extension conclusion. Retracted; and the replacement is neither hypothesis.

I retract "a `CREATE EXTENSION` has already silently failed on this project." I also have
to retract my follow-up guess that `cron.schedule` raised and rolled the transaction back.
The migration history says something else:

```sql
SELECT count(*) FROM supabase_migrations.schema_migrations;   -- 35
SELECT max(version) FROM supabase_migrations.schema_migrations; -- 20260803041457 (today's probe)
```

`20260720031500` — the pg_cron health-sweep migration — **is not in the recorded history
at all.** The newest recorded version before today's probe is `20260715105649`. Nor are
`20260717000000`, `20260727180000`, or any repo migration dated after 2026-07-15.

But the objects those migrations create **all exist in production**:

| repo migration | object | exists |
|---|---|---|
| `20260628_tool_usage_outcome` | `tool_usage_log.outcome` | yes |
| `20260629_user_credits` | `user_credits`, `debit_user_credits()` | yes |
| `20260709000000_artifacts_cluster_ids` | `artifacts.cluster_id` | yes |
| `20260712000000_client_errors_telemetry_sink` | `client_errors` | yes |
| `20260717000000_analyst_feedback_events` | `analyst_feedback_events` | yes |
| `20260727180000_artifact_reviews_allow_wrong` | `artifact_reviews` | yes |
| **`20260720031500_pg_cron_health_sweep`** | **`cron` schema** | **no** |

**Conclusion the evidence supports:** the repo's `supabase/migrations/` is not the
channel by which production schema changes are applied. Lovable applies equivalent DDL
through its own path (its recorded rows are UUID-named). Repo migration files are
validated by CI against a throwaway `postgres:15` and are otherwise a mirror. The
pg_cron migration therefore never executed anywhere except CI — where
`.github/ci/supabase-platform-shim.sql` stubs `cron.schedule`, so the gap is invisible
by construction. **No permission failure is evidenced**, and the probe proves permission
exists. Migration role is `postgres`, `rolsuper = false`.

**The consequence neither review had, and it is a blocking dependency for PR 1:**

> Writing a migration file into this repo does not create anything in production.
> PR 1's tables, RPCs and RLS must be applied through Lovable — the same ownership wall
> as edge-function deploys. Green CI on a migration proves syntax, not application.

Rev 1 §1e's *"CREATE EXTENSION has already silently failed"* is withdrawn; its
finding that the real scheduler is a GitHub Actions cron stands.

---

## B. Findings, answered

### B1 — reservation replay bypass. **Accepted; real defect.**

Rev 1 ordered: insert → conflict means `allowed:true, replayed:true` → *then* enforce
limits. In plpgsql a normal `RETURN` commits everything already done, so a call that is
inserted and then denied leaves a `reserved` row behind, and its retry finds that row and
is allowed. The cap is bypassed by exactly one retry. Corrected contract:

1. `SELECT … FROM investigation_runs WHERE id = p_run_id FOR UPDATE`.
2. Reject unless run is active; reject unless slice is `running`, lease matches, unexpired.
3. **Look up the existing reservation first.** If a row exists, return **its recorded
   decision** — `allowed` replays allowed, `denied` replays denied. Never re-evaluate.
4. Recording/finalize tools: allow, no counters touched, no row written.
5. Enforce total → paid → per-tool → cost, in that order.
6. **Insert the row carrying the decision** (`decision text NOT NULL CHECK (decision IN
   ('allowed','denied'))`) **and** increment counters, in the same statement sequence,
   before returning.
7. Return `{allowed, reason, replayed, remaining{…}}`.

The decision is persisted precisely so a denied call replays denied. `run_call_reservations`
gains `decision` and `denied_reason`.

### B2 — the same-run report contract. **Accepted; rev 1 under-specified it.**

Add, beyond `artifacts.run_id`:

- `messages.run_id uuid REFERENCES investigation_runs(id)`
- `tool_usage_log.run_id uuid REFERENCES investigation_runs(id)`
- `investigation_runs.report_message_id uuid REFERENCES messages(id)` — a real FK
- `finalize_run` validates, in-transaction, that the referenced message: belongs to the
  same `run_id`, the same `thread_id`, the same `user_id`; has `role='assistant'`; and
  satisfies the report-shape predicate. Any failure raises; nothing is committed.
- `finalize_no_findings` gets a durable representation rather than living only in message
  parts: `investigation_runs.no_findings_reason text CHECK (… IN
  ('all_supported_findings_already_persisted','no_tool_supported_findings'))`, plus the
  invariant from rev 1 §6 — `no_tool_supported_findings` requires zero reportable
  artifacts **for this run_id**; the other requires ≥1. Exactly one of
  `report_message_id` / `no_findings_reason` may be non-null, enforced by a table
  `CHECK`.

### B3 — retry identity. **Accepted; strongest finding in the audit.**

`call_key = slice_id + SDK toolCallId` is unsound: a regenerated model step mints new
tool-call IDs, so the same logical paid action dispatches twice. A deterministic key is
necessary **but not sufficient on its own** — it needs a stable step ordinal, which only
durable step persistence provides. Both:

```
call_key = sha256(
  run_id ‖ slice_seq ‖ step_seq ‖ call_ordinal ‖ tool_name ‖ canonical_json(input)
)
```

`step_seq` and `call_ordinal` come from a `run_steps` row **committed before provider
dispatch**, not from SDK-assigned identity. Including canonicalised input means a
regenerated step that produces a *different* call gets a different key and correctly
dispatches; a regenerated step producing the *same* call collides and replays.

Test, per the audit: regenerate a step so the SDK issues fresh `toolCallId`s, and prove
the same logical paid call is not re-dispatched. Mutation: remove `step_seq` from the key
and the test must fail.

### B4 — the cost ceiling. **Accepted; withdraw the authority claim as it stands.**

`reserve_tool_call` covers provider tools only, and provider tools are 8–27% of run cost.
Rev 1's claim that `max_cost_micro_usd` is "the real limit" is therefore false as
specified. Two honest options; I recommend the first:

**Generalise the ledger.** `run_call_reservations` → `run_cost_ledger` with
`kind text CHECK (kind IN ('tool','model_step'))`, and add
`reserve_model_step` / `settle_model_step`. Model-step cost cannot be known before the
step, so reservation books an **estimate** (prompt chars → tokens → price, plus
`maxOutputTokens` at the output rate) and settlement replaces it with actual usage from
the SDK. The cap is evaluated at the step boundary in `prepareStep`, which is where the
run can still stop cleanly.

Until that lands, `max_cost_micro_usd` must be documented as covering tool spend only.
No claim of an investigation cost ceiling before model-step accounting exists.

### B5 — driver B latency. **Accepted, with the numbers.**

GitHub Actions scheduled workflows run **at most every 5 minutes**, and are delayed under
platform load — our own `edge-health.yml` is `*/15`. Worst-case resume after a lost
worker is therefore:

```
lease_expiry (slice_deadline + grace)  +  up to one cron interval  +  Actions queue delay
```

With a 5-minute schedule and observed Actions jitter, that is a **worst case in the
5–20 minute range**, not seconds. Stated as the SLA. `EdgeRuntime.waitUntil`
self-continuation is the *latency* path and is never the correctness path; the cron is
the liveness backstop only. **Driver B is not equivalent to a seconds-level queue and rev
1 should not have implied it was.** Driver A (pgmq) remains the path to seconds-level
resume.

### B6 — limits. **Accepted, and the data refutes the proposed numbers.**

The audit is right that five maximum observations cannot set a production limit. Here is
the distribution over **226 successful runs** (`status='finished'`, ≥1 artifact, ≥1 tool
call). Thread-scoped, because run identity does not exist yet — so these are *upper*
bounds on true per-run values:

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| total calls | 60 | 185 | 262 | 302 |
| paid calls | 25 | **103** | 134 | 149 |
| cost | $0.13 | $1.31 | $3.05 | $4.02 |

Measured against the proposed caps:

| proposed cap | % of **successful** runs it would clip |
|---|---|
| `max_total_calls = 320` | 0.0% |
| `max_paid_calls = 100` | **6.2%** |
| `max_cost_micro_usd = 4_000_000` | 0.4% |
| **any of the three** | **6.2%** |

`max_paid_calls = 100` sits **below p95 (103)** and would clip 14 of 226 successful runs.
The $4.00 cost cap sits below the observed maximum successful run ($4.019). Two of the
three proposed numbers bind on legitimate work.

Also worth recording: the "$3.05 runaway" that motivated cap enforcement in July is
**exactly p99 of successful runs**. It was not a runaway.

**Recommendation:** ship PR 1 in **shadow mode** — reserve, count, and record the
decision the cap *would* have made, enforce nothing. Then set limits from run-scoped
p99 with headroom once run identity exists. Provisional shadow thresholds for
alerting only, ≈2× p99: 600 total / 300 paid / $8.00. At those, clipping is 0.0% / 0.0% /
0.0% on the current population.

### B7 — run boundary. **Accepted as specified.**

Explicit backend/UI event, never prose. `finished | failed | cancelled | budget_exhausted`
as terminal states, one-way latch enforced by a `CHECK` on the state column plus a
`BEFORE UPDATE` trigger rejecting any transition out of a terminal state — so a
post-terminal `finalize_no_findings` is refused by Postgres. A submission while a run is
active returns **409 `active_run_id`** unless the analyst explicitly stops it; "add
instruction to active run" is a separate action. A submission after terminal creates a new
run with `trigger_message_id` and optional `parent_run_id`.

### B8 — lease and retries. **The two reviews conflict. Flagging rather than picking.**

| | attempts | lease |
|---|---|---|
| review 1 | **2**, because a retried slice re-executes paid calls and re-persists artifacts against a stated 51% duplicate rate | heartbeat-renewed, else a long slice is stolen |
| review 2 (audit) | **3** total, jittered backoff | renewable, provisional expiry slice deadline + 30–60s |

Both agree on heartbeat-renewed leases; that is settled and accepted.

On the attempt count, the duplicate-amplification argument rests on a rate I could not
reproduce. Measuring strict identity on `(thread_id, kind, value)` across all 11,544
artifact rows:

- **10.7%** of rows are duplicates (1,233 rows), not 51%
- 828 duplicate groups, worst group 31 copies, 154 threads affected

The 51% figure may use a different definition (confidence divergence, per-report
duplicates, fuzzy match) and I am not declaring it wrong — only that on strict identity
it is 10.7%, and the retry-count decision should rest on a definition both reviews agree
on.

More important: **there are no slice retries today.** That 10.7% arose with zero retry
mechanism, so retries are not its cause, and artifact idempotency is needed regardless of
the attempt count. **Recommendation:** hold at **2 attempts** until B3's logical-call
dedup and artifact idempotency are proven by test, then revisit 3 with jitter. Retry gated
on `finish_reason` — absent/null (true kill) retries; `finish_reason='error'` transitions
the run to `failed` — which both reviews agree on and which makes `finish_reason`
instrumentation a hard PR 1 prerequisite.

---

## D. Integration map findings (added after an 8-surface read of `main`)

A parallel read of the actual integration surface produced three corrections and one
live defect. Each was re-verified by hand before being written here.

### D1 — a correction to A1: `toolCapExceeded` is **not** on `main`

A1 said `main` has "`reserveToolCall`, `isToolBudgetExhausted`, `toolCapExceeded`". Wrong
on the third:

```
$ git show origin/main:.../orchestrator-budget.ts | grep -n toolCapExceeded
  (no output)
```

`toolCapExceeded` and `type ToolCallBudget` are **#377's** symbols and exist nowhere on
`main`. The parity conclusion is unchanged — `main` is still the strict superset of what
matters, and both PRs should still close — but #377 is further from `main` than A1
implied: its `capped`-only-on-rejection semantics *regress* against `main`, and its test
directly contradicts `main`'s (`tool_budget_reserve_test.ts:24` asserts `capped === true`
on the call that fills the cap; #377 asserts `false`).

### D2 — LIVE DEFECT: a second tool wrapper with no admission gates at all

`cache.ts:690` takes a completely separate path for `NO_CACHE_TOOLS`:

```ts
if (NO_CACHE_TOOLS.has(name) || typeof t?.execute !== "function") {
  … execute: async (input, opts) => {   // timeout + heartbeat + tier tag + usage log
```

That wrapper has **no budget reservation, no circuit breaker, no `startCall`, and no
finalize-window guard**. Membership (`validation.ts:157`) is `triage_seed`,
`record_artifact`, `record_artifacts`, `record_evidence`,
`hibp_pwned_passwords_kanon`, `unknown_tool_ignored`.

Three are `ALWAYS_ALLOW` and exempt by design. Two cost 0. **`triage_seed` costs
800 µUSD (`costs.ts:43`) and is NOT in `ALWAYS_ALLOW_TOOLS` (`runtime-policy.ts:237`).**
It is a paid tool with zero admission control, today, on `main`, deployed.

Realized exposure is small — 104 calls across 73 threads, $0.076 lifetime — so this is a
correctness hole rather than a cost emergency. But it defeats the premise of PR 1: "the
DB row lock is the only authority" is false while a paid tool reaches the provider
without ever asking. **PR 1 must either route this wrapper through `reserve_tool_call`
or ship a test pinning "every `NO_CACHE_TOOLS` member is cost 0 or `ALWAYS_ALLOW`".**
Preference: route it, and add the test as the backstop.

### D3 — a `CHECK` cannot enforce the one-way latch

B7 and both prior reviews say "`CHECK`-enforced one-way latch". A `CHECK` constraint is
row-local and cannot see `OLD`, so it can pin the *value domain* of the state column and
nothing more. The transition guard needs a `BEFORE UPDATE` trigger — precedent already in
this schema at `20260717000000_analyst_feedback_events.sql:71` — or a `WHERE`-guarded
`UPDATE` inside the RPC, precedent `withRunMarkerGuard` (`recovery.ts:489`). B7's
specification already named the trigger; this records *why* the `CHECK` alone is
insufficient so it is not "simplified" back later.

### D4 — #381 is not overlapping work; it is a deliberate deletion

Rev 1 §1d listed #381 (deterministic finalize gate) as overlapping PR 3. It landed in
`cb429f8` and was then **deliberately removed** by `e8313e5`, with a tombstone at
`orchestrator-finalize.ts:200` and the rationale at `index.ts:852`. CLAUDE.md's
termination-oscillation section forbids relitigating it. **#381 should be closed, not
scheduled.**

### D5 — serialize on a row lock, not an advisory lock

Two incompatible advisory-lock namespaces already hash the same `thread_id`:
`hashtextextended(_thread_id::text, 0)` (`20260717000000_analyst_feedback_events.sql:169`)
and `hashtext(_thread_id::text)` (an unmerged security migration). A third would be a
silent no-op against both. `SELECT … FROM investigation_runs WHERE id = ? FOR UPDATE`
sidesteps the collision entirely and is what B1's corrected contract already specifies.

### D6 — migration mechanics

- **14-digit timestamp filename.** The repo mixes 8- and 14-digit forms
  (`20260629_user_credits.sql`), which is exactly the ordering hazard `ci.yml`'s sort
  comment calls out. Highest existing prefix is `20260727180000`.
- **`artifacts.run_id` must be nullable with no NOT NULL.** Precedent
  `20260709000000_artifacts_cluster_ids.sql`; the reason is recorded in code at
  `lib/cluster.ts:416`, where a silently-dropped column previously produced a `23502` that
  broke every `cluster_decision` insert in production.
- Order within the file follows the project idiom: grants → `ENABLE ROW LEVEL SECURITY` →
  policies → indexes → triggers.

### D7 — sequencing: ship `finish_reason` alone, first

`finishReason` is already on the SDK's `onStepFinish` event (`ai@6` emits one per step);
`index.ts:1037` reads it and `index.ts:1049` writes it **only** behind
`if (finalizeStarted)`. An ordinary investigate step ending `finishReason:"stop"` leaves
**zero** trace anywhere. Widening that destructure and logging unconditionally is
log-only, test-neutral, and touches no admission logic.

Because `finish_reason` is now the retry predicate (B8), it should ship and run **alone**
for long enough to establish a pre-change baseline, before the reservation work changes
admission behaviour. Splitting it out also means the riskiest part of PR 1 is not gated
on it.

---

## C. Consolidated open blockers

1. **PR 1's schema cannot reach production through this repo** (A2). Needs a decision on
   how Lovable applies it, and that gates PR 1's usefulness even if the code is perfect.
2. **`pg_net` is unprobed.** Driver A needs it; `pgmq` alone is not enough.
3. **Model-step cost accounting** (B4) — required before any cost-ceiling claim.
4. **Headless-worker ceiling** — still unmeasured; gates `max_slices` and lease duration.
5. **Retry attempt count** (B8) — blocked on an agreed duplicate-rate definition.
6. **#377 / #383 / #381** — recommend closing all three: #377 and #383 superseded by
   #384, #381 deliberately deleted by `e8313e5` (D4). Not authorised, not done.
7. **`NO_CACHE_TOOLS` admission gap** (D2) — a paid tool bypasses every cap on `main`
   today. Must be closed inside PR 1 or PR 1's authority claim is false.

No implementation. #408 stays draft pending review of this revision.
