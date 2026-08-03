# Thread-scoped run budget

**Status:** implemented. **Integrity classification:** cost control, not evidence logic —
see [Evidence impact](#evidence-impact) for why that claim needs stating rather than
assuming.

## The defect

`runtime-policy.ts` enforces three runaway-cost backstops:

| constant | claimed scope | enforced scope (before) |
|---|---|---|
| `MAX_TOTAL_CALLS` | per investigation | per HTTP request |
| `MAX_PAID_CALLS` | per investigation | per HTTP request |
| `MAX_SAME_TOOL_CALLS` | per investigation | per HTTP request |

The counters live in a module-scope `Map` inside the edge-function isolate, and
`index.ts` calls `clearRuntime(threadId)` at the top of **every** request. An
investigation is not one request: the isolate is killed at the 180s
`ORCHESTRATOR_WALL_CLOCK_MS` ceiling, artifacts and checkpoints survive, and the
analyst sends "Continue". Each Continue started the budget again from zero.

So the ceiling was `documented_value × number_of_requests` — unbounded in principle.
The last measured production run: three requests, nominal cap 12 paid, **32 paid
calls actually admitted**. The comment in `runtime-policy.ts` had said "per run (per
investigation thread) — NOT per cycle and NOT advisory" since the caps were first
enforced. It was accurate about intent and wrong about behaviour.

This is the same class of defect as the one fixed in 2026-07-27 (`stopOnBudgetExhausted`
defaulting to `false` while `Number.isFinite()` guards silently discarded the
`Infinity` limits), and it survived that fix because the fix corrected *whether* the
caps were read, not *what they were counted against*.

## The change

1. **`thread_run_budget`** — a new table holding `total_calls`, `paid_calls`,
   `tool_counts` per thread.
2. **`hydrateRuntimeBudget`** — loads that row into the isolate's counters at request
   setup, immediately after `clearRuntime`.
3. **`registerBudgetPersister` / `BudgetPersister`** — `startCall` pushes the moved
   counters at a registered sink the moment they change.
4. **`budget-store.ts`** — the sink: a coalescing, fire-and-forget writer plus the
   hydration read. The only module that knows the budget lives in Postgres.
5. **`buildBudgetStatusBlock`** — tells the model what earlier requests already spent.

`clearRuntime` still runs on every request and still wipes stage, cycle, plan,
`activeCalls` and pacing. Those genuinely *are* per-invocation. Only the three spend
counters are restored.

### Why the counters are not on `public.threads`

The `Users update own threads` RLS policy has no column restriction. Putting spend
counters on that table would let any tenant reset their own budget with a single
PATCH. `thread_run_budget` has a SELECT policy for the owner and **no write policy at
all**; `EXECUTE` on both budget functions is revoked from `PUBLIC` and granted only to
`service_role`. Verified against PostgreSQL 16.13: as `authenticated`, `UPDATE`
affects 0 rows, `DELETE` affects 0 rows, `INSERT` raises an RLS violation, and both
function calls raise `permission denied`.

### Why every write is monotonic

`bump_thread_run_budget` merges with `GREATEST` on the scalars and
`jsonb_int_max_merge` on the map. Two overlapping runs on one thread (double-submit,
or a retry that starts before the previous isolate has died) each hold their own
in-memory counters and each write back; last-writer-wins would let the slower run's
smaller number erase the faster run's spend. Handing budget back is the whole bug.

The same property makes the writer safe to coalesce: snapshots are cumulative totals,
not deltas, so a dropped intermediate write loses nothing and a replayed or
out-of-order write cannot lower a counter. `hydrateRuntimeBudget` takes the maximum
for the same reason, which is also why a `null` from a failed read is a no-op rather
than a reset.

## Cost: the caps had to be re-baselined

Making the counters durable **without changing the numbers would have been a silent
~3× cut in investigation depth** — 30/12 was what production spent per *invocation*,
and a full investigation was measured at three invocations. The defaults are therefore
multiplied by that observed factor, which makes the change cost-neutral:

| | before (per request) | after (per investigation) |
|---|---|---|
| total calls | 30 | 90 |
| paid calls | 12 | **36** — observed spend was 32, so the cap now genuinely binds |
| same tool | 16 | 24 — deliberately *not* ×3; same-selector repetition is the lowest-value spend |

Net effect on a normal three-part investigation: **roughly unchanged**. Net effect on
a pathological one: it now has a ceiling. The 262-call / \$3.05 run that motivated the
2026-07-27 enforcement fix would today stop at 90.

All three numbers are asserted literally in `runtime_budget_test.ts` (D), so neither a
cut nor a quiet increase can land without editing that test and saying why. Every cap
remains env-overridable (`MAX_PAID_CALLS_PER_RUN`, `MAX_TOTAL_TOOL_CALLS_PER_RUN`,
`MAX_SAME_TOOL_CALLS_PER_RUN`) for incident response.

## Migration and backfill

`thread_run_budget` starts empty; every existing thread reads as zero spend.

The historically-correct figure *could* be reconstructed from `tool_usage_log`. It is
deliberately not, because doing so would retroactively exhaust the budget of every
long-running thread the analyst may still want to continue — an investigation the
analyst has been working for a week would come back from the migration unable to run a
single paid tool. Zero is the honest, one-time-generous default: each pre-existing
thread gets one full budget from here on, and every thread created after the migration
is accounted for from its first call. The one-time cost is bounded by
`existing_active_threads × 36` paid calls.

