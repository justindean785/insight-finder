-- Remove DELETE policy on evidence-archive storage bucket to preserve
-- evidence chain integrity (append-only requirement).
DROP POLICY IF EXISTS "Users delete own evidence files" ON storage.objects;
DROP POLICY IF EXISTS "Users update own evidence files" ON storage.objects;
