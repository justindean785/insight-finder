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

create or replace view public.tool_health
with (security_invoker = true)
as
select
  tool_name,
  count(*)::int                                                                as sample_size,
  -- Rolling success rate over real attempts. `ok` is the stored "not a hard
  -- failure" flag (intentional skips / empty results already count as ok), so a
  -- low ok_pct means the provider genuinely fails when it actually runs.
  round(avg(case when ok then 1.0 else 0.0 end)::numeric, 4)                    as ok_pct,
  -- p95 / p50 live latency drive the latency-penalty buckets in the scorer.
  -- percentile_cont ignores NULL duration_ms automatically.
  round(percentile_cont(0.95) within group (order by duration_ms)::numeric, 0) as p95_duration_ms,
  round(percentile_cont(0.50) within group (order by duration_ms)::numeric, 0) as p50_duration_ms,
  max(created_at)                                                              as last_seen_at
from public.tool_usage_log
where created_at >= now() - interval '30 days'
  and cached = false
group by tool_name;

comment on view public.tool_health is
  'Read-only rolling (30d, live-calls-only) per-tool p95/p50 duration_ms + ok_pct, '
  'fed to the runtime EV scorer for latency/reliability-aware scheduling. Fresh on '
  'read; mutates no data.';

-- The scorer reads this via the service-role admin client. Grant SELECT to both
-- roles so a future authenticated reader also works (RLS still scopes their rows).
grant select on public.tool_health to service_role;
grant select on public.tool_health to authenticated;
