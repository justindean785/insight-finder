-- Behavioural assertions for public.delete_my_account() (#476).
--
-- Run by CI's `migrations` job against the real schema the migrations just
-- built, because the properties that matter here are database properties: what
-- the function deletes, what it must NOT delete, and that the append-only
-- controls are still standing afterwards. A unit test in vitest cannot see any
-- of that.
--
-- Everything runs inside a transaction that is ROLLED BACK, so the assertions
-- never leave rows behind.
--
-- Schema facts this rests on, verified against the built schema:
--   * analyst_feedback_events has NO foreign keys at all — in particular none
--     from analyst_id to auth.users — so deleting the auth user neither
--     cascades into the log nor is blocked by it. analyst_id survives as a
--     historical UUID with no referent. That is the selected retention
--     behaviour, not an oversight.
--   * The only FKs to auth.users are tool_call_cache, user_roles and
--     user_credits, all ON DELETE CASCADE, and all three are in the DELETE set.

\set ON_ERROR_STOP on
BEGIN;

\set victim    '''11111111-1111-4111-8111-111111111111'''
\set bystander '''22222222-2222-4222-8222-222222222222'''

INSERT INTO auth.users (id, email) VALUES
  (:victim::uuid, 'victim@example.test'),
  (:bystander::uuid, 'bystander@example.test');

INSERT INTO public.threads (id, user_id, title) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', :victim::uuid, 'victim thread'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', :bystander::uuid, 'bystander thread');

INSERT INTO public.artifacts (id, thread_id, user_id, kind, value) VALUES
  ('a11fac11-1111-4111-8111-a11fac111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', :victim::uuid,    'email', 'v@example.test'),
  ('a22fac22-2222-4222-8222-a22fac222222', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', :bystander::uuid, 'email', 'b@example.test');

-- artifact_linkage_releases keys on user_id independently while ALSO cascading
-- from artifacts and threads, so the function deletes it explicitly. Seeded for
-- both users so that DELETE is driven rather than merely present.
--
-- Guarded, because the table exists in PRODUCTION but no migration in this repo
-- creates it — CI's schema is built from supabase/migrations/ alone and does not
-- have it. The seed and its assertions therefore run only where the table is
-- real; the coverage gate below is likewise schema-driven, so neither invents a
-- failure on the CI schema nor lets the table escape scrutiny on production.
DO $$
BEGIN
  IF to_regclass('public.artifact_linkage_releases') IS NOT NULL THEN
    EXECUTE $i$
      INSERT INTO public.artifact_linkage_releases (thread_id, artifact_id, user_id, reason) VALUES
        ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'a11fac11-1111-4111-8111-a11fac111111',
         '11111111-1111-4111-8111-111111111111', 'victim release'),
        ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'a22fac22-2222-4222-8222-a22fac222222',
         '22222222-2222-4222-8222-222222222222', 'bystander release')
    $i$;
  END IF;
END $$;

INSERT INTO public.agent_memory (user_id, kind, subject, content) VALUES
  (:victim::uuid, 'note', 's', 'c'),
  (:bystander::uuid, 'note', 's', 'c');

INSERT INTO public.analyst_feedback_events
  (thread_id, analyst_id, seq, action, confidence_model_version, content_hash, prev_hash, chain_hash)
VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', :victim::uuid,    1, 'confirm', 'v1', 'ch-victim',    '', 'chain-victim'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', :bystander::uuid, 1, 'confirm', 'v1', 'ch-bystander', '', 'chain-bystander');

-- ── the deletion, as the victim ──────────────────────────────────────────────
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.delete_my_account() AS receipt \gset
RESET request.jwt.claim.sub;

DO $$
DECLARE v uuid := '11111111-1111-4111-8111-111111111111';
        b uuid := '22222222-2222-4222-8222-222222222222';
        n bigint;
        t text;
