# Durable run telemetry — runs that die before `finish()` leave no row

Status: **PROPOSAL ONLY. Nothing here is implemented.** No schema, no edge code, no flag.
Needs JD's design approval before any of the three PRs in §8 is opened.
Written 2026-10-30. Builds on telemetry PRs #899/#900/#901, which are merged but **not yet
deployed** (live `osint-agent` is still `65287b51`).

## 1. The problem

`orchestrator_invocations` is written in exactly one place: `finish()` in
`supabase/functions/osint-agent/telemetry.ts` (called from `index.ts` at the clean-finalize
path and the `onError` path). A run whose isolate dies before `finish()` runs writes **no
row at all**. The step rows are worse: they are buffered in memory and flushed only after the
parent insert, so they die with it (see the FK comment in `createInvocationTelemetry`).

So the instrument is blind to the one class of run it is most needed for: the run that was
killed. The timing columns from #899/#900 do not help — they are also written only in
`finish()`.

### Measured, 2026-10-30 (read-only SQL, production)

- Of 33 threads whose **latest** run started in the last 14 days, 32 have a matching
  `orchestrator_invocations` row (start within 10 s) and **1 does not**.
- That one is thread `06175985`: `run_started_at` 03:18:34Z, `last_heartbeat_at` 03:20:19Z
  (a 105 s run life), `recovered_at` 03:22:05Z, `recovery_reason` "stale heartbeat recovered by
  health sweep". No invocation row exists.
- 105 s is past `FINALIZE_RESERVE_MS` (90 s), so the forced-finalize window had opened. The
  heartbeat pulses every 15 s while the isolate lives, so the isolate most likely died between
  105 s and ~120 s. **That is an inference from the pulse cadence, not a measurement.** What
  killed it is unknown and is not recoverable from the database.

Caveat on the rate: `resumeThread()` overwrites `run_started_at`/`last_heartbeat_at`, so an
earlier dead run on a thread the analyst later resumed is invisible to this check. 1 of 33 is a
**floor**, not the rate. It is also a biased floor in the useful direction: dead runs are the
ones that get retyped into.

### What exists today for a dead run, and why it is not enough

| Source | What it holds | Why it does not answer "where did it die" |
|---|---|---|
| `threads.last_heartbeat_at`, `recovery_reason` | liveness, and that the sweeper recovered it | overwritten on resume; no phase, no step |
| `run_death_forensics` `console.log` (`recovery.ts` ~:656) | elapsed life, silent time, artifact count | edge logs have sub-30-minute retention; written only when a sweep happens to run |
| `tool_usage_log` | every tool call, durable for months | says nothing about the model loop, salvage, clustering or persistence |

## 2. Goals and non-goals

Goals: after any run, dead or alive, one durable row says **that it started, which phase it was
in last, and when it last made progress**. A run that dies in salvage must be distinguishable
from one that dies in the tool loop.

Non-goals: no change to the model, providers, budgets, `toolChoice`, finalize logic, evidence
writes, confidence, or the heartbeat/lease. No prompt, tool input, or result text is stored
(same privacy contract as the existing tables). Nothing new is awaited on the run's own path.

## 3. Options considered

**A-min (recommended).** Insert the invocation row at run start, write a phase breadcrumb at each
phase transition, and upsert the full row in `finish()`. Step rows stay buffered as today.

**A-full.** A-min plus step rows inserted as each step finishes (the parent now exists, so the FK
holds). Gives per-step timing for a dead run. Costs one extra round trip per step. Defer: the
phase breadcrumb answers the question that motivated this, and step rows can be added later if a
measurement needs them.

**C. Extend the heartbeat to write a breadcrumb onto `threads`.** Rejected. `threads` is the hot
table, and the `recovery.ts` forensics comment already records why it cannot be the durable
home: `resumeThread()` overwrites it the moment the analyst retypes, destroying the dead run's
snapshot. It also mixes telemetry into the run-lifecycle table that invariants I-1/I-2 guard.

