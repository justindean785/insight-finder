-- 1. Drop the dead 3-arg save_agent_memories overload (4-arg version remains)
DROP FUNCTION IF EXISTS public.save_agent_memories(uuid, uuid, jsonb);

-- 2. Realtime topic authorization: lock subscriptions to the owning user.
-- Topic convention: "thread:<thread_id>" for any thread/artifact channel.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users subscribe only to own thread topics" ON realtime.messages;
CREATE POLICY "Users subscribe only to own thread topics"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  -- Always allow private user-scoped topics keyed by auth.uid().
  realtime.topic() = ('user:' || auth.uid()::text)
  OR
  -- Thread topics: topic must be "thread:<uuid>" and the caller must own it.
  (
    realtime.topic() LIKE 'thread:%'
    AND EXISTS (
      SELECT 1 FROM public.threads t
      WHERE t.id::text = substring(realtime.topic() from 8)
        AND t.user_id = auth.uid()
    )
  )
);

-- 3. chat-uploads: explicit owner-scoped UPDATE policy.
DROP POLICY IF EXISTS "chat-uploads owner update" ON storage.objects;
CREATE POLICY "chat-uploads owner update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'chat-uploads' AND owner = auth.uid())
WITH CHECK (bucket_id = 'chat-uploads' AND owner = auth.uid());
