-- 2026-09-22 — call-to-artifact lineage (SCHEMA ONLY; no writer ships with this).
--
-- WHY: measured 2026-09-13 against the live DB, `artifacts` has NO join key to
-- `tool_usage_log`. The closest thing is `metadata.tool`, present on 714 of 1,868
-- recent artifacts — 38%, and only on auto-persisted rows; anything from
-- `record_finding` / `record_artifacts` carries nothing. It stores a tool NAME, not
-- a call id, so it cannot say which of 74 `minimax_correlate` calls produced a row
-- and cannot be joined at all.
--
-- The consequence is the one that matters: we can measure how often a tool returned
-- HTTP 200, and how many artifacts exist, but NOT how often a source produced
-- something an analyst kept. Operational memory, per-dork yield, EV ordering and the
-- "15 false positives" ask are all blocked on this. It is a prerequisite, not a
-- nice-to-have, and it comes before any learning code.
--
-- ⚠️ SHAPE: a JUNCTION TABLE, never an array of artifact ids on the call row.
-- PostgREST renders `.in()` into the URL query string, so a ~5,000-uuid filter is a
-- ~185 KB URL against a ~24 KB gateway cap — the exact failure that stopped the
-- cache sweep from ever deleting a row. Reading a junction by `call_id` or
-- `artifact_id` is an indexed lookup with no such ceiling.
--
-- PRIVACY: this table stores selector TYPE ('email', 'username', 'domain', …), never
-- a selector VALUE. That is deliberate and load-bearing in two directions: it keeps
-- case data out of a table whose whole purpose is CROSS-case analytics, and it makes
-- the analytics legal to run at all. No tool output, no artifact value, no free text.
--
-- FAIL-OPEN BY CONSTRUCTION: there is deliberately NO foreign key from `call_id` to
-- `tool_usage_log.call_id`, and none from `run_id` to `orchestrator_invocations.id`.
-- A FK would make a lineage write depend on a telemetry write having already
-- succeeded, so a telemetry fault would cascade into evidence persistence and cost
-- the analyst a finding. Lineage is an observability join, not an integrity
-- boundary. `artifact_id` DOES cascade from `artifacts`, so deleting a case's
-- evidence never strands its lineage.

-- ---- 1. Stable identifiers on the call row ------------------------------------
-- Both are nullable with no backfill: the 15,136 existing rows (back to 2026-06-08)
-- predate the writer and must stay readable. A NULL here means "written before
-- lineage", which is a fact, not a defect — any query that treats NULL as an error
-- is asking the wrong question.
ALTER TABLE public.tool_usage_log
  ADD COLUMN IF NOT EXISTS call_id uuid,
  ADD COLUMN IF NOT EXISTS run_id  uuid;

COMMENT ON COLUMN public.tool_usage_log.call_id IS
  'Stable per-call id minted by the edge wrapper, so an artifact can name the exact '
  'call that produced it. NULL on rows written before lineage shipped.';
COMMENT ON COLUMN public.tool_usage_log.run_id IS
  'Groups the calls of one orchestrator invocation. Matches '
  'orchestrator_invocations.id when telemetry wrote a row; NOT a foreign key, so a '
  'telemetry failure can never fail a tool call.';

-- Partial + UNIQUE: uniqueness must bind for real ids without the legacy NULLs
-- colliding (in Postgres NULLs are distinct, but the partial index also keeps the
-- index off 15k rows that can never match).
CREATE UNIQUE INDEX IF NOT EXISTS tool_usage_log_call_id_uniq
  ON public.tool_usage_log (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_usage_log_run_idx
  ON public.tool_usage_log (run_id, created_at) WHERE run_id IS NOT NULL;

-- ---- 2. The junction ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.artifact_tool_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES public.artifacts (id) ON DELETE CASCADE,
  -- Intentionally NOT a foreign key — see the fail-open note above.
  call_id uuid NOT NULL,
  run_id uuid,
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- Denormalised so the junction answers "which tool produced kept evidence?"
  -- without a join, and so it survives a tool_usage_log purge.
  tool_name text NOT NULL,
  -- Selector TYPE only. Never a selector value. See the privacy note above.
  selector_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_tool_lineage_size_bounds CHECK (
    char_length(tool_name) <= 128 AND
    char_length(coalesce(selector_type, '')) <= 64
  )
);

-- The write path is "record this artifact came from this call", which a retry or a
-- re-persist can repeat. Uniqueness makes the write idempotent, so the writer can
-- upsert and never needs a read-then-write race.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_tool_lineage_pair_uniq
  ON public.artifact_tool_lineage (artifact_id, call_id);
CREATE INDEX IF NOT EXISTS artifact_tool_lineage_call_idx
  ON public.artifact_tool_lineage (call_id);
CREATE INDEX IF NOT EXISTS artifact_tool_lineage_thread_idx
  ON public.artifact_tool_lineage (thread_id, created_at DESC);
-- The yield question — "how often did this tool produce evidence that was kept?" —
-- reads by tool over time, across cases.
CREATE INDEX IF NOT EXISTS artifact_tool_lineage_tool_idx
  ON public.artifact_tool_lineage (tool_name, created_at DESC);

ALTER TABLE public.artifact_tool_lineage ENABLE ROW LEVEL SECURITY;

-- SELECT only for `authenticated`. The writer is the edge function, which holds
-- service_role: an analyst reads their own lineage and can never forge it. There is
-- deliberately no INSERT/UPDATE/DELETE policy, so those are denied to every client
-- role by RLS default-deny, not merely ungranted.
GRANT SELECT ON public.artifact_tool_lineage TO authenticated;
GRANT ALL    ON public.artifact_tool_lineage TO service_role;

CREATE POLICY "Users view own artifact lineage" ON public.artifact_tool_lineage
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

COMMENT ON TABLE public.artifact_tool_lineage IS
  'Junction: which tool CALL produced which artifact. Selector TYPE only, never a '
  'selector value — this table is read across cases. No tool output and no artifact '
  'value. Written best-effort by the edge function under service_role; a failed '
  'write must never fail the artifact write that preceded it.';
