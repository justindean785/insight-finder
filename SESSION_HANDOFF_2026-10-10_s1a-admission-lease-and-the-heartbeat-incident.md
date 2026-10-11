# SESSION HANDOFF — 2026-10-10 — S1a admission lease shipped, switched OFF after the heartbeat incident

> **Take the state from `/health`, `git log origin/main`, `deploy-log.jsonl` and `git fetch origin refs/heads/deploy/live`, never from
> this file's numbers.** Everything dated below was measured 2026-10-10/11 and may already have moved. Address the user as **JD**.
> Engineering only — never investigate any person who appears in a scan.
>
> **This file supersedes** the statement in `SESSION_HANDOFF_2026-10-10_evidence-guards-and-the-learning-loop.md` §5 (L5) that the
> server-side run lease is "unbuilt". It is built, deployed and **disabled by a kill switch**. Read this file first, then `CLAUDE.md`.

## 0. The one sentence

S1a (the no-schema per-thread admission lease) is **implemented and deployed, but enforcement is OFF** (`RUN_LEASE_DISABLED=true`).
Do **not** re-enable it, and do not touch that secret, without JD's explicit, separate authorization.
`reveal_breach_data` stays ON (settled, see `CLAUDE.md`; JD re-confirmed 2026-10-10: only JD uses the site for now).

## 1. State when written (re-measure, do not trust)

