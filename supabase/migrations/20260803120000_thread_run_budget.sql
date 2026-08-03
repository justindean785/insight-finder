-- Thread-scoped run budget (2026-08-03)
--
-- WHY THIS EXISTS
-- ---------------
-- `runtime-policy.ts` enforces the runaway-cost backstops (MAX_TOTAL_CALLS /
-- MAX_PAID_CALLS / MAX_SAME_TOOL_CALLS) against counters held in a module-scope
-- `Map` inside the edge-function isolate. `index.ts` calls `clearRuntime(threadId)`
-- at the top of EVERY request, so the counters were reset on every invocation —
-- including the "Continue" the analyst sends after a run is CPU-killed at the 180s
-- isolate ceiling. The documented cap of "12 paid calls per investigation" was in
-- fact "12 paid calls per HTTP request", i.e. unbounded: an investigation that took
-- three Continues had a real ceiling of 36 and measured 32.
--
-- Making the counters durable moves the cap back to where the constants claim it
-- is — the investigation. That is a spend control, so it does NOT live on
-- `public.threads`: the "Users update own threads" RLS policy has no column
-- restriction, so a tenant could reset their own budget with one PATCH. It lives in
-- its own table, readable by the owner and writable only by the service role.
--
-- BACKFILL
-- --------
-- Existing threads start at zero. The historically-correct figure could be
-- reconstructed from `tool_usage_log`, but doing so would retroactively exhaust the
-- budget of every long-running thread the analyst may still want to continue. Zero
-- is the honest, one-time-generous default: each pre-existing thread gets one full
-- budget from here on, and every thread created after this migration is accounted
-- for from its first call.

CREATE TABLE IF NOT EXISTS public.thread_run_budget (
  thread_id   uuid PRIMARY KEY REFERENCES public.threads(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  total_calls integer     NOT NULL DEFAULT 0,
  paid_calls  integer     NOT NULL DEFAULT 0,
  -- { "<tool_name>": <calls this investigation> } — backs MAX_SAME_TOOL_CALLS.
  tool_counts jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_thread_run_budget_user
  ON public.thread_run_budget(user_id, updated_at DESC);

ALTER TABLE public.thread_run_budget ENABLE ROW LEVEL SECURITY;

-- The owner may READ their own spend (the UI can show "18 of 36 paid calls used").
DROP POLICY IF EXISTS "Users view own run budget" ON public.thread_run_budget;
CREATE POLICY "Users view own run budget" ON public.thread_run_budget
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- DELIBERATELY NO INSERT / UPDATE / DELETE POLICY for `authenticated`.
-- This table is a spend control, not user data. With RLS enabled and no
-- write policy, every tenant write is refused; the edge function writes it
-- through the service role, which bypasses RLS.

COMMENT ON TABLE public.thread_run_budget IS
  'Durable per-investigation tool-call budget. Survives an isolate kill and a "Continue"; enforced by osint-agent/runtime-policy.ts. Service-role write only.';
COMMENT ON COLUMN public.thread_run_budget.total_calls IS 'Tool calls admitted this investigation (all tiers). Backs MAX_TOTAL_CALLS.';
COMMENT ON COLUMN public.thread_run_budget.paid_calls IS 'Non-free tool calls admitted this investigation. Backs MAX_PAID_CALLS.';
COMMENT ON COLUMN public.thread_run_budget.tool_counts IS 'Per-tool call counts this investigation. Backs MAX_SAME_TOOL_CALLS.';

-- ---------------------------------------------------------------------------
-- Element-wise max merge for {tool: count} maps.
--
-- Two overlapping runs on one thread (double-submit, or a retry that starts
-- before the previous isolate has died) each hold their own in-memory counters
-- and each write back. A last-writer-wins UPDATE would let the slower run's
-- smaller number erase the faster run's spend — which hands budget back, the
-- exact bug this migration exists to close. Every field therefore merges with
-- GREATEST, so a write can only ever move a counter UP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jsonb_int_max_merge(a jsonb, b jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      k,
      GREATEST(
        COALESCE(NULLIF(a ->> k, '')::numeric, 0),
        COALESCE(NULLIF(b ->> k, '')::numeric, 0)
      )
    ),
    '{}'::jsonb
  )
  FROM (
    SELECT jsonb_object_keys(COALESCE(a, '{}'::jsonb)) AS k
    UNION
    SELECT jsonb_object_keys(COALESCE(b, '{}'::jsonb))
  ) keys;
$$;

COMMENT ON FUNCTION public.jsonb_int_max_merge(jsonb, jsonb) IS
  'Union of two {key: number} objects keeping the LARGER value per key. Used so a budget write can never lower a counter.';

-- ---------------------------------------------------------------------------
-- bump_thread_run_budget — the only write path.
--
-- Monotonic by construction (see above). Idempotent: replaying the same
-- snapshot is a no-op, so the edge function can fire-and-forget it after every
-- admitted call and coalesce freely without risking a double-count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_thread_run_budget(
  p_thread_id   uuid,
  p_total       integer,
  p_paid        integer,
  p_tool_counts jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT t.user_id INTO v_user_id FROM public.threads t WHERE t.id = p_thread_id;
  -- Unknown thread: nothing to account against. Silent no-op rather than an
  -- error, because this is called fire-and-forget from a tool-admission path
  -- that must never fail a call over telemetry.
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.thread_run_budget AS b
    (thread_id, user_id, total_calls, paid_calls, tool_counts, updated_at)
  VALUES
    (p_thread_id, v_user_id, GREATEST(COALESCE(p_total, 0), 0), GREATEST(COALESCE(p_paid, 0), 0),
     COALESCE(p_tool_counts, '{}'::jsonb), now())
  ON CONFLICT (thread_id) DO UPDATE SET
    total_calls = GREATEST(b.total_calls, EXCLUDED.total_calls),
    paid_calls  = GREATEST(b.paid_calls,  EXCLUDED.paid_calls),
    tool_counts = public.jsonb_int_max_merge(b.tool_counts, EXCLUDED.tool_counts),
    updated_at  = now();
END;
$$;

COMMENT ON FUNCTION public.bump_thread_run_budget(uuid, integer, integer, jsonb) IS
  'Monotonically raise a thread run budget. Service-role only — an authenticated caller must not be able to move their own spend counters.';

-- ---------------------------------------------------------------------------
-- reset_thread_run_budget — OPS ONLY. Nothing in osint-agent calls this.
--
-- A thread IS an investigation in this product, so a genuinely new investigation
-- is a new thread and starts at zero from the column defaults. There is no
-- automatic reset path on purpose: every reset that fires on a continuation is a
-- budget that does not exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_thread_run_budget(p_thread_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.thread_run_budget WHERE thread_id = p_thread_id;
$$;

COMMENT ON FUNCTION public.reset_thread_run_budget(uuid) IS
  'Ops-only budget reset. Not called by osint-agent — an automatic reset on continuation is what made the cap unbounded in the first place.';

-- Neither write function is callable by a tenant. The owner reads spend through
-- the SELECT policy above; only the service role may move it.
REVOKE ALL ON FUNCTION public.bump_thread_run_budget(uuid, integer, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_thread_run_budget(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_thread_run_budget(uuid, integer, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_thread_run_budget(uuid) TO service_role;
