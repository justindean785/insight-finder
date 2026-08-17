-- Exclude engine bookkeeping from the per-case artifact count.
--
-- `get_case_metrics` (20260806) counts `count(*) FROM public.artifacts` with no
-- kind filter, so it counts rows that are not observations at all.
--
-- The offender is `cluster_decision`, written by lib/cluster.ts's
-- applyClusteringToThread: value "Deterministic clustering: N subjects, M merges",
-- source "lib/cluster.ts (union-find)", confidence 100. That is the clustering
-- engine logging its own bookkeeping. It carried MORE authority than any real
-- finding — the highest genuine artifact measured in production is 75, the breach
-- cap is 60 and the quarantine ceiling 55, while these sat at 100 with no
-- source_category, no confidence_cap_applied and no subject_unlinked, bypassing
-- every write-path control.
--
-- The frontend already hid them from the artifact LIST (isMetaArtifact in
-- useThreadArtifacts.ts), which is exactly why this went unnoticed: the row was
-- invisible where you would look for it and still counted everywhere a number is
-- shown. All three count surfaces bypassed that filter — this RPC (per-case
-- totals), useInsightsData (Brain totals) and HomeHub (workspace totals).
--
-- The producer is fixed too: clustering telemetry now goes to a structured log
-- line (`event: "clustering_applied"`) instead of the artifacts table, and the
-- summary already reached the caller through the function's return value. This
-- migration is the READ-side half, and it is the half that matters for history:
-- rows already written stay in the table — they are simply no longer counted as
-- evidence. Nothing is deleted. Disclosure, not deletion.
--
-- `triage_decision` is excluded for the same reason and by the same list; keep
-- this in step with META_ARTIFACT_KINDS in src/hooks/useThreadArtifacts.ts.
-- src/test/meta-artifact-kinds.test.ts asserts the two lists match.
--
-- Unchanged from 20260806: SECURITY INVOKER, so the caller's RLS scopes it to
-- their own rows; p_user_id defaults to auth.uid() and cannot read another
-- user's data. Display-only — it never reads or alters evidence VALUES.

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
      -- Engine bookkeeping is not evidence. Keep in step with META_ARTIFACT_KINDS.
      AND kind NOT IN ('triage_decision', 'cluster_decision')
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