| Surface | Value | How it was measured |
|---|---|---|
| Live `osint-agent` build | `811929c` | `/health` 2026-10-11T06:43Z |
| `checks.run_lease` | `ok:true`, detail `LEGACY via RUN_LEASE_DISABLED — admission is unconditional` | same call |
| `reveal_breach_data` | `true` | same call |
| Canonical `main` | `88f853e` (ledger #736) | `git fetch` 2026-10-11 |
| `deploy/live` | `811929c` | `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` |
| Ledger tail | `runtime_marker 811929c`, recorded `2026-10-10T10:06:00Z` | `deploy-log.jsonl` |
| Mirror `seeker-spark-search-5362c57c` main | `8d59968` (mirror #111) | `git fetch` in the mirror clone |
| Edge baseline at the S1a merge | 2232 passed / 0 failed / 6 ignored | CI on #730; re-measure before blaming a diff |

Not verified in this documentation pass: the Supabase secret itself (only its effect on `/health` is observable), and any behaviour of the
lease with enforcement **on** against real traffic after #734. No post-#734 production admission test has ever run.

## 2. What shipped, in order

| PR | What | Channel |
|---|---|---|
| #730 | S1a lease: `lib/run-lease.ts`, wired in `auth.ts` and `index.ts`, `checks.run_lease`, `.github/ci/assert-run-lease.sql` | edge, live as `2e0d3ee` (stamp #731, mirror #110, ledger #732) |
| #733 | Client stops stamping `status`/`last_heartbeat_at` before a send (`ChatWindow.beginInvestigation`) | frontend, live on merge |
| #734 | Server guard: a heartbeat alone is not a live run; also needs a recent `run_started_at` | edge, live as `811929c` (stamp #735, mirror #111, ledger #736) |
| #729 | Docs only: remediation plan, `tasks/todo.md`, `tasks/lessons.md`, this handoff. **Draft, unmerged** | docs |

## 3. How the lease works (`supabase/functions/osint-agent/lib/run-lease.ts`)

- The lease is **one versioned conditional UPDATE on `threads`**. The row is the marker; no new columns, no schema change.
- A row **admits** a new run unless it is live. Live means all three hold: `status='active'`, `run_started_at` within `RUN_LEASE_MAX_RUN_MS`,
  and `last_heartbeat_at` within `RUN_LEASE_STALE_MS` (75 s, same as `recovery.ts STALE_RUN_AFTER_MS`).
- `RUN_LEASE_MAX_RUN_MS` is **6 minutes**, pinned by a test to be at least twice `ORCHESTRATOR_WALL_CLOCK_MS` (3 minutes, `orchestrator-budget.ts`).
  That is the "run wall": no genuine run outlives it, so a row older than that cannot be live however fresh its heartbeat looks.
- Refusal is **409 `RUN_IN_PROGRESS`**. A database fault or version churn is **503 `RUN_LEASE_UNAVAILABLE`** with `Retry-After`. Acquisition **fails
  closed**: an unprovable claim is never admitted.
- Release happens on every startup exit: `withLeaseCleanup` around setup, the two 402 exits in `index.ts`, and the outer catch. The release restores
  the prior snapshot only while the row is still `status='active'` and `run_started_at` equals the lease's start, so it can never resurrect a run
  that finished in between. On the real handoff `startupLease` is cleared and `startRunHeartbeat` takes over with the lease's `startedAt`.
- **Kill switch:** `RUN_LEASE_DISABLED=true`, read at call time, falls back to the old unconditional `markRunStarted`. No deploy is needed to flip it.
- **Stated limit:** this is a time lease, not fencing. A worker that stalls past the wall can still write over a successor. That is S1b.

## 4. The incident (2026-10-10) and why it happened

1. #730 went live as `2e0d3ee` and every send returned **409**. JD captured one carrying `last heartbeat 2026-10-10T09:36:34Z`.
2. Cause: `ChatWindow.beginInvestigation` had always written `status:'active'` and a **fresh `last_heartbeat_at`** to `threads` *before* each send.
   The first lease treated a fresh heartbeat as "a run is live", so every send refused itself. The wiring test checked server-side ordering and could
   not have seen a client write. `recovery.ts` even documented the client stamp; it was read past.
3. Diagnosis took three read-only SELECTs through the Lovable `query_database` tool: the two threads' rows, an empty `tool_usage_log` window and an
   empty `orchestrator_invocations` window proved that no run was live.
4. Rollback was **the kill switch**, set through the Lovable agent (`secrets--set_secret`), and `/health` showed `LEGACY` within a minute. No redeploy.
5. Fix in two halves: #733 removes the client stamp; #734 makes the server stop trusting a heartbeat that has no recent `run_started_at`, so a stray
   writer can never again make a thread look live.

## 5. Open work, in order (all JD-gated)

1. **Controlled re-enable** — only on JD's explicit authorization. Procedure: have the Lovable agent (project `4ce11bc3-039d-4439-b293-acacca9e1e3a`)
   remove the `RUN_LEASE_DISABLED` secret; confirm `/health` `checks.run_lease` no longer says LEGACY and names the 6-minute wall; watch one real
   send succeed; deliberately double-send on a test thread and expect the second to get 409 with a truthful reason. Rollback is the same secret set to `true`.
2. **S1b fencing** — `threads.run_generation` / `run_owner` columns, then fenced heartbeat/finalize/persistence writes (`checks.run_fencing`).
   Schema first, through Lovable, verified against the live DB, as its own PR. Not started.
3. **#729** — JD reviews the plan; it must not ride with any release.
4. **Engine defects, separate PRs, evidence-ranking so each needs JD's sign-off:** `confidence.ts:432` removes only `unknown` from the corroboration
   count while `source-classification.ts:930 NON_CORROBORATING_CLASSES` also excludes `ai_summary`, `web_search`, etc.; the model emits kinds outside
   the taxonomy (`threat_reputation` coerces to `other`); negative lookups should count as coverage, not artifacts. Not built.
5. **L2 memory tool axis (S7)** — `memory_recall` matches on `subject` only; unstarted beyond reconnaissance.
6. Optional pivots on the juba-osint.com case (verification tokens, registrar reseller, Reddit author).

## 6. Release recipe traps this session re-hit

- Stamp PR must merge while `main` is still the marker commit. `npm run stamp:build` then copy **only changed files** to the mirror; `diff -rq` empty.
- `verify:deploy -- --previous <prev> --mirror <path>`: `marker_offset_mismatch` before the deploy is expected; the gate is `mirror tree -> equal` + `mirror pushed`.
  `git fetch origin refs/heads/deploy/live:refs/heads/deploy/live` first, or the ledger reports a false `ledger_ref_divergence`.
- Lovable `send_message` times out client-side at 60 s and may never land: check `list_messages`, resend with `wait=false`, poll `get_message`.
  `/health` build SHA is the only proof of deploy.
- Merge by PR number; a guessed full `expectedHeadSha` is refused.
- Deno 2.9.7 is not preinstalled in a fresh sandbox. Use `--no-lock`; `deno.lock` otherwise rewrites (restore with `git checkout -- deno.lock`).
- CI's Frontend job lints `supabase/functions/` as well: no `any`, type the PostgREST chain.
- Rule from the incident: before gating on a server liveness column, grep `src/` for every client write to it and say so in the PR.

## 7. Where things are

- Code: `supabase/functions/osint-agent/lib/run-lease.ts` (constants, `admitsRow`, `acquireRunLease`, `releaseRunLease`, `withLeaseCleanup`,
  `runLeaseRefusalResponse`, `runLeaseSelfTest`), `auth.ts` (acquire plus refusal), `index.ts` (`startupLease`, 402 releases, heartbeat handoff),
  `health-handler.ts` (`checks.run_lease`), `lib/run_lease_test.ts` (16 tests), `.github/ci/assert-run-lease.sql` (Postgres predicate matrix).
- Docs: `docs/plans/REMEDIATION_PLAN_2026-10-10.md`, `tasks/todo.md`, `tasks/lessons.md`. The June UI plan that `tasks/todo.md` used to hold is
  preserved verbatim at `docs/archive/TODO_2026-06_workspace-ui-plan.md`.

## 8. Verify

```bash
curl -s "https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1" | jq '{build, run_lease: .checks.run_lease, reveal_breach_data}'
git fetch origin main refs/heads/deploy/live:refs/heads/deploy/live && git log -3 --oneline origin/main && tail -1 deploy-log.jsonl | jq -c '{runtime_marker, recorded_at}'
cd supabase/functions/osint-agent && deno test --no-lock --no-check --allow-net --allow-env --allow-sys --allow-read lib/run_lease_test.ts   # 16 passed
git checkout -- deno.lock
```
