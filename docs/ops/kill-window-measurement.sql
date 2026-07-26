-- kill-window-measurement.sql
-- Resolves the isolate-lifetime dispute (ORCHESTRATOR_WALL_CLOCK_MS in
-- osint-agent/orchestrator-budget.ts): "180s hard ceiling" vs "~90-135s".
-- Run read-only against the prod DB (Lovable project 4ce11bc3-039d-4439-b293-acacca9e1e3a).
--
-- Method (2026-07-25):
--   * life_s = last_heartbeat_at - run_started_at  ==> ONE run generation (the heartbeat
--     span). NOT thread age (updated_at - created_at) and NOT summed tool durations —
--     both of those over-count resumed threads.
--   * threads holds only the LATEST generation's run_started_at/last_heartbeat_at, so the
--     diff is per-generation; resumed threads are additionally flagged via >1 assistant
--     message, and implausible diffs (<0 or >190s) are flagged as stale run_started_at.
--   * Separated by outcome (clean / recovered / stream_err / active) and resume-state,
--     over a last-7-day and an 8-30-day cohort, plus a top-20 max-row inspection.
-- Result: 180s hard ceiling CONFIRMED (recovered p99 178s / max 180s / zero >=200s;
--   max rows are single-generation — a 7-generation thread aged 1708s still measured
--   165s for its latest run). Killed-run p50 ~108-113s, modal death 90-135s. Resumed and
--   non-resumed kills share the same distribution, so resumption does not inflate it.
--   => "90-135s" is the MODAL DEATH window, NOT a second ceiling. The ceiling claim
--   stands; the 90-135s-as-ceiling reading is retracted.

-- Q1 — per-generation lifetime distribution, separated (7d + 8-30d cohorts)
with base as (
  select t.id, t.recovered_at, t.recovery_reason, t.status,
    extract(epoch from (t.last_heartbeat_at - t.run_started_at)) as life_s,
    (select count(*) from messages m where m.thread_id=t.id and m.role='assistant') as asst_msgs,
    case when t.created_at >= now()-interval '7 days' then '1_last7d'
         when t.created_at >= now()-interval '30 days' then '2_8to30d' else '3_older' end as cohort
  from threads t
  where t.run_started_at is not null and t.last_heartbeat_at is not null
),
tagged as (
  select *,
    case when recovered_at is not null then 'recovered'
         when recovery_reason like 'stream_error%' then 'stream_err'
         when status='finished' then 'clean'
         when status='active' then 'active' else 'other' end as outcome,
    (asst_msgs > 1) as resumed,
    (life_s < 0 or life_s > 190) as stale
  from base
)
select cohort, outcome, resumed, stale, count(*) n,
  round(min(life_s)::numeric,1) min,
  round(percentile_cont(0.5)  within group (order by life_s)::numeric,1) p50,
  round(percentile_cont(0.75) within group (order by life_s)::numeric,1) p75,
  round(percentile_cont(0.90) within group (order by life_s)::numeric,1) p90,
  round(percentile_cont(0.95) within group (order by life_s)::numeric,1) p95,
  round(percentile_cont(0.99) within group (order by life_s)::numeric,1) p99,
  round(max(life_s)::numeric,1) max
from tagged
where cohort in ('1_last7d','2_8to30d')
group by 1,2,3,4 order by 1,2,3,4;

-- Q2 — top-20 max durations (30d) with timeline signals for single-invocation vs
-- multi-attempt judgement. run_to_updated_s >> life_s means the thread aged (later
-- recovery) but the heartbeat span still isolates one generation.
with base as (
  select t.id, t.recovery_reason, t.recovered_at, t.status,
    extract(epoch from (t.last_heartbeat_at - t.run_started_at)) as life_s,
    extract(epoch from (t.updated_at - t.run_started_at)) as run_to_updated_s,
    (select count(*) from messages m where m.thread_id=t.id and m.role='assistant') as asst_msgs,
    (select count(*) from messages m where m.thread_id=t.id and m.role='user') as user_msgs,
    (select count(*) from tool_usage_log tl where tl.thread_id=t.id) as tool_rows
  from threads t
  where t.run_started_at is not null and t.last_heartbeat_at is not null
    and t.created_at >= now()-interval '30 days'
)
select left(id::text,8) as thread, round(life_s::numeric,1) life_s,
  round(run_to_updated_s::numeric,1) run_to_updated_s,
  asst_msgs, user_msgs, tool_rows,
  (recovered_at is not null) as recovered,
  coalesce(left(recovery_reason,32),'(clean)') as recovery_reason
from base order by life_s desc limit 20;

-- Q3 — CIRCULARITY CHECK: is 180s the PLATFORM ceiling, or an artifact of our own
-- deadlineReached truncating the heartbeat at ORCHESTRATOR_WALL_CLOCK_MS? Split the
-- population by the 180s-budget deploy (11126c2, ~2026-07-25 15:54 UTC). BEFORE it the
-- budget was 240s, so our StopCondition could NOT truncate at 180s. Result: the max is
-- STILL 180.0s and 0/58 exceed 180.5s => the ceiling is the platform's, not ours.
with base as (
  select t.id, t.recovered_at, t.recovery_reason, t.status, t.run_started_at,
    extract(epoch from (t.last_heartbeat_at - t.run_started_at)) as life_s
  from threads t
  where t.run_started_at is not null and t.last_heartbeat_at is not null
),
era as (
  select *,
    case when run_started_at < timestamptz '2026-07-25 15:54:00+00'
         then '1_before_180deploy_240budget' else '2_after_180deploy' end as era,
    case when recovered_at is not null then 'recovered'
         when recovery_reason like 'stream_error%' then 'stream_err'
         when status='finished' then 'clean' else 'other' end as outcome
  from base
)
select era, outcome, count(*) n,
  round(percentile_cont(0.5)  within group (order by life_s)::numeric,1) p50,
  round(percentile_cont(0.95) within group (order by life_s)::numeric,1) p95,
  round(max(life_s)::numeric,1) max,
  count(*) filter (where life_s > 180.5) as over_180_5s
from era where outcome in ('recovered','clean')
group by 1,2 order by 1,2;
