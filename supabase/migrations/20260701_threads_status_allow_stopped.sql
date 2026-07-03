-- Widen threads.status CHECK to allow 'stopped'.
--
-- The frontend Stop button writes threads.status='stopped' and the osint-agent
-- orchestrator's prepareStep polls for status==='stopped' to abort a run
-- (supabase/functions/osint-agent/index.ts). But the original constraint only
-- permitted ('active','finished') (migration
-- 20260527120934_0cc22401-b89e-4304-a52a-a8769f2b3583.sql), so the Stop UPDATE
-- violated the CHECK and threw — the run never aborted, credits kept draining,
-- and the thread stayed 'active'. This widens the allowed set (non-destructive:
-- existing 'active'/'finished' rows remain valid) so Stop takes effect.
--
-- The original constraint was created as an inline column CHECK via ALTER TABLE
-- ADD COLUMN, so Postgres auto-named it `threads_status_check`.

ALTER TABLE public.threads
  DROP CONSTRAINT IF EXISTS threads_status_check;

ALTER TABLE public.threads
  ADD CONSTRAINT threads_status_check
    CHECK (status IN ('active','finished','stopped'));
