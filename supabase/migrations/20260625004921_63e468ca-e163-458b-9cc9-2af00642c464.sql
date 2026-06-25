-- 1. Widen threads_status_check to accept 'stopped' (user stop + overflow-mapped path).
ALTER TABLE public.threads DROP CONSTRAINT IF EXISTS threads_status_check;
ALTER TABLE public.threads ADD CONSTRAINT threads_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'finished'::text, 'stopped'::text]));

-- 2. Re-apply the runtime cache scope/metadata migration. Partial state in production:
--    user_id exists, but expires_at / selector_* / source_created_at / stale do not,
--    which is why [tool_call_cache] writes fail with "Could not find the 'expires_at' column".
ALTER TABLE public.tool_call_cache
  ADD COLUMN IF NOT EXISTS selector_normalized text,
  ADD COLUMN IF NOT EXISTS selector_type text,
  ADD COLUMN IF NOT EXISTS params_hash text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS tool_call_cache_user_lookup_idx
  ON public.tool_call_cache (user_id, tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_call_cache_selector_lookup_idx
  ON public.tool_call_cache (user_id, selector_type, selector_normalized, created_at DESC);

CREATE INDEX IF NOT EXISTS tool_call_cache_expiry_idx
  ON public.tool_call_cache (expires_at)
  WHERE expires_at IS NOT NULL;

-- Collapse duplicates before tightening uniqueness scope.
DROP INDEX IF EXISTS tool_call_cache_unique_idx;

DELETE FROM public.tool_call_cache older
USING public.tool_call_cache newer
WHERE older.user_id = newer.user_id
  AND older.tool_name = newer.tool_name
  AND older.input_hash = newer.input_hash
  AND (
    older.created_at < newer.created_at
    OR (older.created_at = newer.created_at AND older.id < newer.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS tool_call_cache_user_tool_hash_uidx
  ON public.tool_call_cache (user_id, tool_name, input_hash);