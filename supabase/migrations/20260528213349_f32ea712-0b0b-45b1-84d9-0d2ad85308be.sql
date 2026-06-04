CREATE TABLE public.investigator_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.investigator_notes TO authenticated;
GRANT ALL ON public.investigator_notes TO service_role;

ALTER TABLE public.investigator_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own notes" ON public.investigator_notes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own notes" ON public.investigator_notes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own notes" ON public.investigator_notes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own notes" ON public.investigator_notes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX investigator_notes_thread_idx ON public.investigator_notes(thread_id, updated_at DESC);

CREATE TRIGGER set_updated_at_investigator_notes
  BEFORE UPDATE ON public.investigator_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();