**D. Do nothing and pull edge logs per incident.** Rejected as the standing answer. Log retention
is under 30 minutes, so it only works if someone asks within the window. It remains the right
way to explain `06175985` specifically, and is independent of this design.

## 4. Proposed design (A-min)

### 4.1 Schema (additive, applied first, verified, then code)

On `orchestrator_invocations`:

- `ALTER COLUMN finished_at DROP NOT NULL`, `ALTER COLUMN duration_ms DROP NOT NULL`. An in-flight
  or dead row has no honest end. A placeholder `0` would pollute every `AVG(duration_ms)` that
  forgets a filter; `NULL` is ignored by aggregates. Nothing under `src/` reads this table and it is
  not in the generated frontend types, so the nullability change has no type fallout.
  Existing readers to check: `scripts/baseline-metrics.sql` and ad hoc SQL.
- `last_phase text` with a CHECK in `('loop','persist','salvage','cluster')`.
- `last_phase_offset_ms integer`, CHECK `>= 0` (ms from invocation start, the recorder's
  monotonic clock, same convention as the #899 offsets).
- Widen the `stop_reason` CHECK with `'interrupted'`, written only by the optional recovery stamp
  in §8 PR C. Not needed for PR B.

Reading the result: `finished_at IS NULL` and `last_progress` older than `STALE_RUN_AFTER_MS`
(75 s) means the run died; `last_phase` says where. Existing rows are unchanged
(`finished_at` is already non-null on all of them, `last_phase` NULL = "predates this").

### 4.2 Recorder (edge, `telemetry.ts` + `index.ts`)

1. Right after `createInvocationTelemetry(...)` (`index.ts` ~:1198), fire a **non-awaited**
   `insert` of a minimal row (id, thread_id, user_id, provider, model_id, started_at,
   `last_phase='loop'`, `last_phase_offset_ms=0`), registered with `registerBackground` exactly
   like today's `finish()` write. The run path never waits on it.
2. At each transition the recorder already knows about (`markLoopEnd`, `markPersistStart`,
   salvage start, cluster start) fire a non-awaited `update ... where id = ?` of the two phase
   columns. At most 3 such updates per run (loop→persist, persist→salvage, salvage→cluster).
3. `finish()` becomes `upsert(row, { onConflict: 'id' })`. One code path covers both cases: the
   up-front insert landed (it updates) or it did not, e.g. schema lag or a DB blip (it inserts,
   which is **exactly today's behaviour**). That fallback is the safety property: the worst case
   of this change is the current instrument.
4. Phase writes are chained behind the up-front insert's promise so an update never races ahead of
   the row it targets. If the up-front insert errored, phase writes are skipped for the run.
5. Every new method swallows its own faults, as the #900 methods do (and for the reason #901's
   review found: `finish()` must still land the legacy row if a clock or DB fault hits).

### 4.3 Kill switch, proof, rollback

- `DURABLE_TELEMETRY_DISABLED=true`, read once per recorder like `TIMING_TELEMETRY_DISABLED`,
  restores the finish-only insert byte-for-byte. Rollback is a secret change, no deploy.
- Proof key `checks.durable_telemetry` in `/health`: a pure self-test of the recorder against a
  fake DB (in-flight row written, phase updates ordered, upsert fallback when the insert errors).
  `/health` is a build proof, so it proves the code shipped, not that a production run behaved.
- Production proof needs no new column: on a new-shape row `created_at - started_at` is a few
  seconds, where on an old-shape row it is about `duration_ms`. After the first real run post-deploy,
  that single query distinguishes the two shapes.

## 5. Write volume

Measured over the last 14 days of production: 124 invocation rows and 933 step rows across 10
active days (mean 7.5 steps per invocation; max 13 observed, cap 22).

A-min adds, per run, **at most 3 single-row updates** and changes one insert into one upsert. Over
14 days that is under 400 extra single-row writes, none awaited. Row counts do not change. A-full
would add roughly 7 to 8 more round trips per run, with no new rows, since the step rows already
exist and are only written earlier. That is why it is deferred.

## 6. Risks

- **Test coverage.** `telemetry_test.ts` and `telemetry_timing_test.ts` use a fake DB with
  `insert` only and pin "one parent insert". They need `update`/`upsert`, and the legacy-shape
  assertions must keep holding under the kill switch. Mutation-check the upsert fallback.
- **Ordering.** The FK rule is unchanged: a step row must follow its parent. A-min leaves step rows
  buffered, so this change does not touch it.
- **Readers.** Any query that assumes `finished_at`/`duration_ms` are non-null will now see NULLs
  for in-flight and dead rows. That is intended. `scripts/baseline-metrics.sql` is the only
  checked-in reader (nothing under `src/` queries these tables; the `ChatWindow.tsx` and
  `chat-stream-throttle.test.ts` hits are comments). Its Q1 averages ignore NULLs, but its Q2
  `stop_reason` distribution would count in-flight and dead rows under the default `'unknown'`,
  so PR A adds `finished_at IS NOT NULL` to those queries and a separate "unfinished" count.
- **Edge deploy discipline.** This is an edge change. CLAUDE.md allows one edge PR in flight and
  one new `/health` key per behaviour change. It must not ride the deploy of `6eb444f`; that build
  should go live and be measured first, so a regression in either can be bisected.
- **Phase breadcrumbs are best-effort.** If the isolate dies between a transition and its update
  landing, the row names the previous phase. Phase is therefore a lower bound on how far the run
  got. The doc and the column comment must say so.
- **Not a root-cause tool.** This tells us *where* a run died, not *why*. The shutdown reason still
  needs platform logs.

## 7. What this does not change

I-1 and I-2 (run-termination invariants), the phase-aware `toolChoice` rule, `FINALIZE_RESERVE_MS`,
`MAX_PAID_CALLS`, `REVEAL_BREACH_DATA`, the lease (`RUN_LEASE_DISABLED` stays as is), provider
selection, evidence ranking, confidence caps, and the recovery sweeper's decisions. The optional
recovery stamp (PR C) is additive, runs after the sweeper has already claimed the thread, and
cannot change `recovered`.

## 8. Rollout (three small PRs; the schema one is JD-applied)

| PR | Scope | Channel | Gate |
|---|---|---|---|
| A | Migration only: nullable `finished_at`/`duration_ms`, `last_phase`, `last_phase_offset_ms`, widened `stop_reason` CHECK, column comments. Review `scripts/baseline-metrics.sql`. | schema (JD applies via direct SQL, as for #899) | apply, then verify columns and constraints in production **before** PR B merges |
| B | Recorder: up-front insert, phase updates, upsert in `finish()`, `DURABLE_TELEMETRY_DISABLED`, `checks.durable_telemetry`, tests. | edge, own deploy cycle | after `6eb444f` is deployed and measured |
| C (optional) | `recovery.ts`: after a won claim, stamp the unfinished row `stop_reason='interrupted'`. | edge, own deploy cycle | only if B's rows show the sweeper timing matters |

## 9. Decisions needed from JD

1. **Scope:** A-min (recommended) or A-full?
2. **Nullability:** drop `NOT NULL` on `finished_at`/`duration_ms` (recommended), or keep the
   constraints and write a placeholder plus a `completed` flag?
3. **Order:** deploy and measure `6eb444f` first (recommended), or accept two edge changes in one
   build?
4. **PR C:** include, or leave until B has produced data?

## 10. Open items outside this design

- The cause of `06175985`'s death needs edge function logs for 03:18 to 03:23Z on 2026-10-30. The
  assistant cannot read them. Lovable or JD would have to pull them while they exist.
- Whether report-salvage explains the 28 to 96 s unattributed time in forced-finalize runs is still
  unconfirmed. #899/#900 are the instrument for that, and it only starts measuring after deploy.
