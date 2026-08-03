# Option B — automatic bounded slices

> **⚠️ SUPERSEDED IN PART — read [`automatic-slices-rev2.md`](./automatic-slices-rev2.md) first.**
> A read-only audit found material defects in this document, and two of its factual
> claims were wrong. Obsolete here: §1a (the #383 primitive is already on `main` via
> #384), §1e (the extension conclusion), §3's reservation ordering (a denied call could
> replay as allowed), §5's driver-B latency, and §10's limits. Rev 2 carries the
> corrected specification.

**Status:** design only. No code. Returned for review before implementation, per instruction.

**Goal:** the analyst submits one seed and receives one completed investigation, without typing
*Go* or *Continue*.

---

## 0. Verification of the stated corrections

Each correction was checked against the code and against production before being accepted.

| # | Correction | Verdict |
|---|---|---|
| 1 | 180s is an observed heartbeat maximum, not a proven platform wall-clock limit | **Partly upheld — amended below** |
| 2 | 90–135s is the modal death window, not a ceiling | **Upheld, verbatim in the code** |
| 3 | `run_death_forensics` cannot distinguish platform kill from model termination | **Upheld — my error** |
| 4 | A thread may contain multiple investigations | **Upheld, and stronger than stated** |
| 5 | Fire-and-forget accounting permits concurrent overspend | **Upheld** |
| 6 | Slicing does not replace the transport/termination fixes | **Upheld** |

### 1 — the 180s figure, amended

The measurement is stronger than "observed heartbeat maximum". `orchestrator-budget.ts:229–246`
records: p99 178s, max 180.0s, **zero runs ≥ 200s**, measured as `last_heartbeat_at −
run_started_at` per generation, with max rows inspected individually, and — decisively —
reproduced under a **prior 240s budget** where our own `StopCondition` could not have truncated
it (0/58 runs exceeded 180.5s). A 7-generation thread aged 1708s still measured 165s for its
latest run, so thread age does not leak in. The code already states the granularity caveat: the
heartbeat pulses every ~15s, so the true ceiling lies in **[180, 195)**.

So the *number* is sound. What is **not** established — and where the correction lands — is the
**attribution**. The code asserts "the platform terminates the isolate at ~180s". Given Supabase
documents 400s worker duration on paid plans plus a separate 150s request-idle timeout, a 180s
empirical ceiling is not self-evidently the wall-clock limit. Candidate explanations that the
current telemetry cannot separate: CPU-time rather than wall-clock exhaustion; the idle timeout
interacting with a streaming response; a plan-tier limit; or a client-side disconnect.

**This matters for the design, not just for accuracy.** Every 180s measurement to date was taken
on an invocation holding an **open SSE stream to a browser**. A queue-driven worker with no client
attached is a different invocation shape and may not hit the same limit. §7 therefore makes
"measure the real ceiling for a headless worker" a **prerequisite** of PR 2 rather than an
assumption inside it. `SLICE_DEADLINE_MS` is configurable and starts conservative precisely
because the number is not yet known for that shape.

### 3 — my error, stated plainly

`run_death_forensics` (`recovery.ts:555–570`) logs exactly: `thread_id`, `reason`,
`run_started_at`, `last_heartbeat_at`, `run_elapsed_ms`, `silent_ms`, `artifact_count`,
`had_run_marker`, `terminal_writer`. There is no shutdown reason, no `beforeunload`, no
`WallClockTime` / `CPUTime` / `EarlyDrop`. Worse, the comment at `recovery.ts:560` instructs the
reader to *infer* the cause by comparing `run_elapsed_ms` against 180s — which is precisely the
unsound inference. I have repeatedly said this event "would settle" whether runs are killed or
self-terminate. It cannot. §6 fixes the telemetry and the comment.

### 4 — thread ≠ investigation, confirmed

I asserted the opposite in `docs/design/thread-run-budget.md` ("a thread *is* an investigation").
Production refutes it:

