-- Anchor-intake atomic claim (PR #305 review, finding #2).
--
-- Replaces the race-prone "SELECT artifacts, then call providers" idempotency
-- guard with a DB uniqueness claim, so EXACTLY ONE request per
-- (thread, normalized seed, operation, intake version) executes the paid anchor
-- read. Concurrent/follow-up requests either reuse the completed result or are
-- told a run is in progress — they must not call or charge the provider.
-- Internal bookkeeping: service-role only, clients denied (like tool_call_cache).

CREATE TABLE IF NOT EXISTS public.anchor_intake_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  seed_normalized text NOT NULL,
  operation text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed_retryable','failed_terminal')),
  result jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT anchor_intake_claims_key UNIQUE (thread_id, seed_normalized, operation, version)
);
CREATE INDEX IF NOT EXISTS idx_anchor_claims_thread ON public.anchor_intake_claims(thread_id);

ALTER TABLE public.anchor_intake_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Deny all to client roles" ON public.anchor_intake_claims;
CREATE POLICY "Deny all to client roles" ON public.anchor_intake_claims
  FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);
GRANT ALL ON public.anchor_intake_claims TO service_role;

-- Atomically acquire (or observe) the claim. The winner of the ON CONFLICT race
-- gets claimed=true/status='running'. A late/duplicate caller gets the stored
-- result when completed, a reclaim when the prior run is stale/retryable, or a
-- "someone else is running" verdict otherwise. All decided under a row lock.
CREATE OR REPLACE FUNCTION public.claim_anchor_intake(
  _thread_id uuid, _seed text, _operation text, _version integer, _stale_seconds integer DEFAULT 120
) RETURNS TABLE(claimed boolean, status text, result jsonb, claim_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _row public.anchor_intake_claims;
  _new_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;

  -- Atomic acquire: only the inserting transaction gets the row back.
  INSERT INTO public.anchor_intake_claims (user_id, thread_id, seed_normalized, operation, version, status)
  VALUES (_uid, _thread_id, _seed, _operation, _version, 'running')
  ON CONFLICT (thread_id, seed_normalized, operation, version) DO NOTHING
  RETURNING id INTO _new_id;

  IF _new_id IS NOT NULL THEN
    RETURN QUERY SELECT true, 'running'::text, NULL::jsonb, _new_id;
    RETURN;
  END IF;

  -- Contended: lock the existing claim to decide reuse/reclaim atomically.
  SELECT * INTO _row FROM public.anchor_intake_claims
    WHERE thread_id = _thread_id AND seed_normalized = _seed
      AND operation = _operation AND version = _version
    FOR UPDATE;

  IF _row.status = 'completed' THEN
    RETURN QUERY SELECT false, 'completed'::text, _row.result, _row.id;
    RETURN;
  END IF;

  -- Crash recovery: reclaim a retryable failure or a running claim gone stale.
  IF _row.status = 'failed_retryable'
     OR (_row.status = 'running' AND _row.claimed_at < now() - make_interval(secs => _stale_seconds)) THEN
    UPDATE public.anchor_intake_claims
      SET status = 'running', claimed_at = now(), completed_at = NULL, user_id = _uid
      WHERE id = _row.id;
    RETURN QUERY SELECT true, 'running'::text, NULL::jsonb, _row.id;
    RETURN;
  END IF;

  -- A live run holds the claim, or it terminally failed: caller must NOT run.
  RETURN QUERY SELECT false, _row.status, NULL::jsonb, _row.id;
END;
$$;

-- Mark a held claim completed (storing the reusable result) or failed.
CREATE OR REPLACE FUNCTION public.complete_anchor_intake(
  _claim_id uuid, _status text, _result jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  IF _status NOT IN ('completed','failed_retryable','failed_terminal') THEN
    RAISE EXCEPTION 'invalid claim status %', _status;
  END IF;
  UPDATE public.anchor_intake_claims c
    SET status = _status,
        result = COALESCE(_result, c.result),
        completed_at = CASE WHEN _status = 'completed' THEN now() ELSE c.completed_at END
    WHERE c.id = _claim_id
      AND EXISTS (SELECT 1 FROM public.threads t WHERE t.id = c.thread_id AND t.user_id = _uid);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_anchor_intake(uuid, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_anchor_intake(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_anchor_intake(uuid, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_anchor_intake(uuid, text, jsonb) TO authenticated, service_role;
