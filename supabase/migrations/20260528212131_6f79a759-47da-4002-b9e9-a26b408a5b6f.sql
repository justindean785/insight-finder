-- Per-thread toggle
ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS archive_attachments boolean NOT NULL DEFAULT false;

-- Archival metadata on evidence rows
ALTER TABLE public.evidence_log
  ADD COLUMN IF NOT EXISTS archive_storage_path text,
  ADD COLUMN IF NOT EXISTS archive_sha256 text,
  ADD COLUMN IF NOT EXISTS archive_bytes integer,
  ADD COLUMN IF NOT EXISTS archive_content_type text;

CREATE INDEX IF NOT EXISTS idx_evidence_log_archived
  ON public.evidence_log(thread_id)
  WHERE archive_storage_path IS NOT NULL;

-- Private bucket (idempotent)
INSERT INTO storage.buckets (id, name, public)
VALUES ('evidence-archive', 'evidence-archive', false)
ON CONFLICT (id) DO NOTHING;

-- Owner-read policy: object keys are {user_id}/{thread_id}/{sha}.{ext}
CREATE POLICY "Owners read archived evidence"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'evidence-archive'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Writes happen only via service role (no INSERT/UPDATE/DELETE policy for clients).