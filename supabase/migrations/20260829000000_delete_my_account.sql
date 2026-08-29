-- Self-service account deletion (issue #476 — CCPA/GDPR beta blocker).
--
-- WHY AN RPC AND NOT AN EDGE FUNCTION. A new edge function would be a fourth
-- deploy target on a path that, for everything except osint-agent, has NO health
-- endpoint and NO build marker — there is literally no instrument to tell synced
-- from deployed (see CLAUDE.md). A SECURITY DEFINER function ships with the
-- migrations, is exercised by CI's real-psql job, and is covered by CI's existing
-- assertion that no SECURITY DEFINER function is executable by anon/PUBLIC.
--
-- WHAT IT DELETES. Every row keyed to the caller across the 15 user-keyed tables
-- it owns, then the auth user itself (which cascades user_credits and user_roles).
--
-- COVERAGE, verified against the live schema rather than asserted: 18 tables in
-- `public` carry a caller column (user_id / analyst_id). 15 are deleted here,
-- user_credits and user_roles go by ON DELETE CASCADE from auth.users, and
-- analyst_feedback_events is retained by design (below). 15 + 2 + 1 = 18, so the
-- set is total and every table is accounted for in one of the three buckets.
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
--
-- SEARCH_PATH IS EMPTY, ON PURPOSE. `SET search_path = ''` is the maximally safe
-- setting for a SECURITY DEFINER function: with no schemas on the path, an
-- unqualified name cannot be resolved to an attacker-planted object in a schema
-- the caller can write to. It costs nothing here because every reference below is
-- already schema-qualified — `auth.uid()`, `auth.users`, and every `public.*`
-- table. (`pg_catalog` is always searched implicitly even with an empty path, so
-- built-ins like jsonb_build_object, count() and to_regclass still resolve; that
-- is documented Postgres behaviour, not an accident.)
--
-- An earlier revision used `SET search_path = public, auth`, which is explicit but
-- weaker: it is only safe for as long as no role that can call this function also
-- holds CREATE on public or auth. Empty removes that standing dependency
-- altogether, so the property does not have to be re-verified whenever grants
-- change. If you ever add an unqualified reference below, it will fail loudly at
-- run time rather than silently resolving somewhere unexpected — that is the
-- intended failure mode.

-- ─── DELIVERY AND ROLLBACK ──────────────────────────────────────────────────
--
-- DELIVERY. Committing this file does NOT apply it. `supabase db push` is blocked
-- on this project by the Lovable ownership wall (the same wall that 403s
-- `supabase functions deploy`), so the only channel is the Lovable project agent
-- applying it. Ask it to apply THIS migration as-is — it must not author or edit
-- the implementation.
--
-- VERIFY IN PRODUCTION, and do not use the migration ledger to do it. Repo
-- migrations do reach this database without ever gaining a
-- supabase_migrations.schema_migrations row, so ledger absence proves nothing
-- either way. Check the catalog directly:
--
--   SELECT p.prosecdef, p.pronargs, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'delete_my_account';
--   -- expect: prosecdef = t, pronargs = 0, proconfig = {"search_path=public, auth"}
--
--   SELECT has_function_privilege('anon','public.delete_my_account()','EXECUTE'),
--          has_function_privilege('authenticated','public.delete_my_account()','EXECUTE');
--   -- expect: false, true
--
-- ROLLBACK. Two different things are called "rollback" here and they must not be
-- conflated:
--
--   1. SCHEMA rollback — reversible, trivial. This migration creates one function
--      and grants on it, and alters no table, column, constraint or row:
--
--        DROP FUNCTION IF EXISTS public.delete_my_account();
--
--      There is no data to restore because nothing here migrates data, and
--      re-applying is safe (CREATE OR REPLACE plus REVOKE/GRANT are idempotent).
--
--   2. DELETED-DATA recovery — ⚠️ NOT POSSIBLE. Dropping the function stops
--      future deletions; it does not undo one that already ran. A completed
--      deletion is irreversible by construction: the auth row and every
--      user-keyed record are gone, and the function offers no soft-delete, no
--      tombstone and no export. The only recovery is a point-in-time database
--      restore, which is a platform operation, is not part of this migration, and
--      on this Lovable-owned project is not something this repo can perform.
--
-- So: shipping this is low-risk and reversible. ENABLING it for users is neither.
-- Weigh (2), not (1), before exposing the UI path in production.
--
-- POST-DELETION AUTHENTICATION, stated precisely because it is easy to overclaim.
-- Deleting auth.users removes the user's sessions and refresh tokens, so no NEW
-- access token can be minted and every refresh fails. It does NOT cryptographically
-- invalidate an access token that was already issued: a Supabase access token is a
-- stateless signed JWT, so one held by a client stays signature-valid until its own
-- `exp`. What it can still DO in that window is bounded by RLS, and every row it
-- could have reached has just been deleted — but the correct statement is
-- "revoked at the session layer, bounded by token expiry", not "instantly
-- invalidated". The UI signs out to drop the local copy immediately. If a hard
-- upper bound matters for a compliance claim, measure the project's configured
-- access-token TTL and cite that number; do not assert immediacy.

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _uid uuid := auth.uid();  -- auth.uid() is schema-qualified; see search_path note above
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

  -- artifact_linkage_releases: EXISTENCE-GUARDED, and the guard is the point.
  --
  -- This table exists in the production database but NO migration in this repo
  -- creates it, it is absent from the generated types, and no application code
  -- references it. It was created out-of-band. So CI — which builds its schema
  -- purely from supabase/migrations/ — does not have it, while production does.
  -- A plain DELETE here would compile fine (plpgsql resolves table names at run
  -- time, not at CREATE) and then fail at runtime in CI with
  -- "relation does not exist", aborting the whole deletion.
  --
  -- It is deleted rather than left to the cascade because it keys on user_id
  -- independently of thread_id/artifact_id: a release the caller recorded against
  -- a row they do not own would survive an artifacts/threads cascade. Counting it
  -- also keeps the receipt honest instead of silently omitting a table.
  IF pg_catalog.to_regclass('public.artifact_linkage_releases') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.artifact_linkage_releases WHERE user_id = $1' USING _uid;
    GET DIAGNOSTICS _n = ROW_COUNT; _deleted := _deleted || jsonb_build_object('artifact_linkage_releases', _n);
  END IF;

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
