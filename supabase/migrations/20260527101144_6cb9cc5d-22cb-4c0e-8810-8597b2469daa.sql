
CREATE TABLE IF NOT EXISTS public.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  subject text NOT NULL,
  subject_kind text,
  related_values text[] DEFAULT '{}',
  content text NOT NULL,
  confidence integer DEFAULT 50,
  source_thread_id uuid,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_memory_user_subject_idx ON public.agent_memory (user_id, subject);
CREATE INDEX IF NOT EXISTS agent_memory_user_kind_idx ON public.agent_memory (user_id, kind);
CREATE INDEX IF NOT EXISTS agent_memory_related_gin ON public.agent_memory USING gin (related_values);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_memory TO authenticated;
GRANT ALL ON public.agent_memory TO service_role;

ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own memory"   ON public.agent_memory FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own memory" ON public.agent_memory FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own memory" ON public.agent_memory FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own memory" ON public.agent_memory FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER agent_memory_updated_at
  BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.tool_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  tool_name text NOT NULL,
  cost_micro_usd integer NOT NULL DEFAULT 0,
  cached boolean NOT NULL DEFAULT false,
  ok boolean NOT NULL DEFAULT true,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_usage_log_thread_idx ON public.tool_usage_log (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_usage_log_user_idx ON public.tool_usage_log (user_id, created_at DESC);

GRANT SELECT ON public.tool_usage_log TO authenticated;
GRANT ALL ON public.tool_usage_log TO service_role;

ALTER TABLE public.tool_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own tool usage" ON public.tool_usage_log FOR SELECT TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS cost_micro_usd bigint NOT NULL DEFAULT 0;
