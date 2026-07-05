-- tool_health: per-tool rolling reliability + latency signal for the runtime EV
-- scorer (runtime-policy.ts scoreExpectedValue). Fed by tool_usage_log so the
-- scheduler self-prunes slow / low-yield tools FROM TELEMETRY instead of a
-- hand-maintained blocklist (audit 2026-06-30 §3.5).
--
-- READ-ONLY MIGRATION. Every statement is CREATE VIEW / COMMENT / GRANT. It
-- creates no table and mutates no row of any real table — no INSERT/UPDATE/
-- DELETE/DROP. A plain VIEW is always fresh (computed on read) and needs no
-- refresh job; at beta scale tool_usage_log is tiny and the scorer reads this
-- once per run (best-effort). If the table grows large, this can be swapped to a
-- MATERIALIZED VIEW + periodic REFRESH without changing the reader contract
-- (same columns).
--
-- `security_invoker = true`: the view runs with the CALLER's privileges, so the
-- service-role scorer client sees all rows (bypasses RLS) while an authenticated
-- caller only sees their own tool_usage_log rows (RLS still applies). The view is
-- aggregate-only (no user_id column), so it never exposes another user's rows.
--
-- Window: last 30 days, LIVE calls only (cached = false) — cache hits are ~0 ms
-- and always ok, so counting them would understate latency and inflate reliability.
--
-- RELIABILITY IS MEASURED ON `outcome`, NEVER THE `ok` BOOLEAN. A live audit of
-- tool_usage_log (2026-07-05) found the `ok` flag conflates three different
-- things: genuine failures, orchestrator governance SKIPS (budget/burst/gating/
-- provider-suppression — the investigator's own choice, not a vendor fault), and
-- EMPTY negatives (the tool ran fine, the target simply has no record — a valid
-- analyst result). Counting skips/empties as failures defamed healthy tools
-- (gravatar_profile read ~35% when its true reliability is ~100%: half its calls
-- were valid "no gravatar" empties). The `outcome` column
-- (tool-outcome.ts classifyToolOutcome → ok | skipped | empty | failed) carries
-- the truth, so every aggregate below is defined on it:
--   • sample_size / ok_pct  → REAL ATTEMPTS only (outcome IN ('ok','failed')).
--     Skips and empties are excluded from BOTH numerator and denominator, so a
--     depleted-credit or all-empty tool degrades to unknown (neutral), never to
--     "broken".
--   • p95/p50 latency       → real EXECUTIONS (outcome <> 'skipped'): empties are
--     included because an empty lookup still spent wall-clock, but governance
--     skips do ~0 work and would understate latency.
-- Rows whose outcome is NULL (historical, pre-outcome-column) fall out of every
-- filtered aggregate — they are dropped, never guessed from the `ok` boolean.

create or replace view public.tool_health
with (security_invoker = true)
as
select
  tool_name,
  -- Denominator behind ok_pct: calls that genuinely ran and either succeeded or
  -- hard-failed. This is also the sample floor the scorer gates the reliability
  -- prior on (runtime-policy.ts), so it must count real attempts, not skips.
  count(*) filter (where outcome in ('ok', 'failed'))::int                      as sample_size,
  -- Rolling success rate over REAL ATTEMPTS. NULL (not 0) when a tool has no
  -- ok/failed attempts in the window — the reader maps NULL → neutral prior.
  round(
    (count(*) filter (where outcome = 'ok'))::numeric
      / nullif(count(*) filter (where outcome in ('ok', 'failed')), 0),
    4
  )                                                                             as ok_pct,
  -- p95 / p50 live latency drive the latency-penalty buckets in the scorer.
  -- Over real executions (incl. empty, excl. governance skips); percentile_cont
  -- ignores NULL duration_ms automatically.
  round((percentile_cont(0.95) within group (order by duration_ms)
         filter (where outcome <> 'skipped'))::numeric, 0)                      as p95_duration_ms,
  round((percentile_cont(0.50) within group (order by duration_ms)
         filter (where outcome <> 'skipped'))::numeric, 0)                      as p50_duration_ms,
  max(created_at)                                                              as last_seen_at
from public.tool_usage_log
where created_at >= now() - interval '30 days'
  and cached = false
group by tool_name;

comment on view public.tool_health is
  'Read-only rolling (30d, live-calls-only) per-tool reliability + p95/p50 latency, '
  'fed to the runtime EV scorer. ok_pct is measured on the `outcome` column over '
  'REAL ATTEMPTS (outcome IN (ok,failed)) — governance skips and empty negatives '
  'are excluded so they never count as provider failures. Fresh on read; mutates no data.';

-- The scorer reads this via the service-role admin client. Grant SELECT to both
-- roles so a future authenticated reader also works (RLS still scopes their rows).
grant select on public.tool_health to service_role;
grant select on public.tool_health to authenticated;