| threads with messages | 1 user message | 2–4 | ≥5 | max |
|---|---|---|---|---|
| 269 | 87 | 97 | 84 | **29** |

Two thirds of threads carry more than one prompt, and 84 carry five or more. Scoping a budget to
`thread_id` would charge an analyst's follow-up question to the previous investigation's ledger,
and would let a genuinely new seed inherit an exhausted budget. `investigation_run_id` is
required.

---

## 1. Conflict inventory (checked before designing)

This is the part that most changes the plan.

### 1a. An atomic reservation already exists — twice, in-memory, with a rollback history

| PR | State | What it does |
|---|---|---|
| **#377** | draft, `26595b2`… (`cursor/critical-bug-management-5363`) | Adds `ToolCallBudget {genuine, reserved, capped}`, `reserveToolCall()`, `toolCapExceeded()`; routes `shouldSkipForToolCap` through the shared rule |
| **#383** | draft (`fix/atomic-budget-early-finalize`) | Same primitive, **plus** `isToolBudgetExhausted()` — fixes a decoupling #377 leaves open, where admission caps on `reserved` but finalize triggers on `genuine`, so a run that spends its budget on reserved-but-rejected calls loops forever on rejected admissions |

History: landed in #369 → rolled back by #370 → tracked as issue #373 → re-landed twice as
competing drafts. `cache_budget_race_test.ts` is currently **quarantined** (`Deno.test.ignore`)
waiting for it.

These solve a **real and different** race from the one in this design: parallel tool calls
dispatched by a *single* model step (`Promise.all` fan-out) all reading the same pre-increment
counter. A live run fanned out to 74 calls against a cap of 36. Their solution — a synchronous,
`await`-free check-and-increment — is correct **for that race**, because JS single-threading makes
it indivisible.

**It is not sufficient for slices**, because it is a per-request closure object. Two concurrent
slices are two isolates; neither sees the other's counter.

**Resolution — the two layers compose, and both are needed:**

```
slice N (isolate A)                     slice N+1 (isolate B)
  ├── reserveToolCall()  ← in-memory,     ├── reserveToolCall()  ← in-memory,
  │   guards intra-step fan-out           │   guards intra-step fan-out
  └── reserve_tool_call() RPC  ─────┐     └── reserve_tool_call() RPC  ─────┐
                                    ▼                                       ▼
                          ┌──────────────────────────────┐
                          │ investigation_runs (row lock)│  ← the only authority
                          └──────────────────────────────┘
```

The in-memory reserve becomes a **cheap local pre-filter** that avoids a round trip for calls
that are obviously over budget; the DB reservation is the **authority**. Recommendation:
**adopt #383's primitive** (it is the strict superset — it has `isToolBudgetExhausted`) and close
#377 as superseded, rather than writing a third implementation. This design depends on #383's
shape, so PR 1 should either land on top of it or vendor `reserveToolCall`/`isToolBudgetExhausted`
with attribution.

### 1b. Three budget systems currently exist and do not know about each other

| system | scope | durable | authority over |
|---|---|---|---|
| `orchestrator-budget.ts` `MAX_TOOL_CALLS_PER_RUN = 36` | per HTTP request, in-memory | no | live tool executions |
| `runtime-policy.ts` `MAX_TOTAL/PAID/SAME_TOOL` | per HTTP request, in-memory | no (#407 makes it thread-durable) | admission by cost tier |
| `debit_user_credits` / `increment_thread_cost` | per user / per thread | yes | money, advisory mid-run |

Three caps, three scopes, none authoritative. PR 1 collapses them onto one row and one RPC.

### 1c. #407 (mine) — supersede, do not merge

The mechanism is thread-scoped and fire-and-forget: both wrong per this verdict. **Recommendation:
close #407 unmerged.** Its migration, RLS shape (service-role-only writes on a spend table, with
the tenant-write hole proven closed), monotonic-merge helper, and fail-open hydration are all
directly reusable in PR 1's schema — but as ingredients, not as a shipped design. The
continuation prompt block (`buildBudgetStatusBlock`) survives essentially unchanged and moves to
run scope.

