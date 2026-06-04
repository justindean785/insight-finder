-- Chain-of-custody was silently failing because the evidence_log table and
-- the append_evidence / verify_evidence_chain RPCs had no grants for the
-- authenticated role. The edge function called them as the user and PostgREST
-- rejected every call.

-- Read access to evidence rows (the CustodyTab queries this via RLS).
GRANT SELECT ON public.evidence_log TO authenticated;
GRANT ALL ON public.evidence_log TO service_role;

-- The append_evidence RPC is SECURITY DEFINER and validates thread ownership
-- internally; just expose EXECUTE so authenticated callers can invoke it.
GRANT EXECUTE ON FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) TO authenticated, service_role;

-- Ensure RLS is on and policies exist for SELECT under the user's own threads.
ALTER TABLE public.evidence_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_log_select_own" ON public.evidence_log;
CREATE POLICY "evidence_log_select_own"
  ON public.evidence_log FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies on purpose: writes must go through the
-- SECURITY DEFINER append_evidence RPC so the hash chain stays intact.
