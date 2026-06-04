ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','finished'));

CREATE INDEX IF NOT EXISTS idx_threads_user_status ON public.threads(user_id, status, updated_at DESC);