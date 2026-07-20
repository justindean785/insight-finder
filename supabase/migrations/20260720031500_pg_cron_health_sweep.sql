-- Scheduled recovery sweep — replaces sole reliance on client-triggered
-- `?health=1` polling for stale-run recovery / report-refresh.
--
-- WHY: osint-agent's health-handler.ts already runs recoverStaleActiveThreads()
-- and refreshFinishedThreadReports() on every unauthenticated GET .../osint-agent?health=1
-- request (see supabase/functions/osint-agent/health-handler.ts). Today the ONLY
-- caller of that endpoint is the browser tab (ChatWindow.tsx's 30s sweep + the
-- pre-flight probe on thread open) — so recovery silently stops the moment the
-- tab backgrounds or the device sleeps (confirmed root cause: mobile Safari
-- suspends background-tab timers/WebSocket, not a broken recovery mechanism).
-- A DB-native cron tick removes that dependency entirely: recovery now runs on
-- a fixed cadence regardless of whether anyone has the app open.
--
-- Cadence: every 60s (pg_cron's minimum granularity), which comfortably beats
-- STALE_RUN_AFTER_MS (75s) — a run going stale is swept within ~60-120s either
-- way, matching (not exceeding) the responsiveness the client-side 30s poll
-- already provided while a tab was open.
--
-- net.http_get is fire-and-forget from Postgres's perspective (the request is
-- queued by pg_net's background worker and returns immediately); the recovery
-- sweep runs synchronously inside the edge function's request handler exactly
-- as it does for a real browser-triggered probe, so this reuses the existing,
-- already-tested recovery code path unchanged — no new endpoint, no duplicated
-- sweep logic.
--
-- Guarded on pg_available_extensions so this migration also applies cleanly in
-- CI (a throwaway vanilla postgres:15 container with neither extension binary
-- installed) — see .github/ci/supabase-platform-shim.sql, which stubs
-- cron.schedule/cron.unschedule/net.http_get so the scheduling call below is
-- still syntax-checked by CI even when the real extensions are unavailable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'osint-agent-health-sweep') THEN
    PERFORM cron.unschedule('osint-agent-health-sweep');
  END IF;
END $$;

SELECT cron.schedule(
  'osint-agent-health-sweep',
  '* * * * *',
  $cron$
  SELECT net.http_get(
    url := 'https://skzqwbyvmwqarfgfvyky.supabase.co/functions/v1/osint-agent?health=1',
    headers := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $cron$
);
