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
  created_at timestamptz NOT NULL DEFAULT now()
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

CREATE POLICY "Anyone can report client errors" ON public.client_errors
  FOR INSERT TO anon, authenticated WITH CHECK (true);
