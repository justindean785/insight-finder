-- Self-service account deletion (beta-readiness audit F14/F15).
--
-- The Privacy Policy already promises "Account deletion removes all
-- associated data" — this makes that true. Callable by any authenticated
-- user on THEMSELVES ONLY: the target is always auth.uid(), never a
-- parameter, so there is no user_id argument to spoof.
--
-- Schema note: only user_credits and user_roles carry a real
-- REFERENCES auth.users(id) ON DELETE CASCADE. profiles, threads,
-- investigation_cache, agent_memory, tool_usage_log, security_tests,
-- evidence_log, artifact_reviews, and investigator_notes all use a bare
-- user_id/thread_id UUID with NO foreign key (verified against every
-- CREATE TABLE in supabase/migrations/ — messages/artifacts DO cascade from
-- threads(id), but evidence_log/artifact_reviews/investigator_notes do NOT,
-- despite also carrying a thread_id column). So every one of those tables is
-- purged explicitly below rather than relied on to cascade.
CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.investigator_notes WHERE user_id = _uid;
  DELETE FROM public.artifact_reviews   WHERE user_id = _uid;
  DELETE FROM public.evidence_log       WHERE user_id = _uid;
  DELETE FROM public.tool_usage_log     WHERE user_id = _uid;
  DELETE FROM public.agent_memory       WHERE user_id = _uid;
  DELETE FROM public.investigation_cache WHERE user_id = _uid;
  DELETE FROM public.security_tests     WHERE user_id = _uid;
  -- messages/artifacts cascade from threads(id) ON DELETE CASCADE, so this
  -- also clears them; the explicit deletes above don't depend on that.
  DELETE FROM public.threads  WHERE user_id = _uid;
  DELETE FROM public.profiles WHERE user_id = _uid;

  -- Object keys are {user_id}/... in both buckets (see
  -- 20260527155254_..., 20260528212131_...).
  DELETE FROM storage.objects
    WHERE bucket_id IN ('chat-uploads', 'evidence-archive')
      AND (storage.foldername(name))[1] = _uid::text;

  -- user_credits + user_roles cascade automatically from the FK below, and
  -- auth.users itself cascades to auth.identities/sessions/refresh_tokens
  -- internally within Supabase's managed auth schema.
  DELETE FROM auth.users WHERE id = _uid;
END; $$;

REVOKE EXECUTE ON FUNCTION public.delete_own_account() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;
