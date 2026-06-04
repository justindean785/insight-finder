
-- Atomic cost increment: avoids read-modify-write race when two runs finish
-- on the same thread (retry + original, multi-tab, etc.).
CREATE OR REPLACE FUNCTION public.increment_thread_cost(_id uuid, _delta_cost bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.threads
     SET cost_micro_usd = cost_micro_usd + GREATEST(_delta_cost, 0),
         credits_used   = credits_used + GREATEST(1, (GREATEST(_delta_cost, 0) / 10000)::int),
         updated_at     = now()
   WHERE id = _id;
$$;

GRANT EXECUTE ON FUNCTION public.increment_thread_cost(uuid, bigint) TO authenticated, service_role;

-- Server-side expiry on investigation_cache. Clients no longer need to filter
-- expires_at > now() (and can't accidentally read stale rows if their clock
-- is wrong).
DROP POLICY IF EXISTS "Users view own cache" ON public.investigation_cache;
CREATE POLICY "Users view own non-expired cache"
  ON public.investigation_cache
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id AND expires_at > now());

-- Hot-path indexes. Artifacts panel and tool-usage audit both scan by
-- thread_id ordered by created_at; without these we do full scans once a
-- thread has more than a few hundred artifacts.
CREATE INDEX IF NOT EXISTS artifacts_thread_created_idx
  ON public.artifacts (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_usage_thread_created_idx
  ON public.tool_usage_log (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_thread_created_idx
  ON public.messages (thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS agent_memory_user_subject_idx
  ON public.agent_memory (user_id, subject);
