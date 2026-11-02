-- cluster_adjudications — ADVISORY verdicts from the Claude cluster adjudicator.
--
-- A verdict here is an opinion about whether the members of an AMBIGUOUS or
-- NAME-COLLISION cluster belong to one subject. It is NEVER authority:
--   * nothing reads this table to change a confidence, a cap, a tier or a quarantine;
--   * nothing writes `linkage_confirmed` or `subject_unlinked` from it;
--   * the analyst's Confirm / Key / Dismiss (artifact_reviews) overrides it on every surface.
-- Kept OFF the artifacts table on purpose: artifact rows are counted, listed and
-- clustered by every reader, and a model-written row there would inherit authority.
--
-- Writes are service_role only (the sweep). Authenticated users may READ their own
-- rows and may not insert, update or delete — so neither a user session nor the
-- model can forge a verdict. Schema ships first; the sweep that writes to it is a
-- separate edge PR, shipped OFF.

CREATE TABLE public.cluster_adjudications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id UUID NOT NULL,
  user_id UUID NOT NULL,
  cluster_id TEXT NOT NULL,
  -- sha256 of the cluster's member artifact ids + values + the prompt version.
  -- Idempotence key: an unchanged cluster is never re-adjudicated (no repeat spend).
  input_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('same_subject', 'different_subjects', 'insufficient')),
  -- The model's own probability, 0-100. Displayed as "AI verdict"; never merged into scoring.
  probability SMALLINT NOT NULL CHECK (probability BETWEEN 0 AND 100),
  rationale TEXT NOT NULL,
  member_artifact_ids UUID[] NOT NULL DEFAULT '{}',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (thread_id, cluster_id, input_hash)
);

-- Supabase's default privileges grant anon/authenticated ALL on new public tables;
-- a bare GRANT SELECT does not take them away. Revoke first so the grant is the
-- only privilege (RLS already denies writes; this is the second layer).
REVOKE ALL ON public.cluster_adjudications FROM anon, authenticated;
GRANT SELECT ON public.cluster_adjudications TO authenticated;
GRANT ALL ON public.cluster_adjudications TO service_role;

ALTER TABLE public.cluster_adjudications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own adjudications" ON public.cluster_adjudications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX idx_cluster_adjudications_thread ON public.cluster_adjudications(thread_id, user_id);

COMMENT ON TABLE public.cluster_adjudications IS
  'Advisory Claude verdicts on ambiguous/name-collision clusters. Never authority: no confidence, cap, tier or quarantine reads this table.';
