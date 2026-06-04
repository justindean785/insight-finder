CREATE TABLE public.tool_call_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  investigation_id UUID NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json JSONB NOT NULL,
  output_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tool_call_cache_unique_idx
  ON public.tool_call_cache (investigation_id, tool_name, input_hash);

CREATE INDEX tool_call_cache_lookup_idx
  ON public.tool_call_cache (investigation_id, tool_name, created_at DESC);

GRANT ALL ON public.tool_call_cache TO service_role;

ALTER TABLE public.tool_call_cache ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies: this table is service-role only.
-- The edge function uses the service role key to read/write it.
CREATE POLICY "Deny all to client roles"
  ON public.tool_call_cache
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);