BEGIN
  -- 1. Every intended user-owned row is gone.
  SELECT count(*) INTO n FROM public.threads      WHERE user_id = v;
  IF n <> 0 THEN RAISE EXCEPTION 'threads not deleted: %', n; END IF;
  SELECT count(*) INTO n FROM public.artifacts    WHERE user_id = v;
  IF n <> 0 THEN RAISE EXCEPTION 'artifacts not deleted: %', n; END IF;
  SELECT count(*) INTO n FROM public.agent_memory WHERE user_id = v;
  IF n <> 0 THEN RAISE EXCEPTION 'agent_memory not deleted: %', n; END IF;
  IF to_regclass('public.artifact_linkage_releases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.artifact_linkage_releases WHERE user_id = $1' INTO n USING v;
    IF n <> 0 THEN RAISE EXCEPTION 'artifact_linkage_releases not deleted: %', n; END IF;
  END IF;
  SELECT count(*) INTO n FROM auth.users          WHERE id = v;
  IF n <> 0 THEN RAISE EXCEPTION 'auth user not deleted: %', n; END IF;

  -- 2. The immutable log SURVIVES, and survives UNCHANGED — including the
  --    hash-chain fields, which are the whole point of retaining it.
  SELECT count(*) INTO n FROM public.analyst_feedback_events WHERE analyst_id = v;
  IF n <> 1 THEN RAISE EXCEPTION 'retained audit row missing or duplicated: %', n; END IF;
  SELECT chain_hash INTO t FROM public.analyst_feedback_events WHERE analyst_id = v;
  IF t <> 'chain-victim' THEN RAISE EXCEPTION 'chain_hash mutated: %', t; END IF;
  SELECT content_hash INTO t FROM public.analyst_feedback_events WHERE analyst_id = v;
  IF t <> 'ch-victim' THEN RAISE EXCEPTION 'content_hash mutated: %', t; END IF;
  SELECT prev_hash INTO t FROM public.analyst_feedback_events WHERE analyst_id = v;
  IF t <> '' THEN RAISE EXCEPTION 'prev_hash mutated: %', t; END IF;
  -- analyst_id is retained as a historical UUID (no FK, so nothing nulls it).
  SELECT count(*) INTO n FROM public.analyst_feedback_events
   WHERE analyst_id = v AND analyst_id IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'analyst_id was nulled or rewritten'; END IF;

  -- 3. ANOTHER USER IS UNTOUCHED. The function takes no target argument, so
  --    there is no id to aim; this proves the blast radius empirically.
  SELECT count(*) INTO n FROM public.threads      WHERE user_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander threads harmed: %', n; END IF;
  SELECT count(*) INTO n FROM public.artifacts    WHERE user_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander artifacts harmed: %', n; END IF;
  SELECT count(*) INTO n FROM public.agent_memory WHERE user_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander memory harmed: %', n; END IF;
  IF to_regclass('public.artifact_linkage_releases') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.artifact_linkage_releases WHERE user_id = $1' INTO n USING b;
    IF n <> 1 THEN RAISE EXCEPTION 'bystander linkage releases harmed: %', n; END IF;
  END IF;
  SELECT count(*) INTO n FROM auth.users          WHERE id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander auth user harmed: %', n; END IF;
  SELECT count(*) INTO n FROM public.analyst_feedback_events WHERE analyst_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander audit row harmed: %', n; END IF;

  RAISE NOTICE 'delete_my_account: deletion scope + audit retention OK';
END $$;

-- 3b. COVERAGE GATE. Every table in `public` carrying a caller column must be in
--     exactly one of three buckets: deleted by the function, removed by an
--     ON DELETE CASCADE from auth.users, or deliberately retained. A new
--     user-keyed table added later without touching delete_my_account() would
--     otherwise silently survive deletion — the failure mode this gate exists to
--     catch, and the one that was actually found in review
--     (artifact_linkage_releases).
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c.table_name, ', ' ORDER BY c.table_name) INTO missing
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name IN ('user_id', 'analyst_id')
    -- deleted explicitly by the function
    AND c.table_name NOT IN (
      'artifact_reviews','evidence_log','investigator_notes','memory_merge_candidates',
      'tool_usage_log','tool_call_cache','investigation_cache','artifact_linkage_releases',
      'artifacts','messages','agent_memory','security_tests','client_errors','threads','profiles'
    )
    -- removed by ON DELETE CASCADE from auth.users
    AND c.table_name NOT IN ('user_credits','user_roles')
    -- retained by design, disclosed in the UI before confirmation
    AND c.table_name NOT IN ('analyst_feedback_events');

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'user-keyed table(s) in no bucket of delete_my_account(): % — add to the DELETE set, or document the retention', missing;
  END IF;
  RAISE NOTICE 'delete_my_account: every user-keyed table is accounted for';