There is **no automatic reset path**. A thread *is* an investigation in this product,
so a genuinely new investigation is a new thread and starts at zero from the column
defaults. `reset_thread_run_budget` exists for ops and is called by nothing in
`osint-agent` — an automatic reset that fires on a continuation is precisely what made
the cap unbounded in the first place.

## Failure modes, and which way each fails

| failure | behaviour | why |
|---|---|---|
| migration not yet applied (relation missing) | hydrate returns `null`, logs `run_budget_hydrate_failed`, run proceeds | this repo's topology ships function code and SQL through different channels; a schema lag must not take the product down |
| hydration read errors or throws | same — fail open, log loudly | under-counting spend during a database outage is a cost problem; refusing an analyst's paid call because telemetry is down is a product outage |
| write RPC fails | counted in `stats().failures`, logged as `run_budget_write_failed`, run continues | same reasoning |
| persister throws | swallowed inside `startCall` | the admission decision must never depend on telemetry succeeding |
| isolate killed mid-run | loses at most one debounce window (`BUDGET_WRITE_DEBOUNCE_MS` = 400ms) of spend | writes happen *throughout* the run, not at the end — this is the failure mode the design is built around, and it previously lost 100% |

Every one of these is fail-open by choice. The honest summary: this change converts
an unbounded budget into a bounded one that can under-count by a few calls when the
database misbehaves.

## Evidence impact

None, and the reason is worth stating rather than assuming, because CLAUDE.md requires
sign-off for anything touching evidence ranking, confidence caps, chain-of-custody,
credential masking, or minor-safety detection.

- No artifact, confidence, `source_category`, `metadata`, or chain field is read or
  written anywhere in this change.
- `ALWAYS_ALLOW_TOOLS` is untouched: `record_artifacts`, `record_finding`,
  `finalize_no_findings` and the rest of the recording/finalize path bypass every cap,
  before and after. A run that exhausts its budget can still persist everything it
  found and close out honestly — pinned by the pre-existing
  `runtime_policy_test.ts` (2).
- What *does* change is **how much evidence a pathological run can gather before being
  refused**. A run that would previously have made 262 calls now stops at 90. That is
  the intended effect of a cost ceiling, and it is a reduction in *volume*, never in
  the fidelity, provenance, or confidence of what was gathered.

## Continuations are told the truth

`buildBudgetStatusBlock` appends the spend to the system prompt on a continuation
(empty string on a fresh investigation, so ordinary first requests are byte-identical).
Without it the model reads the static "36 paid calls" line, plans a twelve-pivot
sweep it cannot execute, watches the runtime refuse call after call, and the analyst
sees another run that "just stopped" — the same symptom this change exists to fix,
arriving by a different route.

The block states a measured fact and issues no stop instruction. When the allowance is
spent it points at the recording/finalize tools, which are exempt from every cap and
therefore always available; writing the report from what was already gathered is the
correct move. This respects the run-termination invariants in CLAUDE.md: a stop
decision is never taken from prose, and the block is asserted in
`runtime_budget_test.ts` (F3) to contain no stop language and none of the
"rate limited" vocabulary the prompt forbids for anything short of a literal 429.

## What this does NOT fix

Stated explicitly so it is not mistaken for more than it is.

- **It does not make an investigation finish inside one invocation.** Runs still die
  at the 180s isolate ceiling; deaths still cluster at 90–135s. The analyst is still
  the continuation mechanism.
- **It does not add automatic continuation.** It is the prerequisite: slices that each
  reset a per-invocation cap is how you get a surprise bill. This lands first so
  automatic continuation can land safely.
- **It does not change what the caps *should* be.** The re-baselined numbers preserve
  today's effective spend. Whether 36 paid calls is the right price for an
  investigation is a product decision, and it is now a decision that can actually be
  made — before this change, the number in the code was not the number being spent.

## Verification

- `supabase/migrations/20260803120000_thread_run_budget.sql` executed against
  PostgreSQL 16.13 with a Supabase-shaped harness (`authenticated` / `service_role`
  roles, `auth.uid()`, RLS on `threads`): monotonic bump, element-wise map merge,
  idempotent replay, unknown-thread no-op, NULL tolerance, tenant read-only,
  cross-tenant invisibility, service-role write, `ON DELETE CASCADE`.
- `runtime_budget_test.ts` — 20 tests. (A) reproduces the reset bug end to end;
  (A2) is its negative control.
- `budget_store_test.ts` — 15 tests covering the writer and the fail-open read.
- **Mutation-tested: 14 mutations, 14 caught.** Two of those mutations initially
  survived and exposed real weaknesses in the tests, both since fixed — a source-level
  `indexOf` check that a *commented-out* call satisfied, and an `includes()` check for
  `registerBudgetPersister(...)` that `unregisterBudgetPersister(...)` satisfied as a
  substring.
- Full suites: `deno test` 1012 passed / 0 failed / 5 ignored; `npx vitest run` 1115
  passed / 1 skipped; `npx tsc --noEmit` clean; `npm run lint` 0 errors;
  `deno check index.ts` 60 errors before and 60 after (all pre-existing).
