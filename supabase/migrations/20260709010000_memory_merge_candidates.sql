-- C-2: audit/decision log for memory_save entries that C-2's consolidation gate
-- (supabase/functions/osint-agent/lib/memory_consolidate.ts) blocked or downgraded to
-- "unresolved" instead of writing to agent_memory. Nothing a memory_save call proposes
-- is ever silently dropped: a blocked cross-subject merge (or a correlate-failure
-- unresolved claim) lands here with the reason, so an analyst can review it.
-- Persistent memory writes stay auditable/reversible per the C-2 brief — this is the
-- decision log; agent_memory's own rows are unaffected (existing behavior unchanged).
CREATE TABLE IF NOT EXISTS public.memory_merge_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  thread_id uuid,
  subject text NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  proposed_confidence integer,
  verdict text NOT NULL CHECK (verdict IN ('blocked', 'unresolved')),
  reason text NOT NULL,
  subject_ids text[] DEFAULT '{}',
  related_values text[] DEFAULT '{}',
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_merge_candidates_user_idx ON public.memory_merge_candidates (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_merge_candidates_thread_idx ON public.memory_merge_candidates (thread_id);
CREATE INDEX IF NOT EXISTS memory_merge_candidates_unreviewed_idx ON public.memory_merge_candidates (user_id) WHERE NOT reviewed;

GRANT SELECT, UPDATE ON public.memory_merge_candidates TO authenticated;
GRANT ALL ON public.memory_merge_candidates TO service_role;
ALTER TABLE public.memory_merge_candidates ENABLE ROW LEVEL SECURITY;
-- Writes go through the service-role admin client only (mirrors investigation_cache) —
-- the edge function is the sole writer; analysts review/mark-reviewed via the client.
CREATE POLICY "Users view own merge candidates" ON public.memory_merge_candidates
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users mark own merge candidates reviewed" ON public.memory_merge_candidates
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