### 1d. Other open work that touches this surface

- **#381** — deterministic finalize gate at ~80% tool budget. Overlaps PR 3's finalization slice.
- **#331** — env-configurable wall-clock / tool-cap / finalize-reserve. Directly useful to PR 2
  (`SLICE_DEADLINE_MS` wants exactly this); check for collision before adding new env knobs.
- **#401** — held; unrelated (gemini_vision circuit), no conflict.
- **#389** — tool yield measurement; no conflict, complementary.
- **#402 / #404 / #405** — integrity designs; no conflict.

### 1e. The scheduler you think you have, you do not

`supabase/migrations/20260720031500_pg_cron_health_sweep.sql` schedules the health sweep on
pg_cron. **pg_cron is not installed on the production database.** Verified:

```
pg_extension          → pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp
to_regnamespace('cron')  → false
to_regnamespace('pgmq')  → false
to_regnamespace('net')   → false
```

`pgmq` is **available (1.5.1) but not installed**; so are `pg_cron` and `pg_net`.

The sweep nevertheless runs — 42 threads carry `recovery_reason = 'stale heartbeat recovered by
health sweep'`, most recent today. The actual scheduler is **`.github/workflows/edge-health.yml`,
a GitHub Actions cron every 15 minutes** hitting `?health=1`, which runs the sweep as a side
effect. So the production scheduler today is GitHub Actions, not the database.

**Consequence for PR 2:** the queue design requires `CREATE EXTENSION pgmq`. On a Lovable-owned
Supabase project this may hit the same ownership wall as `supabase functions deploy` — and the
pg_cron migration is direct evidence that a `CREATE EXTENSION` in a migration has already silently
failed to take effect here. **This is the single largest risk to the plan and must be settled
before PR 2 is written.** §5 specifies the queue behind an interface with a fallback driver that
needs no extension.

---

## 2. Schema

### `investigation_runs` — durable investigation identity

```sql
CREATE TABLE public.investigation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  seq              integer NOT NULL,          -- 1,2,3… within the thread
  status           text NOT NULL DEFAULT 'active',
      -- active | completed | cancelled | failed
  terminal_reason  text,
  -- identity / idempotency ---------------------------------------------------
  start_key        text NOT NULL,             -- client-supplied; dedups double-submit
  seed_fingerprint text,                      -- hash of the seed, NOT the seed (PII)
  -- budget (single authority; see §3) ---------------------------------------
  total_calls      integer NOT NULL DEFAULT 0,
  paid_calls       integer NOT NULL DEFAULT 0,
  tool_counts      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  cost_micro_usd   bigint  NOT NULL DEFAULT 0,
  max_total_calls  integer NOT NULL,
  max_paid_calls   integer NOT NULL,
  max_same_tool    integer NOT NULL,
  max_cost_micro_usd bigint NOT NULL,
  -- terminal report contract (see §6) ---------------------------------------
  report_message_id uuid,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON public.investigation_runs (thread_id, seq);
CREATE UNIQUE INDEX ON public.investigation_runs (thread_id, start_key);   -- double-submit
CREATE UNIQUE INDEX ON public.investigation_runs (thread_id)
  WHERE status = 'active';                    -- at most ONE active run per thread
```

Limits are **snapshotted onto the row at creation**, not read from constants at admission time.
A deploy that changes a default must not retroactively move a live investigation's ceiling.

### `run_slices` — the state machine

