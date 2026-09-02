-- Nightly sweep of expired `tool_call_cache` rows.
--
-- WHY: measured on the live backend 2026-08-28 — `tool_call_cache` held 11,016
-- rows / 40 MB, of which 10,984 (99.7%) were already expired. That is ~30% of a
-- 136 MB database serving no purpose: an expired row is never a cache hit
-- (cache.ts checks `expires_at` on read), it is just bytes. Nothing has ever
-- deleted them — the only scheduled job in this project is
-- `osint-agent-health-sweep`, and the `delete from public.tool_call_cache`
-- statements in 20260613070000 were one-time migration cleanup, not a recurring
-- sweep. So the table grows without bound for the life of the project.
--
-- ⚠️ `expires_at is null` means NEVER EXPIRES and must never be swept. The
-- explicit `IS NOT NULL` below is INTENT, not mechanism — both rationales that
-- suggest themselves for it were tested here and are false:
--
--   * It is NOT what protects the never-expiring rows. SQL three-valued logic
--     already does: `null < now()` is NULL, not TRUE, so a bare
--     `expires_at < now()` never matches them either. Verified by mutation on a
--     throwaway DB — dropping the guard deleted 0 rows and left the null row
--     standing.
--   * It does NOT unlock `tool_call_cache_expiry_idx` (the partial index on
--     (expires_at) where expires_at is not null, from 20260613070000). With ~98%
--     of rows expired, `EXPLAIN` gives a sequential scan with OR without the
--     guard, and the planner is right to: an index that points at nearly every
--     row is worse than a scan. That index starts earning its keep only in the
--     steady state this job creates, once most rows are live.
--
-- Keep the guard anyway — it states the invariant at the only place someone
-- editing this predicate will look — but do not believe it is doing work it is
-- not doing.
--
-- Bounded per run, as headroom rather than as a fix for a measured problem.
-- Measured on a local throwaway DB loaded to 20,002 rows (~2x current
-- production): the DELETE below removed all 19,600 expired rows in **46.7ms**
-- and left all 401 never-expiring rows in place. So the LIMIT is nowhere near
-- binding today; it exists so that a table left to grow unattended cannot turn
-- this routine job into a long lock.
--
-- Cadence: 03:17 UTC daily. Deliberately off the hour and off the minute so it
-- does not contend with `osint-agent-health-sweep` (which runs at every minute)
-- or with any on-the-hour platform work.
--
-- NOTE ON COST, because this project has been burned by a scheduled job before:
-- the `Edge Health` GitHub Actions cron was removed in #483 after a ~10s curl at
-- */15 was billed as a full minute per run and drained the account's shared
-- Actions allowance, taking CI down for ~70 hours. This job is NOT that: it is
-- in-database pg_cron running a single indexed DELETE, with no runner, no egress
-- and no per-minute billing. It is the same mechanism the health sweep already
-- uses.
--
-- Guarded on pg_available_extensions so this migration also applies cleanly in CI
-- (a throwaway vanilla postgres:15 container with neither extension binary
-- installed) — see .github/ci/supabase-platform-shim.sql, which stubs
-- cron.schedule/cron.unschedule so the scheduling call below is still
-- syntax-checked by CI when the real extension is unavailable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tool-call-cache-expiry-sweep') THEN
    PERFORM cron.unschedule('tool-call-cache-expiry-sweep');
  END IF;
END $$;

SELECT cron.schedule(
  'tool-call-cache-expiry-sweep',
  '17 3 * * *',
  $cron$
  DELETE FROM public.tool_call_cache
  WHERE ctid IN (
    SELECT ctid
    FROM public.tool_call_cache
    WHERE expires_at IS NOT NULL
      AND expires_at < now()
    LIMIT 50000
  );
  $cron$
);
