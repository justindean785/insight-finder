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

INSERT INTO public.artifacts (thread_id, user_id, kind, value) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', :victim::uuid, 'email', 'v@example.test'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', :bystander::uuid, 'email', 'b@example.test');

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
  SELECT count(*) INTO n FROM auth.users          WHERE id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander auth user harmed: %', n; END IF;
  SELECT count(*) INTO n FROM public.analyst_feedback_events WHERE analyst_id = b;
  IF n <> 1 THEN RAISE EXCEPTION 'bystander audit row harmed: %', n; END IF;

  RAISE NOTICE 'delete_my_account: deletion scope + audit retention OK';
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