```sql
CREATE TABLE public.run_slices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES public.investigation_runs(id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
      -- pending | running | completed | retryable_failed | terminal_failed | cancelled
  kind            text NOT NULL DEFAULT 'investigate',   -- investigate | finalize
  checkpoint      jsonb,                 -- cursor: last committed step/message state
  lease_token     uuid,
  lease_expires_at timestamptz,
  attempt         integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,         -- run_id:seq:attempt
  terminal_reason text,
  finish_reason   text,                  -- SDK finishReason for the last step
  shutdown_reason text,                  -- beforeunload, when the platform emits it
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON public.run_slices (run_id, seq);
CREATE UNIQUE INDEX ON public.run_slices (run_id)
  WHERE status = 'running';              -- one active slice per run, enforced by the DB
```

The two partial unique indexes are the load-bearing constraints: **one active run per thread**,
**one running slice per run**. Both are database invariants, not application conventions, so no
worker can violate them by racing.

### `run_call_reservations` — idempotent call ledger

```sql
CREATE TABLE public.run_call_reservations (
  run_id       uuid NOT NULL REFERENCES public.investigation_runs(id) ON DELETE CASCADE,
  call_key     text NOT NULL,            -- slice_id + SDK toolCallId (logical call identity)
  tool_name    text NOT NULL,
  cost_tier    text NOT NULL,
  outcome      text NOT NULL DEFAULT 'reserved',
      -- reserved | completed | failed | unknown   ← §3 on `unknown`
  cost_micro_usd bigint,
  reserved_at  timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  PRIMARY KEY (run_id, call_key)
);
```

The primary key **is** the deduplication: a retried slice replaying the same logical call finds
its own row and is told "already reserved" rather than reserving twice.

RLS on all three: owner may `SELECT`; **no tenant write policy**; `EXECUTE` on every RPC revoked
from `PUBLIC` and granted only to `service_role`. This shape is already proven — see #407's
verification, which showed tenant `UPDATE`/`DELETE` affecting 0 rows and both functions raising
`permission denied` on PostgreSQL 16.13.

---

## 3. RPC contract

### `reserve_tool_call(...)` — awaited, atomic, idempotent

```sql
reserve_tool_call(
  p_run_id     uuid,
  p_slice_id   uuid,
  p_lease_token uuid,      -- proves the caller still owns the slice
  p_call_key   text,
  p_tool_name  text,
  p_cost_tier  text,       -- free | low | expensive
  p_est_cost_micro_usd bigint,
  p_is_recording boolean   -- ALWAYS_ALLOW_TOOLS bypass every cap
) RETURNS jsonb
```

One transaction:

1. `SELECT … FROM investigation_runs WHERE id = p_run_id FOR UPDATE` — the serialization point.
2. Reject unless `status = 'active'` → `{allowed:false, reason:'run_not_active'}`.
3. Reject unless the slice is `running` **and** `lease_token` matches **and** the lease has not
   expired → `{allowed:false, reason:'lease_lost'}`. This is what stops a worker whose lease was
   reaped from continuing to spend.
4. `INSERT INTO run_call_reservations … ON CONFLICT (run_id, call_key) DO NOTHING`. Zero rows
   inserted ⇒ already reserved ⇒ return `{allowed:true, replayed:true}` **without incrementing
   anything**. This is the idempotency guarantee.
5. If `p_is_recording` → allow, no counters touched. Recording and finalize tools are never
   starved; this preserves the existing `ALWAYS_ALLOW_TOOLS` contract exactly.
6. Enforce, in order, returning the first breach: `total_calls`, `paid_calls` (when tier ≠ free),
   `tool_counts[tool]`, `cost_micro_usd + p_est_cost_micro_usd`.
7. Increment the counters and commit.
8. Return `{allowed, reason, remaining:{total, paid, same_tool, cost_micro_usd}}`.

`remaining` is returned so the worker can drive the prompt block (§6) without a second read.