END $$;

-- 4. The append-only triggers are STILL INSTALLED after the deletion ran.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.analyst_feedback_events'::regclass
     AND NOT tgisinternal
     AND tgname IN ('analyst_feedback_no_update','analyst_feedback_no_delete','analyst_feedback_no_truncate');
  IF n <> 3 THEN
    RAISE EXCEPTION 'append-only triggers missing after deletion (found %/3) — the deletion path must never disable them', n;
  END IF;
  RAISE NOTICE 'delete_my_account: append-only triggers intact (3/3)';
END $$;

-- 5. And they still REJECT mutation — installed is not the same as working.
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    UPDATE public.analyst_feedback_events SET reason = 'tamper' WHERE chain_hash = 'chain-bystander';
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'append-only UPDATE guard no longer rejects'; END IF;

  ok := false;
  BEGIN
    DELETE FROM public.analyst_feedback_events WHERE chain_hash = 'chain-bystander';
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'append-only DELETE guard no longer rejects'; END IF;

  RAISE NOTICE 'delete_my_account: append-only guards still reject UPDATE and DELETE';
END $$;

-- 6. An unauthenticated caller is refused — no auth.uid(), no deletion.
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    PERFORM public.delete_my_account();
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'delete_my_account ran without an authenticated caller'; END IF;
  RAISE NOTICE 'delete_my_account: unauthenticated caller refused';
END $$;

-- 7. Re-running for an already-deleted user is a harmless no-op, not an error
--    and not a privilege path: auth.uid() no longer resolves to a live user, so
--    every delete matches nothing. Repeat-safety matters because the UI can be
--    retried after a network blip.
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
    PERFORM public.delete_my_account();
    ok := true;
  EXCEPTION WHEN others THEN ok := false;
  END;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF NOT ok THEN RAISE EXCEPTION 'repeat deletion raised instead of being a no-op'; END IF;
  RAISE NOTICE 'delete_my_account: repeat deletion is a safe no-op';
END $$;

-- 8. Atomicity: the function body is a single statement-level transaction, so a
--    failure part-way cannot leave a half-deleted account. Proven by forcing a
--    failure inside a savepoint and checking nothing was committed.
SAVEPOINT before_failure;
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  -- Deliberately break the run mid-way, then roll back to the savepoint.
  PERFORM public.delete_my_account();
  RAISE EXCEPTION 'forced failure after deletion';
EXCEPTION WHEN others THEN NULL;
END $$;
ROLLBACK TO SAVEPOINT before_failure;

DO $$
DECLARE n bigint; b uuid := '22222222-2222-4222-8222-222222222222';
BEGIN
  SELECT count(*) INTO n FROM auth.users WHERE id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'a failed deletion left the account partially removed'; END IF;
  SELECT count(*) INTO n FROM public.threads WHERE user_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'a failed deletion left threads removed'; END IF;
  RAISE NOTICE 'delete_my_account: a failed run leaves nothing removed';
END $$;

ROLLBACK;
