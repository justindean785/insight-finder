CREATE POLICY "evidence-archive owner update"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'evidence-archive' AND auth.uid()::text = (storage.foldername(name))[1])
WITH CHECK (bucket_id = 'evidence-archive' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "evidence-archive owner delete"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'evidence-archive' AND auth.uid()::text = (storage.foldername(name))[1]);