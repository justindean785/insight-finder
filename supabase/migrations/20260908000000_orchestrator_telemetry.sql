-- 2026-09-08 performance audit — PR 1 (Performance telemetry).
--
-- WHY: production forensics (see SESSION_HANDOFF_2026-09-08) found ~45-55% of every
-- orchestrator cycle is spent with ZERO tool activity, but the ONLY way to measure
-- that was hand-deriving gaps between tool_usage_log timestamps across a handful of
-- sampled runs. There is no first-class "how long did the model think on step N" or
-- "how big was the prompt" signal, so the largest measured latency bucket in the
-- system cannot be attributed to prompt growth, tool-schema size, or raw provider
-- latency on any future run. These two tables are that signal: one row per
-- orchestrator invocation (one streamText call — a multi-turn thread gets one per
-- user message) and one row per model step within it.
--
-- PRIVACY: neither table stores prompt or tool-result CONTENT. Every column is a
-- count, a duration, a byte-length, or a short enum/name string (provider id, model
-- id, tool name, finish/stop reason). See supabase/functions/osint-agent/telemetry.ts
-- for the writer and its own privacy note.

CREATE TABLE IF NOT EXISTS public.orchestrator_invocations (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text,
  model_id text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  step_count integer NOT NULL DEFAULT 0,
  tool_call_count integer NOT NULL DEFAULT 0,
  finish_reason text,
  -- One of: natural_stop | finalize_forced | length_limit | budget_exhausted |
  -- stream_error | unknown — see deriveStopReason() in telemetry.ts. Deliberately
  -- coarser than the internal stopWhen state machine so this table can't drift out
  -- of sync with orchestrator-budget.ts / orchestrator-finalize.ts as they evolve.
  stop_reason text NOT NULL DEFAULT 'unknown',
  finalize_started boolean NOT NULL DEFAULT false,
  initial_context_chars integer,
  final_context_chars integer,
  credits_micro_usd bigint,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orchestrator_invocations_stop_reason_check CHECK (
    stop_reason IN ('natural_stop', 'finalize_forced', 'length_limit', 'budget_exhausted', 'stream_error', 'unknown')
  ),
  -- Size backstop against a runaway caller, mirroring client_errors_size_bounds.
  -- The app-side telemetry.ts caps these first; this only rejects gross abuse.
  CONSTRAINT orchestrator_invocations_size_bounds CHECK (
    char_length(coalesce(provider, ''))      <= 128 AND
    char_length(coalesce(model_id, ''))      <= 128 AND
    char_length(coalesce(finish_reason, '')) <= 128 AND
    char_length(coalesce(error_message, '')) <= 500
  )
);

CREATE INDEX IF NOT EXISTS orchestrator_invocations_thread_idx
  ON public.orchestrator_invocations (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_invocations_user_idx
  ON public.orchestrator_invocations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orchestrator_invocations_created_idx
  ON public.orchestrator_invocations (created_at DESC);

ALTER TABLE public.orchestrator_invocations ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.orchestrator_invocations TO authenticated;
GRANT ALL ON public.orchestrator_invocations TO service_role;

CREATE POLICY "Users view own invocation telemetry" ON public.orchestrator_invocations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.orchestrator_step_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id uuid NOT NULL REFERENCES public.orchestrator_invocations (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  step_number integer NOT NULL,
  duration_ms integer,
  context_chars integer,
  input_tokens integer,
  output_tokens integer,
  tool_call_count integer NOT NULL DEFAULT 0,
  tool_names text[] NOT NULL DEFAULT '{}',
  finish_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orchestrator_step_metrics_size_bounds CHECK (
    char_length(coalesce(finish_reason, '')) <= 128 AND
    coalesce(array_length(tool_names, 1), 0) <= 40
  )
);

CREATE INDEX IF NOT EXISTS orchestrator_step_metrics_invocation_idx
  ON public.orchestrator_step_metrics (invocation_id, step_number);
CREATE INDEX IF NOT EXISTS orchestrator_step_metrics_thread_idx
  ON public.orchestrator_step_metrics (thread_id, created_at DESC);

ALTER TABLE public.orchestrator_step_metrics ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.orchestrator_step_metrics TO authenticated;
GRANT ALL ON public.orchestrator_step_metrics TO service_role;

CREATE POLICY "Users view own step telemetry" ON public.orchestrator_step_metrics
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Retention (mirrors purge_client_errors): telemetry must not become an unbounded
-- store the way tool_call_cache did (99.6% expired rows, never swept — 2026-09-08
-- audit). Step rows cascade-delete with their parent invocation, so purging the
-- invocations table alone is sufficient. Service-role only; schedule via pg_cron /
-- ops tooling. Never called from a client.
CREATE OR REPLACE FUNCTION public.purge_orchestrator_telemetry(_days int DEFAULT 30)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (
    DELETE FROM public.orchestrator_invocations
    WHERE created_at < now() - make_interval(days => GREATEST(_days, 1))
    RETURNING 1
  )
  SELECT count(*)::int FROM d;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_orchestrator_telemetry(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_orchestrator_telemetry(int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_orchestrator_telemetry(int) TO service_role;

COMMENT ON TABLE public.orchestrator_invocations IS
  'One row per orchestrator streamText invocation (one per user message/cycle). '
  'No prompt/tool content — counts, durations, byte-lengths, and short enum/name '
  'strings only. Written best-effort/non-blocking by telemetry.ts.';
COMMENT ON TABLE public.orchestrator_step_metrics IS
  'One row per orchestrator model step within an invocation. Same no-content '
  'privacy contract as orchestrator_invocations; context_chars reuses the exact '
  'metric orchestrator-budget.ts''s context trimmer bounds (approxMsgChars).';
