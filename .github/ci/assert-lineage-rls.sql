-- CI-ONLY — RLS proofs for public.artifact_tool_lineage.
--
-- The review asked for write, read, cross-user denial and anonymous denial to be
-- PROVEN before this schema is proposed for deployment. A policy you can read is
-- not a policy you have tested: every assertion here runs against the schema the
-- migrations just built, as the real `anon` / `authenticated` / `service_role`
-- roles, and RAISES on the wrong answer. A vacuous pass is the failure mode this
-- file exists to avoid, so each assertion first proves the row is THERE for
-- service_role before proving it is hidden from someone else.
--
-- Not covered here, because it is code and not schema: the write-failure fallback
-- (a failed lineage insert must never fail the artifact insert that preceded it).
-- That is proven in the writer's own tests, in the PR that adds the writer.

\set ON_ERROR_STOP on

BEGIN;

-- ── anti-vacuous guard ────────────────────────────────────────────────────────
-- Assert the objects EXIST before testing behaviour. Without this, a migration
-- that silently stopped running would sail through several cases below, because
-- a table that does not exist denies `anon` just as convincingly as a correct
-- policy does, and RLS on a missing table is indistinguishable from RLS that
-- works. Every "the wrong caller was refused" assertion needs this.
DO $$
BEGIN
  IF to_regclass('public.artifact_tool_lineage') IS NULL THEN
    RAISE EXCEPTION
      'artifact_tool_lineage is absent — the migration did not run, so nothing below proves anything';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'artifact_tool_lineage'
      AND policyname = 'Users view own artifact lineage'
  ) THEN
    RAISE EXCEPTION 'the SELECT policy is absent — a denial below would prove nothing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'artifact_tool_lineage_pair_uniq'
  ) THEN
    RAISE EXCEPTION 'artifact_tool_lineage_pair_uniq is absent — the idempotency case proves nothing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'tool_usage_log_call_id_uniq'
  ) THEN
    RAISE EXCEPTION 'tool_usage_log_call_id_uniq is absent — the call_id case proves nothing';
  END IF;
END $$;

-- Two users, two threads, two artifacts, two lineage rows.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test');

INSERT INTO public.threads (id, user_id, title) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'case a'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'case b');

INSERT INTO public.artifacts (id, thread_id, user_id, kind, value) VALUES
  ('a5000000-1111-4111-8111-000000000001', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
   '11111111-1111-4111-8111-111111111111', 'email', 'kept@example.test'),
  ('b5000000-2222-4222-8222-000000000002', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
   '22222222-2222-4222-8222-222222222222', 'email', 'other@example.test');

-- ---- 1. WRITE, as service_role (the edge function's role) ----------------------
SET LOCAL ROLE service_role;
INSERT INTO public.artifact_tool_lineage
  (artifact_id, call_id, run_id, thread_id, user_id, tool_name, selector_type) VALUES
  ('a5000000-1111-4111-8111-000000000001', 'c0000000-0000-4000-8000-00000000000a',
   'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
   '11111111-1111-4111-8111-111111111111', 'breach_check', 'email'),
  ('b5000000-2222-4222-8222-000000000002', 'c0000000-0000-4000-8000-00000000000b',
   'd0000000-0000-4000-8000-00000000000b', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
   '22222222-2222-4222-8222-222222222222', 'breach_check', 'email');
RESET ROLE;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.artifact_tool_lineage;
  IF n <> 2 THEN RAISE EXCEPTION 'write: expected 2 lineage rows, got %', n; END IF;
END $$;

-- ---- 2. READ own, as authenticated ---------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.artifact_tool_lineage;
  IF n <> 1 THEN RAISE EXCEPTION 'read own: expected 1 visible row, got %', n; END IF;
  -- ...and it is the RIGHT one, not merely one row.
  SELECT count(*) INTO n FROM public.artifact_tool_lineage
   WHERE call_id = 'c0000000-0000-4000-8000-00000000000a';
  IF n <> 1 THEN RAISE EXCEPTION 'read own: wrong row visible'; END IF;
END $$;

-- ---- 3. CROSS-USER DENIAL ------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.artifact_tool_lineage
   WHERE call_id = 'c0000000-0000-4000-8000-00000000000b';
  IF n <> 0 THEN RAISE EXCEPTION 'cross-user: user A can see user B lineage (% rows)', n; END IF;
END $$;

-- ---- 4. An authenticated client cannot WRITE lineage ----------------------------
-- No INSERT policy exists, so this is denied by RLS default-deny even where the
-- grant would allow it. Forging provenance must be impossible from a client.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.artifact_tool_lineage
      (artifact_id, call_id, thread_id, user_id, tool_name, selector_type)
    VALUES ('a5000000-1111-4111-8111-000000000001', 'c0000000-0000-4000-8000-0000000000ff',
            'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
            'forged', 'email');
    RAISE EXCEPTION 'client write: an authenticated client INSERTED lineage';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $$;
RESET ROLE;

-- ---- 5. ANONYMOUS DENIAL -------------------------------------------------------
-- `anon` has no grant and no policy. Assert the read is refused rather than merely
-- empty: an empty result would also be what a silently-broken assertion returns.
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.artifact_tool_lineage;
    RAISE EXCEPTION 'anon: an unauthenticated caller could SELECT lineage';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;
END $$;
RESET ROLE;

-- ---- 6. Idempotency: the same (artifact, call) pair cannot double-write ---------
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.artifact_tool_lineage
      (artifact_id, call_id, thread_id, user_id, tool_name)
    VALUES ('a5000000-1111-4111-8111-000000000001', 'c0000000-0000-4000-8000-00000000000a',
            'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111',
            'breach_check');
    RAISE EXCEPTION 'idempotency: a duplicate (artifact_id, call_id) was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;
END $$;

-- ---- 7. call_id uniqueness binds, and legacy NULLs still coexist ----------------
INSERT INTO public.tool_usage_log (user_id, thread_id, tool_name, call_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
   'breach_check', 'c0000000-0000-4000-8000-00000000000a');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.tool_usage_log (user_id, thread_id, tool_name, call_id) VALUES
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
       'breach_check', 'c0000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'call_id: a duplicate call_id was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;
END $$;
-- Two legacy rows with NULL call_id must both survive — the partial unique index
-- must not turn "written before lineage" into a constraint violation.
INSERT INTO public.tool_usage_log (user_id, thread_id, tool_name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'legacy_a'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'legacy_b');
RESET ROLE;

-- ---- 8. Deleting an artifact takes its lineage with it -------------------------
DELETE FROM public.artifacts WHERE id = 'a5000000-1111-4111-8111-000000000001';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.artifact_tool_lineage
   WHERE artifact_id = 'a5000000-1111-4111-8111-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'cascade: lineage survived its artifact (% rows)', n; END IF;
END $$;

ROLLBACK;

\echo 'artifact_tool_lineage RLS assertions: all passed.'
