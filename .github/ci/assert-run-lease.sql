-- Behavioural assertion for the S1a admission lease (supabase/functions/osint-agent/lib/run-lease.ts).
--
-- The lease is ONE conditional UPDATE on public.threads. Its tests drive the TypeScript
-- through a fake chain; this file drives the SAME predicate on a real Postgres against the
-- schema the migrations just built, so "a live heartbeat refuses, everything else admits,
-- and a second UPDATE after a successful one changes nothing" is proven on the engine
-- that will evaluate it, not on a fake. The WHERE below is the PostgREST rendering of
--   .or("status.is.null,status.neq.active,last_heartbeat_at.is.null,last_heartbeat_at.lt.<cutoff>")
-- plus the version clause the edge code adds (every lease column IS NOT DISTINCT FROM the
-- value it read).
--
-- Everything happens inside a transaction rolled back at the end. Any failure RAISEs,
-- which `--set ON_ERROR_STOP=1` turns into a non-zero exit for the job.

\set ON_ERROR_STOP on

BEGIN;

-- ── anti-vacuous guard ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.threads') IS NULL THEN
    RAISE EXCEPTION 'public.threads is absent — nothing below proves anything';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'threads' AND column_name = 'last_heartbeat_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'threads.last_heartbeat_at is absent — the lease cannot exist'; END IF;
END $$;

INSERT INTO auth.users (id, email) VALUES ('11111111-1111-4111-8111-111111111111', 'a@example.test');

-- One row per predicate case. NOW() is pinned so the 75 s bar is exact.
CREATE TEMP TABLE lease_cases (id uuid, name text, expect_admit boolean);
INSERT INTO lease_cases VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'blank thread (active, heartbeat NULL)',         true),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'active + fresh heartbeat (20 s)',                false),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'active + exactly 75 s (strict <, not stale)',    false),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'active + 76 s (stale)',                          true),
  ('aaaaaaaa-0000-4000-8000-000000000005', 'finished + fresh heartbeat',                     true),
  ('aaaaaaaa-0000-4000-8000-000000000006', 'stopped + fresh heartbeat (stated S1a limit)',   true);
-- No "status NULL" case: threads.status is NOT NULL (measured 2026-10-10 by this file's
-- first CI run), so the `status IS NULL` branch of the predicate is unreachable here. It
-- stays in the filter for a schema that may relax it; it is not evidence for anything.

INSERT INTO public.threads (id, user_id, title, status, run_started_at, last_heartbeat_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c1', 'active',   NULL, NULL),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'c2', 'active',   now() - interval '30 s', now() - interval '20 s'),
  ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'c3', 'active',   now() - interval '90 s', now() - interval '75 s'),
  ('aaaaaaaa-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'c4', 'active',   now() - interval '90 s', now() - interval '76 s'),
  ('aaaaaaaa-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'c5', 'finished', now() - interval '90 s', now() - interval '1 s'),
  ('aaaaaaaa-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'c6', 'stopped',  now() - interval '90 s', now() - interval '1 s');

-- The lease as the edge function issues it (admission clause + version clause), as a function
-- so every case runs the identical statement.
CREATE OR REPLACE FUNCTION pg_temp.take_lease(p_thread uuid, p_user uuid, p_now timestamptz)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE seen public.threads%ROWTYPE; n int;
BEGIN
  SELECT * INTO seen FROM public.threads WHERE id = p_thread;
  UPDATE public.threads
     SET status = 'active', run_started_at = p_now, last_heartbeat_at = p_now,
         recovered_at = NULL, recovery_reason = NULL, updated_at = p_now
   WHERE id = p_thread AND user_id = p_user
     AND (status IS NULL OR status <> 'active' OR last_heartbeat_at IS NULL
          OR last_heartbeat_at < p_now - make_interval(secs => 75))
     AND status            IS NOT DISTINCT FROM seen.status
     AND run_started_at    IS NOT DISTINCT FROM seen.run_started_at
     AND last_heartbeat_at IS NOT DISTINCT FROM seen.last_heartbeat_at
     AND recovered_at      IS NOT DISTINCT FROM seen.recovered_at
     AND recovery_reason   IS NOT DISTINCT FROM seen.recovery_reason;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ── 1. predicate matrix ──────────────────────────────────────────────────────
DO $$
DECLARE c record; got int; t timestamptz := now();
BEGIN
  FOR c IN SELECT * FROM lease_cases ORDER BY id LOOP
    got := pg_temp.take_lease(c.id, '11111111-1111-4111-8111-111111111111', t);
    IF (got = 1) <> c.expect_admit THEN
      RAISE EXCEPTION 'lease predicate: % — expected admit=%, got % row(s)', c.name, c.expect_admit, got;
    END IF;
  END LOOP;
END $$;

-- ── 2. a successful lease refuses the next attempt (same row, same second) ────
DO $$
DECLARE got int; t timestamptz := now();
BEGIN
  got := pg_temp.take_lease('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', t);
  IF got <> 0 THEN RAISE EXCEPTION 'second lease on a just-leased row must change 0 rows, changed %', got; END IF;
END $$;

-- ── 3. the version clause refuses when the row changed under the read ─────────
DO $$
DECLARE seen public.threads%ROWTYPE; n int; t timestamptz := now();
BEGIN
  -- Read a stale-active row (admissible) …
  SELECT * INTO seen FROM public.threads WHERE id = 'aaaaaaaa-0000-4000-8000-000000000004';
  -- … then a terminal write lands before the lease UPDATE (review finding 2) …
  UPDATE public.threads SET status = 'finished', last_heartbeat_at = t WHERE id = seen.id;
  -- … so the UPDATE built from the stale read must match NOTHING.
  UPDATE public.threads
     SET status = 'active', run_started_at = t, last_heartbeat_at = t, recovered_at = NULL, recovery_reason = NULL
   WHERE id = seen.id
     AND (status IS NULL OR status <> 'active' OR last_heartbeat_at IS NULL OR last_heartbeat_at < t - make_interval(secs => 75))
     AND status            IS NOT DISTINCT FROM seen.status
     AND run_started_at    IS NOT DISTINCT FROM seen.run_started_at
     AND last_heartbeat_at IS NOT DISTINCT FROM seen.last_heartbeat_at
     AND recovered_at      IS NOT DISTINCT FROM seen.recovered_at
     AND recovery_reason   IS NOT DISTINCT FROM seen.recovery_reason;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'version clause: a stale read leased a row that had changed (% rows)', n; END IF;
  -- The finished row is still finished: nothing to resurrect.
  PERFORM 1 FROM public.threads WHERE id = seen.id AND status = 'finished';
  IF NOT FOUND THEN RAISE EXCEPTION 'version clause: the finished row was altered'; END IF;
END $$;

-- ── 4. cross-user refusal ──────────────────────────────────────────────────────
DO $$
DECLARE got int;
BEGIN
  got := pg_temp.take_lease('aaaaaaaa-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222222', now());
  IF got <> 0 THEN RAISE EXCEPTION 'another user leased a thread they do not own'; END IF;
END $$;

ROLLBACK;

\echo 'run lease assertions: all passed.'
