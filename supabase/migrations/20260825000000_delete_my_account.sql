-- Self-service account deletion (issue #476 — CCPA/GDPR beta blocker).
--
-- WHY AN RPC AND NOT AN EDGE FUNCTION. A new edge function would be a fourth
-- deploy target on a path that, for everything except osint-agent, has NO health
-- endpoint and NO build marker — there is literally no instrument to tell synced
-- from deployed (see CLAUDE.md). A SECURITY DEFINER function ships with the
-- migrations, is exercised by CI's real-psql job, and is covered by CI's existing
-- assertion that no SECURITY DEFINER function is executable by anon/PUBLIC.
--
-- WHAT IT DELETES. Every row keyed to the caller across the 16 deletable tables,
-- then the auth user itself (which cascades user_credits and user_roles).
--
-- WHAT IT DELIBERATELY DOES NOT DELETE — read this before "fixing" it.
-- public.analyst_feedback_events is append-only BY DESIGN: BEFORE UPDATE,
-- BEFORE DELETE and BEFORE TRUNCATE triggers raise for EVERY caller, service_role
-- included (20260717000000_analyst_feedback_events.sql), because it is a
-- per-thread hash-chained integrity record. Deleting or rewriting a user's rows
-- there is impossible without disabling that control, and the retention decision
-- was made explicitly rather than by working around it: the log is RETAINED and
-- the UI says so before the analyst confirms.
--
-- So do not add analyst_feedback_events to the list below expecting it to work —
-- it will raise and abort the whole deletion, leaving the account half-removed.
-- Changing that requires re-opening the retention decision, not a code change.
--
-- The function is deliberately caller-scoped: it takes NO user id and derives
-- everything from auth.uid(), so it cannot be aimed at another account even by a
-- caller who controls its arguments.

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  _uid uuid := auth.uid();
  _deleted jsonb := '{}'::jsonb;
  _n bigint;
  _retained bigint := 0;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'delete_my_account requires an authenticated caller';
  END IF;

  -- Child-before-parent. artifacts and messages also carry ON DELETE CASCADE
  -- from threads, so their explicit deletes are redundant but harmless — and
  -- they keep the per-table counts in the receipt honest rather than showing 0
  -- for rows the cascade removed.
  DELETE FROM public.artifact_reviews        WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('artifact_reviews', _n);

  DELETE FROM public.evidence_log            WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('evidence_log', _n);

  DELETE FROM public.investigator_notes      WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('investigator_notes', _n);

  DELETE FROM public.memory_merge_candidates WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('memory_merge_candidates', _n);

  DELETE FROM public.tool_usage_log          WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('tool_usage_log', _n);

  DELETE FROM public.tool_call_cache         WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('tool_call_cache', _n);

  DELETE FROM public.investigation_cache     WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('investigation_cache', _n);

  DELETE FROM public.artifacts               WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('artifacts', _n);

  DELETE FROM public.messages                WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('messages', _n);

  DELETE FROM public.agent_memory            WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('agent_memory', _n);

  DELETE FROM public.security_tests          WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('security_tests', _n);

  DELETE FROM public.client_errors           WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('client_errors', _n);

  -- Threads last among the case data: the cascades above hang off it.
  DELETE FROM public.threads                 WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('threads', _n);

  DELETE FROM public.profiles                WHERE user_id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('profiles', _n);

  -- Report, do not delete. Counted so the receipt states exactly what survives
  -- rather than leaving the analyst to assume everything went.
  SELECT count(*) INTO _retained
    FROM public.analyst_feedback_events WHERE analyst_id = _uid;

  -- user_credits and user_roles carry ON DELETE CASCADE to auth.users, so this
  -- removes them along with the login itself. Last: once the auth row is gone
  -- the caller's auth.uid() no longer resolves.
  DELETE FROM auth.users WHERE id = _uid;
  GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('auth_users', _n);

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', _deleted,
    'retained', jsonb_build_object(
      'analyst_feedback_events', _retained,
      'reason', 'append-only integrity log; retained by design and disclosed before confirmation'
    )
  );
END;
$$;

-- anon must never reach this. CI asserts no SECURITY DEFINER function is
-- executable by anon/PUBLIC; this REVOKE is what makes that assertion pass for
-- the most destructive function in the schema.
REVOKE ALL ON FUNCTION public.delete_my_account() FROM public;
REVOKE ALL ON FUNCTION public.delete_my_account() FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

COMMENT ON FUNCTION public.delete_my_account() IS
  'Self-service account deletion (#476). Caller-scoped via auth.uid(); takes no arguments so it cannot be aimed at another account. Deletes the caller''s rows across all user-keyed tables and the auth user. Deliberately RETAINS public.analyst_feedback_events, which is append-only by design.';
