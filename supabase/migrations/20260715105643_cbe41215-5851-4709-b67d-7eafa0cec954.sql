ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS run_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovered_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_reason text;

CREATE INDEX IF NOT EXISTS idx_threads_active_heartbeat
  ON public.threads(status, last_heartbeat_at, updated_at)
  WHERE status = 'active';

COMMENT ON COLUMN public.threads.run_started_at IS 'Timestamp when the current/last investigation execution began.';
COMMENT ON COLUMN public.threads.last_heartbeat_at IS 'Best-effort heartbeat written by the osint-agent while a run is alive.';
COMMENT ON COLUMN public.threads.recovered_at IS 'Timestamp when a stale active run was closed by recovery logic.';
COMMENT ON COLUMN public.threads.recovery_reason IS 'Reason a stale active run was recovered instead of finalized normally.';