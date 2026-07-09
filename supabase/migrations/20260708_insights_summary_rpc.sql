-- Insights aggregation RPC.
--
-- The Insights page used to fetch artifact / tool_usage_log ROWS and aggregate
-- them client-side, but PostgREST caps a row fetch at 1,000 regardless of
-- `.limit(...)`. So on any account past 1,000 artifacts the tiles and charts
-- silently under-counted (e.g. "Tool calls 1,000" was a cap, not a total, and
-- "Entities by category" only saw the most-recent 1,000 artifacts).
--
-- This function does the counting server-side (GROUP BY over every row) and
-- returns a single JSON summary. It is SECURITY INVOKER, so the caller's RLS on
-- `artifacts` / `tool_usage_log` scopes it to their own rows; the p_user_id arg
-- defaults to auth.uid() and, because RLS still applies, cannot be used to read
-- another user's data. Display-only: it never reads or alters evidence values.

CREATE OR REPLACE FUNCTION public.get_insights_summary(p_user_id uuid DEFAULT auth.uid())
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $func$
  WITH art AS (
    SELECT kind, source, confidence, created_at, thread_id
    FROM public.artifacts
    WHERE user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'kind_counts', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT kind, count(*)::int AS count FROM art GROUP BY kind ORDER BY count DESC) x), '[]'::jsonb),
    'source_counts', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT source, count(*)::int AS count FROM art WHERE source IS NOT NULL
        GROUP BY source ORDER BY count DESC LIMIT 20) x), '[]'::jsonb),
    'day_counts', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM art WHERE created_at >= now() - interval '14 days' GROUP BY 1) x), '[]'::jsonb),
    'top_cases', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT a.thread_id, t.title, count(*)::int AS artifact_count, max(a.created_at) AS last_at
        FROM art a LEFT JOIN public.threads t ON t.id = a.thread_id
        GROUP BY a.thread_id, t.title ORDER BY artifact_count DESC LIMIT 6) x), '[]'::jsonb),
    'conf_buckets', (SELECT jsonb_build_object(
        'ge80', count(*) FILTER (WHERE confidence >= 80),
        'b50', count(*) FILTER (WHERE confidence >= 50 AND confidence < 80),
        'b20', count(*) FILTER (WHERE confidence >= 20 AND confidence < 50),
        'lt20', count(*) FILTER (WHERE confidence >= 0 AND confidence < 20),
        'unscored', count(*) FILTER (WHERE confidence IS NULL)) FROM art),
    'avg_confidence', COALESCE((SELECT round(avg(confidence))::int FROM art WHERE confidence IS NOT NULL), 0),
    'tool_counts', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT tool_name, count(*)::int AS count, count(*) FILTER (WHERE ok)::int AS ok_count
        FROM public.tool_usage_log WHERE user_id = p_user_id
        GROUP BY tool_name ORDER BY count DESC LIMIT 20) x), '[]'::jsonb),
    'tool_calls_total', COALESCE((SELECT count(*)::int FROM public.tool_usage_log WHERE user_id = p_user_id), 0)
  );
$func$;

GRANT EXECUTE ON FUNCTION public.get_insights_summary(uuid) TO authenticated;