**Settlement is a separate, later call:** `settle_tool_call(run_id, call_key, outcome,
actual_cost_micro_usd)`. It corrects `cost_micro_usd` from the estimate to the actual and moves
`outcome` off `reserved`. It **never returns a slot** — a reservation is permanent, matching the
reasoning already documented in #377: releasing on a post-admission rejection reopens the race,
because with sequential arrivals every rejected call hands its slot back and the cap is never
reached.

### Unknown provider outcomes — explicit, never retried blind

A paid call that times out has an **unknown** outcome: the provider may have executed and billed
it. `settle_tool_call` with `outcome='unknown'` keeps the reservation, keeps the estimated cost
charged against the run, and marks the row. A replayed slice hitting the same `call_key` gets
`replayed:true` and **must not re-dispatch a paid provider call** — it surfaces the unknown
outcome to the model as a tool result describing the uncertainty. Billing twice for one logical
call is the failure this prevents; the cost of the rule is that an unknown-outcome call is not
automatically retried, which is the correct trade for a paid endpoint.

### Other RPCs

| RPC | Purpose |
|---|---|
| `start_or_resume_run(thread_id, start_key, seed_fingerprint, limits)` | Idempotent on `(thread_id, start_key)`. Returns existing active run or creates run + slice 1 in one transaction. |
| `claim_next_slice(worker_id, lease_seconds)` | `SELECT … FOR UPDATE SKIP LOCKED` over `pending` / lease-expired slices; sets `running`, issues `lease_token`. Two workers cannot claim one slice. |
| `complete_slice(slice_id, lease_token, checkpoint, next_kind)` | Marks complete **and** inserts the next `pending` slice **in the same transaction**. |
| `fail_slice(slice_id, lease_token, retryable, reason)` | `retryable_failed` (re-enqueued, `attempt+1`) or `terminal_failed`. |
| `cancel_run(run_id)` | `status='cancelled'`; the partial index frees the thread for a new run; pending slices → `cancelled`. |
| `finalize_run(run_id, lease_token, report_message_id)` | Commits the terminal report exactly once (§6). |

---

## 4. State transitions

```
                    ┌──────────────────────────── cancel_run ──────┐
                    │                                              ▼
  pending ──claim──► running ──complete──► completed          cancelled
     ▲                 │                       │
     │                 ├── fail(retryable) ──► retryable_failed ──┐
     │                 │                                          │
     └──── re-enqueue ─┴── lease expiry (reaper) ─────────────────┘
                       │
                       └── fail(terminal) ──► terminal_failed
```

**Run:** `active → completed` only via `finalize_run`. `active → cancelled` via Stop.
`active → failed` only when a slice reaches `terminal_failed` **or** `attempt` exceeds the retry
ceiling.

Crucially: **a lost worker is not a failed investigation.** An expired lease returns the slice to
`pending` and it is retried. The UI shows *Interrupted* only on `terminal_failed` or retry
exhaustion — never merely because one slice lost its isolate. That is the direct fix for the ghost
recoveries described in `INCIDENT_2026-07-26`, and it composes with invariant I-1 rather than
replacing it.

---

## 5. Queue delivery model — and the extension risk

The driver must be durable and must not depend on the browser, a floating promise, or a dying
isolate invoking its successor.

**Preferred: `pgmq`.** `complete_slice` sends the next slice's message in the **same transaction**
that marks the current one complete, so "committed" and "enqueued" cannot diverge. The worker
acknowledges (`pgmq.delete`) **only after** that commit. Visibility timeout provides retry; a
crash between commit and ack redelivers, and `claim_next_slice` finds the slice already `running`
or `completed` and no-ops — so redelivery does not duplicate work.

**The risk (§1e): pgmq is not installed, and a `CREATE EXTENSION` in a migration has already
silently failed on this project.** The design therefore puts delivery behind one interface with
two implementations:

| driver | needs | granularity | verdict |
|---|---|---|---|
| **A — pgmq + pg_net** | 2 extensions | seconds | preferred; blocked on install |
| **B — table-as-queue + external tick** | none | bounded by tick | **works today** |

