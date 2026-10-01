# There is no call-to-artifact lineage — and it blocks the whole learning layer

**Measured 2026-09-13 against the live database.** Not inferred, not read off a plan.

## The gap

`artifacts` columns are exactly:

```
id, thread_id, user_id, kind, value, confidence, source, metadata, created_at, cluster_id, subject_id
```

**There is no join key to `tool_usage_log`.** None. The closest thing is `metadata.tool`, and on
14 days of production it exists on **714 of 1,868 artifacts — 38% coverage** (`auto_persist_source`
and `via` carry the identical 714 count, so it is present only on auto-persisted rows; anything
recorded through `record_finding` / `record_artifacts` has nothing).

Worse, it stores a tool **name**, not a call id. It cannot distinguish which of 74
`minimax_correlate` calls produced a given row, and it cannot be joined to `tool_usage_log` at all.

## Why it matters

Every "which sources are worth calling" feature depends on joining an **analyst verdict** back to
the **call** that produced the artifact. Without lineage you can compute:

- how often a tool returned HTTP 200 (already have it — `tool_usage_log`)
- how many artifacts exist (already have it — `artifacts`)

…but not the only thing that matters: **how often a given source produced something an analyst
kept.** So the operational-memory layer, the "15 false positives" rule, per-dork yield, and EV
ordering are all blocked on this. It is a prerequisite, not a nice-to-have.

## The fix shape

- An `artifact_tool_lineage` **junction table** (`tool_call_id` → `artifact_id`, plus lineage type).
- **Not** an array of artifact ids on the call row. That re-creates the exact failure that broke the
  cache sweep: PostgREST renders `.in()` into the URL query string, and ~5,000 uuids is a ~185 KB
  URL against a ~24 KB gateway cap. A junction supports joins, constraints and corrections.
- `run_id` and a stable `call_id` on `tool_usage_log`.
- Carry **selector *type*, not raw selector value**, for cross-case analytics. Privacy-correct, and
  it also solves the standing problem that rejection keys are per-thread only, never cross-case.

## Sequencing

Schema first, applied **through Lovable** and verified against the live DB — `supabase/migrations/`
is intent, not mechanism (the live ledger tops out at `20260825024640`). Then the write path behind
a kill switch, with a new `/health` key so the deploy is provable. Then measure coverage. Only then
does any learning code read it.

Credit: identified independently in Codex's planning PR #586; verified here against production
before being adopted.
