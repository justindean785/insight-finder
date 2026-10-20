-- Baseline metrics for the agentic-upgrade plan (Phase 0). READ-ONLY, aggregates only.
-- No subject values, no thread/user ids in any output column.
-- Run each statement separately (Supabase SQL editor or the Lovable `query_database` tool).

-- Q1: orchestrator health, last 14 days
select count(*) as invocations,
       round(avg(initial_context_chars)) as avg_initial_context_chars,
       max(initial_context_chars) as max_initial_context_chars,
       round(100.0*avg((stop_reason='natural_stop')::int),1) as pct_natural_stop,
       round(100.0*avg((stop_reason='finalize_forced')::int),1) as pct_finalize_forced,
       round(100.0*avg((stop_reason in ('stream_error') or error_message is not null)::int),1) as pct_error,
       round(avg(duration_ms)/1000.0) as avg_duration_s,
       round((percentile_cont(0.5) within group (order by duration_ms))/1000.0) as median_duration_s,
       round(avg(credits_micro_usd)/1e6, 3) as avg_cost_usd
from public.orchestrator_invocations
where created_at > now() - interval '14 days';

-- Q2: stop_reason distribution, last 14 days
select stop_reason, count(*) from public.orchestrator_invocations
where created_at > now() - interval '14 days' group by 1 order by 2 desc;

-- Q3: findings vs artifacts (lifetime)
-- Never select source/value/metadata: finding-row `source` holds free-text subject PII.
select count(*) filter (where kind='finding') as finding_rows_all,
       count(*) filter (where kind='finding' and metadata ? 'synthesis_cluster_id') as finding_rows_synthesis_origin,
       count(*) filter (where kind='finding' and not (metadata ? 'synthesis_cluster_id')) as finding_rows_model_origin,
       -- Both origins are scored by the same engine chain (lib/finding-row.ts); origin is who reached the conclusion, not whether the engine scored it.
       count(*) as artifact_rows,
       count(distinct thread_id) as threads_with_artifacts,
       (select count(*) from public.threads) as threads_all
from public.artifacts;

-- Q4: analyst labels (lifetime)
select state, count(*) from public.artifact_reviews group by 1 order by 2 desc;

-- Q5: agent_memory kinds and size
select kind, count(*) as rows, sum(char_length(coalesce(content,''))) as chars
from public.agent_memory group by 1 order by 2 desc;

-- Q6: tool_call_cache liveness
select count(*) as rows,
       count(*) filter (where expires_at > now()) as unexpired,
       round(100.0*count(*) filter (where expires_at > now())/nullif(count(*),0),2) as pct_unexpired
from public.tool_call_cache;

-- Q7: tool outcome distribution, last 14 days (confirmed negatives should be 'empty', not 'ok')
select outcome, count(*) from public.tool_usage_log
where created_at > now() - interval '14 days' group by 1 order by 2 desc;
