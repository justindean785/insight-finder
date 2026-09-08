# Session handoff — 2026-09-08, performance-audit PRs merged with review defects still open

> **Every number here is a dated measurement, not a state. Re-verify before acting.**
> Written 2026-09-08T17:15Z. Supersedes `SESSION_HANDOFF_2026-09-08_queue-drain-and-dispatch-deploy.md`.

---

## 0 · Start here — 60 seconds

```bash
git fetch origin main && git log --oneline -6 origin/main
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1"
git fetch origin refs/heads/deploy/live:refs/heads/deploy/live
```

**Expect live `/health` build = `173a95e` (#558).** If it moved, another session deployed —
read the newest `SESSION_HANDOFF_*.md` first and do not assume these follow-ups are still
unshipped.

**Then, before writing any code: `list_pull_requests`.** All four performance-audit PRs
(#560 / #561 / #562 / #563) are already **merged**. Do not open a fifth copy of any of
them. The remaining work is **follow-up PRs off current `main`**.

**Do not deploy. Do not stamp. Do not sync the mirror.** The operator merged the four
PRs; that is not authorization to ship them. Three of the four landed with blocking
design defects. A mirror sync + Lovable deploy of current `main` would put those defects
on the live edge function.

---

## 1 · Verified state (2026-09-08T17:15Z)

| Axis | Value |
|---|---|
| `origin/main` | **`0a08d4b`** — #560 `1da64ce` → #561 `19cdf35` → #563 `34012f3` → #562 `0a08d4b`, all squash-merged by `justindean785` between 17:07:24Z and 17:07:46Z |
| Live `osint-agent` build | **`173a95e`** (#558) — measured against `/health` at 17:10Z. `checks.rejected_cluster_sweep` present; `synthesis` / `cache_sweep` still `ok:true, detail:"disabled"` |
| `deploy/live` | `173a95e`, local and remote |
| `main` vs live | **NOT in sync.** Four merged commits sit undeployed. That is correct until the follow-ups below land |
| Mirror | Not re-measured this session. Last recorded equal (`571cb9e` / tree `e854a98f4110`). Re-run `diff -rq` before any sync |
| Open PRs | **#541** (draft, superseded 09-03 handoff), **#516** (draft, account deletion dark), **#502** (conflicts; 39-file original). Plus this handoff PR once opened |
| This session's leftover | `cursor/correlate-freshness-gate-b16f` at `42c1051` — a **partial** #561 follow-up that is **not on `main`**. See §4 |

The previous handoff's "expect `main` = `4a5eb1c` / live `e50db9e`" line is stale. `main`
moved through #558 (`173a95e`) + stamp/ledger, then the four audit merges. Live did not
move with those four.

---

## 2 · What this session did, and what it did not

Built four performance-audit PRs (telemetry, correlate freshness, SocialFetch host
routing, paid-budget bookkeeping). The operator reviewed them, named blocking defects
on #560 / #561 / #563, and then **merged all four anyway** before the follow-ups were
pushed.

This session started the #561 follow-up (`resetCorrelateRun`) and was told to write
the handoff instead of finishing. Worktrees were started and then explicitly abandoned.

**Not done:** follow-up PRs, tests for the isolate-reuse case, #560 persist-order rewrite,
#563 predicate split, YouTube abort-contract test, stamp, mirror sync, Lovable deploy,
ledger.

**Do not treat the leftover `42c1051` commit as shipped.** #561 squash-merged the
original `48aa2bc` tip. `resetCorrelateRun` is not on `main`. `git grep resetCorrelateRun
origin/main` is empty.

---

## 3 · Traps — read before touching any of the four merges

1. **A merge is not a deploy, and a merge is not a review-fix.** All four PRs are on
   `main`. Live `/health` is still `173a95e`. The review defects are now the default
   branch. Opening "the same PR again" is how #548 / #551 happened. Follow-up branches
   off `0a08d4b` (or whatever `origin/main` is when you start).
2. **`resetCorrelateCycle()` is the wrong place to clear `lastCorrelateOutcome`.** It
   runs in two places: request start (`index.ts`) **and** `minimax_correlate`'s success
   path (`tool-registry.ts`). Clearing the outcome there would make every post-success
   re-run look like the run's first correlate and **disable the freshness gate**. The
   mid-run helper must keep leaving the outcome alone. Request start needs a **wider**
   API (`resetCorrelateRun`) that also nulls the outcome. This is the #561 defect.
3. **The unit tests hide #561.** `resetGuardState()` in `correlate_freshness_test.ts`
   and `correlate_freshness_wrapper_test.ts` assigns `guard.lastCorrelateOutcome = null`
   directly. Production's request init only called `resetCorrelateCycle()`. A
   sequential-two-runs test that goes through the **production** reset is the one that
   fails today.
4. **#560 inserts children before the parent.** `recordStepFinish` inserts
   `orchestrator_step_metrics` (FK → `orchestrator_invocations.id`) during the run;
   `finish()` inserts the parent only at the end. Under `registerBackground` those
   writes race; a step row that lands first is an FK violation, swallowed by
   `insertBestEffort`'s warn-and-forget. The table will look empty and the instrument
   will look "fine." Insert the parent at start (nullable `finished_at` / `duration_ms`
   or a `status` column), update it at finish. Add a fake-DB test that asserts the
   first write is the invocation row.
5. **`duration_ms` on a step row is step wall-clock, not model think time.** It is
   `onStepFinish - onStepStart` and includes tool execution. The audit wanted model
   thinking time. Rename the column (or the field) to `step_wall_ms` unless the SDK
   exposes a real model-only interval — do not claim it is thinking time.
6. **`deriveStopReason` treats `finishReason === "tool-calls"` as `budget_exhausted`.**
   That is an inference, not a reading of the orchestrator/budget machinery. A step
   that ends on tool-calls because the model issued tools is the normal loop, not a
   cap. Derive from the authoritative flags (`finalizeStarted`, the actual cap
   latches, `hadStreamError`), not from that finishReason.
7. **#563 changed the wrong function.** `costTierForTool(baseCost, name)` returning
   `"free"` for `memory_recall` / `memory_save` also feeds EV scoring (`costPenalty`)
   and `cost_tier` runtime metadata. Admission exemption is a separate predicate —
   `countsTowardPaidCallBudget(name, baseCost)` — used **only** at the `MAX_PAID_CALLS`
   reserve/refund sites. Leave `costTierForTool(baseCost)` as a pure cost-band.
8. **#560's migration is not applied.** Same shape as #547: merging the SQL does not
   create `orchestrator_invocations` in the Lovable-owned database. Deploying the
   edge function first just makes every insert warn-and-swallow. Apply the migration
   (after the persist-order fix) as its own explicit step.
9. **`marker_offset_mismatch` after a stamp-then-deploy is expected.** Live still
   reports the old marker until `/health` moves. The hard-gate condition in that
   window is `mirror tree -> equal`.
10. **The clone is shallow; `origin/main` moved under this session.** Local `main`
    was `156d9e8` when the session started. Always `git fetch origin main` before
    branching follow-ups.

---

## 4 · The honest not-done list — this is the next session's job

Work **one follow-up PR at a time**, off current `origin/main`. Do not batch them
onto one branch. Do not deploy any of them until the first three are fixed.

### Follow-up A — #561 isolate-reuse (highest severity if deployed)

**Symptom.** Warm isolate, Run A correlate succeeds → `lastCorrelateOutcome = "ok"`.
Run B starts, `resetCorrelateCycle()` zeroes the counter and leaves the outcome.
Run B's first correlate is skipped as redundant. That is the opposite of the PR's
stated invariant ("never block the run's first correlate").

**Fix (already designed, not on `main`).**

```ts
export function resetCorrelateCycle() {
  guard.artifactsSinceCorrelate = 0;
  guard.correlateHintDelivered = false;
  // MUST NOT clear lastCorrelateOutcome — mid-run success path needs it
}

export function resetCorrelateRun() {
  resetCorrelateCycle();
  guard.lastCorrelateOutcome = null;
}
```

`index.ts` request start calls `resetCorrelateRun()`. `tool-registry.ts` success
path keeps `resetCorrelateCycle()`.

A partial implementation lives at `42c1051` on `cursor/correlate-freshness-gate-b16f`.
**Do not merge that branch** — it still contains the original #561 commit and will
conflict. Re-apply the two-file patch onto `origin/main`. Then add:

- unit: `resetCorrelateCycle()` leaves `lastCorrelateOutcome === "ok"`
- unit: `resetCorrelateRun()` clears outcome, counter, and latch
- wrapper: sequential two runs through `wrapToolsWithCache` — Run A success, then
  the **production** reset (`resetCorrelateRun`), then Run B's first call reaches
  the tool
- wiring: `index.ts` source contains `resetCorrelateRun()` at request start (the
  `reviews_wiring_test.ts` pattern — unit tests stayed green while the call site
  was wrong)

### Follow-up B — #560 telemetry persist + semantics

On `main` in `telemetry.ts`: `recordStepFinish` → `insertBestEffort("orchestrator_step_metrics")`;
`finish()` → `insertBestEffort("orchestrator_invocations")`. Invert that.

- Insert the invocation parent at recorder construction (nullable `finished_at` /
  `duration_ms`, or add `status`).
- Update the parent in `finish()`.
- Rename step `duration_ms` → `step_wall_ms` (migration + row builder + tests)
  unless you find a real SDK model-only timer. Do not invent one.
- `deriveStopReason`: stop mapping `"tool-calls"` → `budget_exhausted`. Read the
  orchestrator's own cap/finalize flags.
- Fake-DB regression: first write is the parent row; step rows after; finish is
  an update.

The telemetry **migration is also unapplied.** Do not deploy the function until
both the persist-order fix and the migration exist in the live database.

### Follow-up C — #563 paid-budget predicate split

Keep `costTierForTool(baseCost)` unchanged (no `toolName` argument). Add
`countsTowardPaidCallBudget(name, baseCost)` used only at reserve/refund. Revert
the EV-scoring / `cost_tier` metadata call sites to `costTierForTool(baseCost)`.
Fix the `dns_records` test comment (its cost is a paying tier; the old comment
misstated that).

### Follow-up D — #562 optional (non-blocking)

#562 is the clean merge. Optional: a deterministic test that the YouTube path
passes the 6s timeout / abort into `fetchRetry` without sleeping. Reachability
is already covered.

### Still open from the previous handoff (unchanged)

- **#547's index is merged but NOT applied.** `artifacts_synthesis_cluster_uniq`
  still does not exist in the Lovable-owned database.
- **#519 did not add durable dispatch-boundary telemetry.** Structured
  `console.warn` (`quarantine_dispatch_read_incomplete`) only.
- **#502 vs #516** is still an operator decision. Do not keep both. Do not rebase
  #502 — merge `main` in.
- **#541** is a superseded 09-03 handoff. Close or merge; it carries no code.
- Durable runtime stamping of a degraded dispatch-boundary read is unbuilt.

---

## 5 · Open, and who decides

| Item | Status |
|---|---|
| Deploy the four audit merges | **Operator decision, and the answer today is no.** Live is `173a95e`. Shipping current `main` ships the §4 defects |
| Apply `20260908000000_orchestrator_telemetry.sql` | Separate Lovable-DB step, after Follow-up B. Merging it did not apply it |
| Apply `artifacts_synthesis_cluster_uniq` | Still the #547 leftover. Safe to defer while both synthesis flags are OFF |
| **#502 vs #516** | Operator decision — do not keep both |
| **#541** | Superseded twice. Close or merge |
| Next audit items (finalization policy, context compaction, provider routing, cache hygiene, dead-code cleanup) | Do not start until A/B/C above are on `main` |

---

## 6 · Settled — do not re-litigate

Unchanged from `CLAUDE.md`: `REVEAL_BREACH_DATA` stays ON; `MAX_PAID_CALLS` stays
bounded; intent is never inferred from prose; never touch `toolChoice` / `stopWhen` /
the finalize window; quarantine is disclosure, not deletion; the `artifactDedupKey`
ruling in `NEXT_SESSION_PROMPT.md` §2 stands; the bare-name pivot guard is declined;
release is not a review verdict; the evidence drawer has no general metadata writer.

Integrity, breach reveal, quarantine, and review authority were out of scope for
the audit PRs and stay out of scope for the follow-ups.

---

## 7 · Ordered next-session plan

1. `git fetch origin main` and `list_pull_requests`. Confirm live `/health` is
   still `173a95e`.
2. Follow-up A (#561 isolate reuse) — small, designed, leftover patch at `42c1051`
   as a reference only. Tests must drive `resetCorrelateRun`, not `resetGuardState`.
3. Follow-up B (#560 persist order + `step_wall_ms` + authoritative stop reason).
4. Follow-up C (#563 `countsTowardPaidCallBudget`).
5. Optional Follow-up D (#562 timeout-argument test).
6. Stop. Do not stamp, sync, or deploy unless the operator explicitly asks after
   A/B/C are on `main`. If they do: apply the telemetry migration first, then the
   usual `stamp:build` → surgical mirror sync → `verify:deploy` (`mirror tree ->
   equal`) → Lovable `supabase--deploy_edge_functions` → moved `/health` SHA →
   `record:deploy`.

A behavioural `/health` key would help the next deploy (the four merges add none).
Do not invent one as a drive-by; add it only if a follow-up already touches the
health handler.
