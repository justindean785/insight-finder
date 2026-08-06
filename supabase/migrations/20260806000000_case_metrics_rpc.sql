-- Per-case metrics aggregation RPC.
--
-- The cases list used to fetch artifact / tool_usage_log ROWS and tally them
-- client-side (CasesPage.tsx: two `.select("thread_id").eq("user_id", …)
-- .limit(10000)` queries feeding a Map). Measured on live production
-- 2026-08-06: that account holds 11,610 artifacts and 17,783 tool_usage_log
-- rows, so 1,610 and 7,783 rows (44%) fell outside the window and the threads
-- owning them tallied to ZERO.
--
-- Neither query had an ORDER BY, so WHICH rows survived was planner-dependent:
-- it under-reported by an arbitrary subset, not a predictable tail. Live
-- examples (list showed -> actual): "James JJ mcgovern" 0/0 -> 108/265;
-- "luis rincon" 0/0 -> 37/146; "147.185.221.31:55641" 0/1 -> 23/61 — that
-- last partial count being the tell. Account-wide, 259 of 284 threads hold
-- artifacts while the list rendered many of them empty.
--
-- This counts server-side, so the numbers are exact regardless of volume and
-- the page transfers one row per case instead of ~30,000 rows.
--
-- SECURITY INVOKER, so the caller's RLS on threads / artifacts /
-- tool_usage_log scopes it to their own rows; p_user_id defaults to auth.uid()
-- and, because RLS still applies, cannot be used to read another user's data.
-- Display-only: it never reads or alters evidence VALUES, only counts rows.
-- Mirrors get_insights_summary (20260708), which exists for the same reason.

CREATE OR REPLACE FUNCTION public.get_case_metrics(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (thread_id uuid, artifacts int, tool_calls int)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $func$
  SELECT
    t.id AS thread_id,
    COALESCE(a.n, 0)::int AS artifacts,
    COALESCE(l.n, 0)::int AS tool_calls
  FROM public.threads t
  LEFT JOIN (
    SELECT thread_id, count(*) AS n
    FROM public.artifacts
    WHERE user_id = p_user_id
    GROUP BY thread_id
  ) a ON a.thread_id = t.id
  LEFT JOIN (
    SELECT thread_id, count(*) AS n
    FROM public.tool_usage_log
    WHERE user_id = p_user_id
    GROUP BY thread_id
  ) l ON l.thread_id = t.id
  WHERE t.user_id = p_user_id;
$func$;

GRANT EXECUTE ON FUNCTION public.get_case_metrics(uuid) TO authenticated;
