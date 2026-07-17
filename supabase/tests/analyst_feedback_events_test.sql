-- Behavioral tests for the analyst_feedback_events milestone.
-- Run against a migrated database (see docs/CALIBRATION_MILESTONE.md):
--   psql -f .github/ci/supabase-platform-shim.sql
--   for m in supabase/migrations/*.sql; do psql -f "$m"; done
--   psql --set ON_ERROR_STOP=1 -f supabase/tests/analyst_feedback_events_test.sql
-- Any failed assertion RAISEs and aborts with a non-zero exit under ON_ERROR_STOP=1.

\set ON_ERROR_STOP on
\set A '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'
\set TA 'aaaaaaaa-0000-0000-0000-000000000001'
\set TB 'bbbbbbbb-0000-0000-0000-000000000001'
\set FA 'aaaaaaaa-0000-0000-0000-0000000000f1'
\set FB 'bbbbbbbb-0000-0000-0000-0000000000f1'

-- ---- Seed as superuser (bypasses RLS) ------------------------------------
RESET ROLE;
INSERT INTO public.threads(id, user_id) VALUES (:'TA', :'A'), (:'TB', :'B');
INSERT INTO public.artifacts(id, thread_id, user_id, kind, value, confidence, source)
VALUES (:'FA', :'TA', :'A', 'email', 'a@example.com', 62, 'oathnet_lookup'),
       (:'FB', :'TB', :'B', 'email', 'b@example.com', 41, 'leakcheck_lookup');

-- ==========================================================================
-- 1. Happy path: user A records a confirm on their own artifact.
-- ==========================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
SELECT set_config('request.jwt.claims', json_build_object('sub', :'A', 'role', 'authenticated')::text, false);

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.record_analyst_feedback(
    'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',
    'confirm','new','confirmed',NULL,62,62,'2026-07-17.baseline','{"source":"oathnet_lookup"}'::jsonb);
  IF r.deduped THEN RAISE EXCEPTION 'FAIL 1: first write should not be deduped'; END IF;
  IF r.seq <> 1 THEN RAISE EXCEPTION 'FAIL 1: seq should be 1, got %', r.seq; END IF;
  RAISE NOTICE 'PASS 1: happy-path confirm recorded (seq=%)', r.seq;
END $$;

-- ==========================================================================
-- 2. Idempotency: the identical action again is deduped (no new row).
-- ==========================================================================
DO $$
DECLARE r record; c bigint;
BEGIN
  SELECT * INTO r FROM public.record_analyst_feedback(
    'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',
    'confirm','new','confirmed',NULL,62,62,'2026-07-17.baseline','{"source":"oathnet_lookup"}'::jsonb);
  IF NOT r.deduped THEN RAISE EXCEPTION 'FAIL 2: identical repeat should be deduped'; END IF;
  SELECT count(*) INTO c FROM public.analyst_feedback_events WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF c <> 1 THEN RAISE EXCEPTION 'FAIL 2: expected exactly 1 row, got %', c; END IF;
  RAISE NOTICE 'PASS 2: idempotent repeat deduped';
END $$;

-- ==========================================================================
-- 3. A genuinely different action appends a new event (history preserved).
-- ==========================================================================
DO $$
DECLARE r record; c bigint; prior text;
BEGIN
  SELECT * INTO r FROM public.record_analyst_feedback(
    'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',
    'dismiss','confirmed','dismissed','changed my mind',62,62,'2026-07-17.baseline','{}'::jsonb);
  IF r.deduped OR r.seq <> 2 THEN RAISE EXCEPTION 'FAIL 3: expected new event seq=2, got seq=% deduped=%', r.seq, r.deduped; END IF;
  SELECT count(*) INTO c FROM public.analyst_feedback_events WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF c <> 2 THEN RAISE EXCEPTION 'FAIL 3: both events must persist, got %', c; END IF;
  -- prior value preserved on the original confirm row
  SELECT resulting_state INTO prior FROM public.analyst_feedback_events
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1' AND seq=1;
  IF prior <> 'confirmed' THEN RAISE EXCEPTION 'FAIL 3: original event mutated (%),', prior; END IF;
  RAISE NOTICE 'PASS 3: transition appended, prior preserved';
END $$;

-- ==========================================================================
-- 4. Cross-tenant write is rejected (user A cannot touch user B's thread).
-- ==========================================================================
DO $$
BEGIN
  PERFORM public.record_analyst_feedback(
    'bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000f1',
    'confirm','new','confirmed',NULL,41,41,'2026-07-17.baseline','{}'::jsonb);
  RAISE EXCEPTION 'FAIL 4: cross-tenant write should have been rejected';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%not owned%' THEN RAISE NOTICE 'PASS 4: cross-tenant write rejected';
  ELSE RAISE EXCEPTION 'FAIL 4: wrong error: %', SQLERRM; END IF;
END $$;

-- ==========================================================================
-- 5. Artifact/thread mismatch is rejected (artifact belongs to another thread).
-- ==========================================================================
DO $$
BEGIN
  PERFORM public.record_analyst_feedback(
    'aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000f1',
    'confirm','new','confirmed',NULL,41,41,'2026-07-17.baseline','{}'::jsonb);
  RAISE EXCEPTION 'FAIL 5: artifact/thread mismatch should have been rejected';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%does not belong%' THEN RAISE NOTICE 'PASS 5: artifact/thread mismatch rejected';
  ELSE RAISE EXCEPTION 'FAIL 5: wrong error: %', SQLERRM; END IF;
END $$;

-- ==========================================================================
-- 6. Spoofed identity impossible: analyst_id is always auth.uid(), and a direct
--    INSERT by an authenticated client is denied (no INSERT grant).
-- ==========================================================================
DO $$
DECLARE aid uuid;
BEGIN
  SELECT analyst_id INTO aid FROM public.analyst_feedback_events WHERE seq=1
   AND thread_id='aaaaaaaa-0000-0000-0000-000000000001';
  IF aid <> '11111111-1111-1111-1111-111111111111' THEN
    RAISE EXCEPTION 'FAIL 6a: analyst_id not derived from auth.uid(): %', aid; END IF;
  RAISE NOTICE 'PASS 6a: analyst_id derived from auth.uid()';
END $$;

DO $$
BEGIN
  INSERT INTO public.analyst_feedback_events(
    seq, thread_id, artifact_id, analyst_id, action, confidence_model_version,
    content_hash, prev_hash, chain_hash)
  VALUES (99,'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',
    '22222222-2222-2222-2222-222222222222','confirm','x','h','p','c');
  RAISE EXCEPTION 'FAIL 6b: direct client INSERT should be denied';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 6b: direct client INSERT denied';
  WHEN OTHERS THEN RAISE EXCEPTION 'FAIL 6b: unexpected error: %', SQLERRM;
END $$;

-- ==========================================================================
-- 7. Append-only: UPDATE and DELETE are blocked (even as superuser).
-- ==========================================================================
RESET ROLE;
DO $$
BEGIN
  UPDATE public.analyst_feedback_events SET reason='tamper' WHERE seq=1;
  RAISE EXCEPTION 'FAIL 7a: UPDATE should be blocked';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%append-only%' THEN RAISE NOTICE 'PASS 7a: UPDATE blocked';
  ELSE RAISE EXCEPTION 'FAIL 7a: wrong error: %', SQLERRM; END IF;
END $$;
DO $$
BEGIN
  DELETE FROM public.analyst_feedback_events WHERE seq=1;
  RAISE EXCEPTION 'FAIL 7b: DELETE should be blocked';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%append-only%' THEN RAISE NOTICE 'PASS 7b: DELETE blocked';
  ELSE RAISE EXCEPTION 'FAIL 7b: wrong error: %', SQLERRM; END IF;
END $$;
DO $$
BEGIN
  TRUNCATE public.analyst_feedback_events;
  RAISE EXCEPTION 'FAIL 7c: TRUNCATE should be blocked';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%append-only%' THEN RAISE NOTICE 'PASS 7c: TRUNCATE blocked';
  ELSE RAISE EXCEPTION 'FAIL 7c: wrong error: %', SQLERRM; END IF;
END $$;

-- ==========================================================================
-- 8. RLS read isolation: B sees none of A's events; A sees only A's.
-- ==========================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $$
DECLARE c bigint;
BEGIN
  SELECT count(*) INTO c FROM public.analyst_feedback_events;
  IF c <> 0 THEN RAISE EXCEPTION 'FAIL 8a: user B must see 0 of A''s events, saw %', c; END IF;
  RAISE NOTICE 'PASS 8a: RLS hides other tenant''s events';
END $$;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $$
DECLARE c bigint;
BEGIN
  SELECT count(*) INTO c FROM public.analyst_feedback_events;
  IF c <> 2 THEN RAISE EXCEPTION 'FAIL 8b: user A must see own 2 events, saw %', c; END IF;
  RAISE NOTICE 'PASS 8b: analyst sees own events';
END $$;

-- ==========================================================================
-- 9. Calibration views: contradictory + unresolved excluded; final state wins.
-- ==========================================================================
RESET ROLE;
-- Artifact FA's FINAL resolved state is 'dismissed' (seq 2) → y=0, not the earlier confirm.
DO $$
DECLARE yy int;
BEGIN
  SELECT y INTO yy FROM public.v_analyst_feedback_resolved
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF yy <> 0 THEN RAISE EXCEPTION 'FAIL 9a: final resolved y should be 0 (dismiss wins), got %', yy; END IF;
  RAISE NOTICE 'PASS 9a: latest judgment wins (immediately-reversed handled)';
END $$;
-- Model-version reproducibility: the clean view carries the version through.
DO $$
DECLARE v text;
BEGIN
  SELECT DISTINCT confidence_model_version INTO v FROM public.v_analyst_feedback_resolved
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF v <> '2026-07-17.baseline' THEN RAISE EXCEPTION 'FAIL 9b: model version lost: %', v; END IF;
  RAISE NOTICE 'PASS 9b: model version preserved for historical calibration';
END $$;

-- ==========================================================================
-- 10. Chain integrity: prev_hash links each event to the previous per thread.
-- ==========================================================================
DO $$
DECLARE p2 text; c1 text;
BEGIN
  SELECT prev_hash INTO p2 FROM public.analyst_feedback_events
   WHERE thread_id='aaaaaaaa-0000-0000-0000-000000000001' AND seq=2;
  SELECT chain_hash INTO c1 FROM public.analyst_feedback_events
   WHERE thread_id='aaaaaaaa-0000-0000-0000-000000000001' AND seq=1;
  IF p2 <> c1 THEN RAISE EXCEPTION 'FAIL 10: chain broken (seq2.prev != seq1.chain)'; END IF;
  RAISE NOTICE 'PASS 10: hash chain links events';
END $$;

-- ==========================================================================
-- 11. Retraction (reset): appends a retract event that supersedes the prior
--     judgment in the resolved view and drops the artifact from the clean set,
--     while the full immutable history is preserved.
-- ==========================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $$
DECLARE r record; yy int;
BEGIN
  SELECT * INTO r FROM public.record_analyst_feedback(
    'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000f1',
    'retract','dismissed','new',NULL,62,62,'2026-07-17.baseline','{}'::jsonb);
  IF r.deduped OR r.seq <> 3 THEN RAISE EXCEPTION 'FAIL 11a: expected retract seq=3, got seq=% deduped=%', r.seq, r.deduped; END IF;
  SELECT y INTO yy FROM public.v_analyst_feedback_resolved
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF yy IS NOT NULL THEN RAISE EXCEPTION 'FAIL 11a: retracted artifact must be unresolved (y NULL), got %', yy; END IF;
  RAISE NOTICE 'PASS 11a: retract appended and supersedes prior judgment';
END $$;
RESET ROLE;
DO $$
DECLARE cnt bigint; total bigint;
BEGIN
  SELECT count(*) INTO cnt FROM public.v_analyst_feedback_clean
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF cnt <> 0 THEN RAISE EXCEPTION 'FAIL 11b: retracted artifact must be excluded from clean calibration, found %', cnt; END IF;
  SELECT count(*) INTO total FROM public.analyst_feedback_events
   WHERE artifact_id='aaaaaaaa-0000-0000-0000-0000000000f1';
  IF total <> 3 THEN RAISE EXCEPTION 'FAIL 11b: full history must persist (3 events), got %', total; END IF;
  RAISE NOTICE 'PASS 11b: retracted artifact excluded from calibration; full history preserved';
END $$;

SELECT 'ALL ANALYST-FEEDBACK BEHAVIORAL TESTS PASSED' AS result;
