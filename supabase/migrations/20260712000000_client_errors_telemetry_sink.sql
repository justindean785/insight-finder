-- Issue #67 (PERF-1): src/lib/telemetry.ts exports setErrorSink() to ship captured
-- errors remotely, but nothing was ever wired to it — errors only ever landed in
-- localStorage + console.error, so production had no remote error visibility.
--
-- Option B (zero-new-dependency Supabase-table sink), not Sentry: this table is the
-- remote destination. src/main.tsx wires setErrorSink() to insert a row here right
-- after installGlobalHandlers(). Columns mirror the CapturedError shape produced by
-- captureError() in telemetry.ts (ts, source, message, stack, url, breadcrumbs, extra).
CREATE TABLE IF NOT EXISTS public.client_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  source text NOT NULL,
  message text NOT NULL,
  stack text,
  url text,
  breadcrumbs jsonb,
  extra jsonb,
  client_ts timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Field-size backstop against a runaway or abusive anon-key caller. The client
  -- caps well below these (see MAX_* in telemetry.ts); this only rejects gross
  -- direct-API abuse. A rejected insert is swallowed by the sink's own try/catch.
  CONSTRAINT client_errors_size_bounds CHECK (
    char_length(source)                 <= 256   AND
    char_length(message)                <= 20000 AND
    char_length(coalesce(stack, ''))    <= 40000 AND
    char_length(coalesce(url, ''))      <= 4096
  )
);

CREATE INDEX IF NOT EXISTS client_errors_created_idx ON public.client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_user_idx ON public.client_errors (user_id);

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Client-side error reporting must work even when the user is logged out (e.g. an
-- error on the Auth page itself), so INSERT is open to anon + authenticated. There is
-- no client-facing SELECT/UPDATE/DELETE — analysts read the raw error table only via
-- the service_role key (dashboard/ops tooling), never through the anon/authenticated
-- client, so no SELECT policy is granted to those roles.
GRANT INSERT ON public.client_errors TO anon, authenticated;
GRANT ALL ON public.client_errors TO service_role;

-- Attribution guard (issue #67 review, P2): with WITH CHECK (true) any caller using
-- the public anon key could post rows against an ARBITRARY user_id and corrupt
-- per-user error triage. Anonymous reporting must still work (user_id IS NULL); an
-- authenticated caller may only claim its OWN uid. For anon, auth.uid() is NULL so
-- only user_id IS NULL passes; a non-null spoofed id fails the check.
CREATE POLICY "Report own or anonymous client errors" ON public.client_errors
  FOR INSERT TO anon, authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());

-- Retention (issue #67 review): a sensitive best-effort log must not become an
-- indefinite store. Rows older than _days are purge-eligible. Service-role only;
-- schedule via pg_cron / ops tooling (e.g. daily). Never called from a client.
CREATE OR REPLACE FUNCTION public.purge_client_errors(_days int DEFAULT 30)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (
    DELETE FROM public.client_errors
    WHERE created_at < now() - make_interval(days => GREATEST(_days, 1))
    RETURNING 1
  )
  SELECT count(*)::int FROM d;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_client_errors(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_client_errors(int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_client_errors(int) TO service_role;
