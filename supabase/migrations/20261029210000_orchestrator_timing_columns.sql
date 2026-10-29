-- 2026-10-29 — orchestrator timing columns (telemetry PR 1 of 2: SCHEMA ONLY).
--
-- WHY: 70 forced-finalize runs in 14 days (orchestrator_invocations JOIN
-- orchestrator_step_metrics, measured 2026-10-29) show 891 s of run time that no
-- step row accounts for: duration_ms minus SUM(step_wall_ms) has a median of 3.7 s
-- but a p90 of 50.7 s, and 10 runs carry more than 40 s. 73% of that unattributed
-- time sits in the 10 runs whose final no-tool step was thin (330-689 output
-- tokens against a 2,591 median), which is consistent with the report-salvage
-- backstop in index.ts persistFinalMessages (a second, untimed model call outside
-- the step meter). Nothing durable records whether salvage ran, how long
-- clustering took, or when the loop ended, so the cause cannot be confirmed from
-- stored data. These columns are that record.
--
-- step_wall_ms alone cannot show this: it runs from onStepStart to recordStepFinish
-- (telemetry.ts), so prepareStep work before a step, time between steps, steps that
-- start and never finish, and everything after the loop (persistFinalMessages) fall
-- outside it.
--
-- ORDER IS LOAD-BEARING: apply and verify this migration BEFORE the edge PR that
-- writes these columns. PostgREST rejects an insert that names an unknown column,
-- the parent orchestrator_invocations insert then fails, and EVERY telemetry row for
-- the run is dropped with only a console.warn (telemetry.ts flushParentThenSteps).
-- The edge PR ships a kill switch (TIMING_TELEMETRY_DISABLED=true) that restores
-- the old row shape byte-for-byte, which is the rollback if this lags.
--
-- PRIVACY: same contract as the original telemetry migration
-- (20260908000000_orchestrator_telemetry.sql). Every new column is a millisecond
-- count, a small integer, or one value of a fixed enum. No prompt, tool input,
-- tool result, selector, or report text is stored.
--
-- No grant or RLS change is needed: both tables already carry table-level GRANTs
-- and owner-scoped SELECT policies, which cover added columns. The writer is the
-- service role, as before.
--
-- Additive and nullable. Existing rows read NULL, meaning "not measured".

-- Offsets are milliseconds from invocation start (the recorder's monotonic clock).
ALTER TABLE public.orchestrator_invocations
  ADD COLUMN IF NOT EXISTS first_step_offset_ms integer,
  ADD COLUMN IF NOT EXISTS loop_end_offset_ms   integer,
  ADD COLUMN IF NOT EXISTS persist_ms           integer,
  ADD COLUMN IF NOT EXISTS salvage_ms           integer,
  ADD COLUMN IF NOT EXISTS cluster_ms           integer,
  ADD COLUMN IF NOT EXISTS unfinished_steps     integer,
  ADD COLUMN IF NOT EXISTS salvage_outcome      text;

ALTER TABLE public.orchestrator_invocations
  DROP CONSTRAINT IF EXISTS orchestrator_invocations_timing_bounds;
ALTER TABLE public.orchestrator_invocations
  ADD CONSTRAINT orchestrator_invocations_timing_bounds CHECK (
    coalesce(first_step_offset_ms, 0) >= 0 AND
    coalesce(loop_end_offset_ms, 0)   >= 0 AND
    coalesce(persist_ms, 0)           >= 0 AND
    coalesce(salvage_ms, 0)           >= 0 AND
    coalesce(cluster_ms, 0)           >= 0 AND
    coalesce(unfinished_steps, 0)     >= 0
  );

ALTER TABLE public.orchestrator_invocations
  DROP CONSTRAINT IF EXISTS orchestrator_invocations_salvage_outcome_check;
ALTER TABLE public.orchestrator_invocations
  ADD CONSTRAINT orchestrator_invocations_salvage_outcome_check CHECK (
    salvage_outcome IS NULL OR salvage_outcome IN
      ('none', 'ok', 'empty', 'skipped_budget', 'skipped_reviews', 'error')
  );

ALTER TABLE public.orchestrator_step_metrics
  ADD COLUMN IF NOT EXISTS started_offset_ms integer,
  ADD COLUMN IF NOT EXISTS prepare_ms        integer;

ALTER TABLE public.orchestrator_step_metrics
  DROP CONSTRAINT IF EXISTS orchestrator_step_metrics_timing_bounds;
ALTER TABLE public.orchestrator_step_metrics
  ADD CONSTRAINT orchestrator_step_metrics_timing_bounds CHECK (
    coalesce(started_offset_ms, 0) >= 0 AND
    coalesce(prepare_ms, 0)        >= 0
  );

COMMENT ON COLUMN public.orchestrator_invocations.first_step_offset_ms IS
  'ms from invocation start to the first onStepStart. NULL = not measured or no step started.';
COMMENT ON COLUMN public.orchestrator_invocations.loop_end_offset_ms IS
  'ms from invocation start to the streamText loop ending (onFinish/onAbort). NULL = never reached.';
COMMENT ON COLUMN public.orchestrator_invocations.persist_ms IS
  'ms spent in persistFinalMessages (everything after the loop up to the invocation row being written). The remainder of duration_ms minus this is loop time.';
COMMENT ON COLUMN public.orchestrator_invocations.salvage_ms IS
  'ms spent in the report-salvage backstop (a separate model call outside the step meter). NULL = salvage did not start.';
COMMENT ON COLUMN public.orchestrator_invocations.cluster_ms IS
  'ms spent in applyClusteringToThread at the end of the run. NULL = did not run.';
COMMENT ON COLUMN public.orchestrator_invocations.unfinished_steps IS
  'Steps that fired onStepStart but never reached recordStepFinish when the invocation was written.';
COMMENT ON COLUMN public.orchestrator_invocations.salvage_outcome IS
  'none | ok | empty | skipped_budget | skipped_reviews | error. NULL = timing not measured.';
COMMENT ON COLUMN public.orchestrator_step_metrics.started_offset_ms IS
  'ms from invocation start to this step''s onStepStart. With step_wall_ms it makes the gaps between steps directly visible.';
COMMENT ON COLUMN public.orchestrator_step_metrics.prepare_ms IS
  'ms spent in prepareStep before this step started (includes its threads.status read).';
