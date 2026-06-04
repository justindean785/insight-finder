GRANT EXECUTE ON FUNCTION public.increment_thread_cost(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_memory_hits(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;

ALTER FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb)
  SET search_path TO 'public', 'extensions';
ALTER FUNCTION public.verify_evidence_chain(uuid)
  SET search_path TO 'public', 'extensions';