CREATE TABLE public.artifact_reviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  user_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('confirmed','key','recheck','dismissed')),
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, artifact_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.artifact_reviews TO authenticated;
GRANT ALL ON public.artifact_reviews TO service_role;

ALTER TABLE public.artifact_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own reviews" ON public.artifact_reviews
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own reviews" ON public.artifact_reviews
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own reviews" ON public.artifact_reviews
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own reviews" ON public.artifact_reviews
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_artifact_reviews_thread ON public.artifact_reviews(thread_id, user_id);
CREATE INDEX idx_artifact_reviews_artifact ON public.artifact_reviews(artifact_id);

CREATE TRIGGER update_artifact_reviews_updated_at
BEFORE UPDATE ON public.artifact_reviews
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();