Driver B polls `run_slices` directly (`claim_next_slice` already uses `FOR UPDATE SKIP LOCKED`,
which is the same primitive pgmq is built on) and is ticked by the **existing GitHub Actions
cron** — proven in production, since that is what actually runs the health sweep today. Its
15-minute cadence is far too coarse to drive ~2-minute slices, so driver B ships with the tick
raised **and** each worker chain-invoking the next slice via `EdgeRuntime.waitUntil` as a
*latency optimisation only* — never as the correctness mechanism. Correctness always rests on the
lease reaper.

**PR 2 must not begin until we know which driver we get.** Determining that is one query and one
migration attempt; it is listed as the first task of PR 2 in §8.

Worker loop, per slice: claim → hydrate checkpoint → run bounded by `SLICE_DEADLINE_MS` with a
shutdown reserve → **await** critical artifact/checkpoint writes → `complete_slice` (commit +
enqueue next, atomically) → ack. `EdgeRuntime.waitUntil` may drain telemetry after the response;
it does not extend the runtime limit and is never the scheduler.

---

## 6. Finalization, recovery, and `finalize_no_findings`

Finalization is its own slice (`kind='finalize'`) and is idempotent. `finalize_run` sets
`report_message_id` with `WHERE report_message_id IS NULL`; a second attempt affects zero rows and
returns "already finalized". **Exactly one terminal report per run.**

### The `finalize_no_findings` semantics question, answered from the code

`catalog.ts:122` defines it as *"no additional tool-supported findings to persist"*, with
`reason ∈ {all_supported_findings_already_persisted, no_tool_supported_findings}`. So the observed
23-artifact run calling it was **not necessarily wrong** — `all_supported_findings_already_persisted`
is exactly the legitimate case for a run whose artifacts were already recorded.

The invariant to enforce and test is therefore narrower than "it must not fire with artifacts":

> `no_tool_supported_findings` requires **zero reportable artifacts attributable to this
> `investigation_run_id`**. `all_supported_findings_already_persisted` requires **at least one**.

And, per the verdict: run-scoped, never thread-scoped. Artifacts must carry `run_id` so a prior
investigation's 23 artifacts cannot satisfy the current run's completion contract. That requires
adding `run_id` to `artifacts` (nullable, backfilled `NULL` = pre-run-identity, never inferred).

Completion contract I-2 is preserved and tightened: `completed` requires a durable report-shaped
message **for this run** or a correctly-reasoned `finalize_no_findings` **for this run**.

---

## 7. Telemetry correction

`run_death_forensics` is amended to stop implying a distinction it cannot make. `terminal_writer`
stays; a `shutdown_reason` field is added and is **`"unknown"` unless the platform actually
emitted one**. The `recovery.ts:560` comment instructing inference from `run_elapsed_ms` is
removed.

New per-slice lifecycle events: `slice_claimed`, `slice_started`, `slice_checkpointed`,
`slice_enqueued_next`, `slice_completed`, `slice_lease_expired`, each carrying `run_id`,
`slice_id`, `seq`, `attempt`, `lease_expires_at`, and the last committed checkpoint.

Two additions that pay for themselves immediately:

- **`finish_reason` on every step**, not only at finalize. This is what actually distinguishes a
  model text-only termination (`finishReason:"stop"` with work outstanding) from a platform kill
  (no final step at all). Today it is recorded nowhere, which is why the question is still open.
- **`beforeunload` shutdown reason** where Supabase emits it, plus any deadline/abort/CPU
  indicator available. Absent ⇒ `unknown`. **Never inferred from heartbeat duration.**

Measuring the headless-worker ceiling (§0.1) uses exactly these two events and is a PR 2
prerequisite.

---

## 8. Implementation sequence

