CREATE TABLE public.investigation_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  seed_kind TEXT NOT NULL,
  seed_value_normalized TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE UNIQUE INDEX investigation_cache_user_seed_idx
  ON public.investigation_cache (user_id, seed_kind, seed_value_normalized);

CREATE INDEX investigation_cache_user_expiry_idx
  ON public.investigation_cache (user_id, expires_at DESC);

GRANT SELECT, DELETE ON public.investigation_cache TO authenticated;
GRANT ALL ON public.investigation_cache TO service_role;

ALTER TABLE public.investigation_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own cache"
  ON public.investigation_cache
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own cache"
  ON public.investigation_cache
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- INSERT/UPDATE intentionally not granted to authenticated/anon:
-- only the edge function (service_role) writes cache entries.