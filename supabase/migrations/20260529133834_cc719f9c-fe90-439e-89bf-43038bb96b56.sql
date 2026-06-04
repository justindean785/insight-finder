-- Tighten SECURITY DEFINER function privileges. Edge functions use the
-- service role, which bypasses these grants, so revoking from anon/
-- authenticated does not affect the agent. Only RPCs intentionally called
-- by signed-in clients keep EXECUTE.

-- Revoke broad EXECUTE on all SECURITY DEFINER RPCs.
REVOKE EXECUTE ON FUNCTION public.increment_thread_cost(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_memory_hits(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;

-- has_role is used by RLS policies and the security-test-lab admin gate; it
-- already restricts to the caller's own roles via auth.uid() at call sites.
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

-- verify_evidence_chain is invoked by the user client during evidence export
-- (the function itself enforces ownership via auth.uid()).
GRANT EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) TO authenticated;

-- service_role retains EXECUTE on everything (superuser path used by edge
-- functions); no explicit grant needed.