**PR 1 — durable investigation identity + atomic budget reservation.**
`investigation_runs`, `run_call_reservations`, `start_or_resume_run`, `reserve_tool_call`,
`settle_tool_call`, `cancel_run`; `artifacts.run_id`. Integration: `cache.ts:1036` (the existing
`startCall` site) becomes an awaited RPC; `runtime-policy.ts` keeps in-process pacing/concurrency
and loses budget authority; `auth.ts` resolves or creates the run. #383's `reserveToolCall` is
retained as the local pre-filter. #407 closed unmerged, its migration reused.

**PR 2 — slice state machine + durable worker.** *First task: determine whether pgmq/pg_cron can
be installed; report before building.* Then `run_slices`, `claim_next_slice`, `complete_slice`,
`fail_slice`, the lease reaper, `SLICE_DEADLINE_MS` (coordinate with #331), and the headless
ceiling measurement.

**PR 3 — finalization/recovery semantics + UI subscription + transport idempotency.**
`finalize_run`, the `finalize_no_findings` invariant, retry-aware recovery (no Interrupted stub on
a retryable death), UI subscription to run/slice state instead of one owning SSE connection, plus
the separately-retained fixes: duplicate error rendering, double-submit protection, model
text-only turn with work outstanding, browser disconnect, and Stop cancelling future slices.

All draft. No merge, deploy, stamp, mirror, or production change.

---

## 9. Test matrix

All thirteen required proofs, mapped to the mechanism each one kills. Every row is a
failure-injection test; the final row is the mutation requirement.

| # | Proof | Mechanism under test |
|---|---|---|
| 1 | 3 slices share one 12-paid budget; call 13 rejected | `reserve_tool_call` row lock |
| 2 | New investigation in same thread gets a new budget | `investigation_runs.seq` + partial unique index |
| 3 | Retried start ⇒ one run, one first slice | `(thread_id, start_key)` unique |
| 4 | Two workers cannot claim one slice | `FOR UPDATE SKIP LOCKED` + `(run_id) WHERE running` |
| 5 | Crash after reservation ⇒ no unbounded retry | `attempt` ceiling → `terminal_failed` |
| 6 | Crash after provider return, before persistence | `outcome='unknown'`, no re-dispatch |
| 7 | Crash after enqueue, before ack ⇒ no duplicate work | commit+enqueue in one txn; claim no-ops |
| 8 | Browser disconnect does not stop the investigation | worker has no client dependency |
| 9 | Cancellation prevents the next slice | `cancel_run` + `run_not_active` |
| 10 | Expired leases resume automatically | reaper → `pending` |
| 11 | Report persists exactly once | `WHERE report_message_id IS NULL` |
| 12 | Retryable slice death ⇒ no Interrupted stub | recovery reads slice state, not thread staleness |
| 13 | Removing the atomic reservation, lease guard, idempotency guard, or durable enqueue **fails a test** | mutation testing, each mutation asserted to have applied |

---

## 10. Open questions requiring a decision

1. **Extension install rights on the Lovable-owned Supabase.** Blocks driver A. If unavailable,
   driver B ships and the tick cadence becomes the latency floor.
2. **The four run limits.** Snapshotted per run, so they must be chosen. Observed legitimate use
   (last 5 investigations): up to 248 total / 80 paid / $2.92. A cost ceiling is the meaningful
   control — 73–92% of run cost is orchestrator tokens, which no call cap touches.
3. **What ends an investigation.** A run is `active` until finalized. If the analyst asks a
   follow-up question in the same thread, does it join the run or start a new one? Proposal:
   structural signal only — a new run starts when the run is not `active`, or when the message
   parses as a seed and the prior run is finalized. Never inferred from prose, per the standing
   rule.
4. **#377 vs #383.** Recommend adopting #383 and closing #377 as superseded.
5. **Retry ceiling and lease duration.** Proposal: lease = `2 × SLICE_DEADLINE_MS`, max 3 attempts
   per slice, exponential backoff between attempts.
