-- ============================================================================
-- FORWARD-ONLY correction for 20260717000000_analyst_feedback_events.sql
-- ----------------------------------------------------------------------------
-- DO NOT edit the original migration — it is already applied to production.
-- This is a new, additive migration that supersedes only the function body.
--
-- Defect: public.record_analyst_feedback() is SECURITY DEFINER with
--   SET search_path = public, but pgcrypto's digest() is installed in the
--   `extensions` schema on Supabase (not public). Every real (non-deduped)
--   insert therefore failed at runtime with
--     ERROR: function digest(text, unknown) does not exist
--   so NO analyst-feedback event could be recorded in production. The
--   dedupe / ownership / validation branches return BEFORE digest(), which is
--   why the function still "existed" and callers only observed a swallowed error.
--
-- Fix (approach A — schema-qualify the pgcrypto call; keep the restricted
--   search_path): call extensions.digest(...) explicitly. This keeps the
--   SECURITY DEFINER lookup path minimal (public only) and removes the sole
--   unqualified extension reference, so it cannot be resolved by search-path
--   shadowing. (Alternative approach B: SET search_path = public, extensions to
--   match public.append_evidence, leaving digest() unqualified.)
--
-- Idempotent: CREATE OR REPLACE preserves the existing ACL; execute grants are
--   re-asserted below defensively.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_analyst_feedback(
  _thread_id                uuid,
  _artifact_id              uuid,
  _action                   text,
  _prior_state              text,
  _resulting_state          text,
  _reason                   text,
  _confidence_before        integer,
  _confidence_after         integer,
  _confidence_model_version text,
  _source_lineage           jsonb
) RETURNS TABLE(id uuid, seq bigint, deduped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid     uuid := auth.uid();
  _seq     bigint;
  _prev    text;
  _content text;
  _ch      text;
  _run     text;
  _last    public.analyst_feedback_events%ROWTYPE;
  _new_id  uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;
  IF _action NOT IN (
    'confirm','key','recheck','dismiss','wrong','reject','retract',
    'merge','split','corrected_entity','accept_pivot','reject_pivot','manual_tool_selection'
  ) THEN
    RAISE EXCEPTION 'invalid action %', _action;
  END IF;
  IF _confidence_model_version IS NULL OR length(_confidence_model_version) = 0 THEN
    RAISE EXCEPTION 'confidence_model_version required';
  END IF;
  -- Tenant + thread ownership (no client-supplied analyst_id is trusted).
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  -- Artifact, when present, must belong to the SAME thread (hence same user).
  IF _artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.artifacts a WHERE a.id = _artifact_id AND a.thread_id = _thread_id
  ) THEN
    RAISE EXCEPTION 'artifact does not belong to thread';
  END IF;

  -- Serialize writers for this thread so seq/chain can't be corrupted by a race.
  PERFORM pg_advisory_xact_lock(hashtextextended(_thread_id::text, 0));

  -- Idempotency: if this analyst's most recent event for this (thread, artifact)
  -- is identical in (action, resulting_state, reason), return it — a double click
  -- or network retry must not append a duplicate.
  SELECT * INTO _last
    FROM public.analyst_feedback_events e
   WHERE e.analyst_id = _uid
     AND e.thread_id = _thread_id
     AND e.artifact_id IS NOT DISTINCT FROM _artifact_id
   ORDER BY e.seq DESC
   LIMIT 1;
  IF _last.id IS NOT NULL
     AND _last.action = _action
     AND _last.resulting_state IS NOT DISTINCT FROM _resulting_state
     AND _last.reason IS NOT DISTINCT FROM _reason THEN
    RETURN QUERY SELECT _last.id, _last.seq, true;
    RETURN;
  END IF;

  SELECT to_char(t.run_started_at, 'YYYYMMDD"T"HH24MISS')
    INTO _run
    FROM public.threads t
   WHERE t.id = _thread_id;

  -- Qualify column refs: `id`/`seq` are also OUT-parameter names, so an
  -- unqualified `MAX(seq)` is ambiguous (caught on real PostgreSQL).
  SELECT COALESCE(MAX(afe.seq), 0) + 1 INTO _seq
    FROM public.analyst_feedback_events afe WHERE afe.thread_id = _thread_id;
  SELECT afe.chain_hash INTO _prev
    FROM public.analyst_feedback_events afe WHERE afe.thread_id = _thread_id
    ORDER BY afe.seq DESC LIMIT 1;
  IF _prev IS NULL THEN
    _prev := repeat('0', 64);
  END IF;

  -- FIX: schema-qualify pgcrypto's digest() (lives in `extensions` on Supabase);
  -- the restricted SECURITY DEFINER search_path (public) does not include it.
  _content := encode(extensions.digest(
    concat_ws('|',
      _action,
      coalesce(_artifact_id::text, ''),
      coalesce(_prior_state, ''),
      coalesce(_resulting_state, ''),
      coalesce(_reason, ''),
      coalesce(_confidence_before::text, ''),
      coalesce(_confidence_after::text, ''),
      _confidence_model_version,
      coalesce(_source_lineage::text, '{}')
    ), 'sha256'), 'hex');
  _ch := encode(extensions.digest(_prev || _content, 'sha256'), 'hex');

  INSERT INTO public.analyst_feedback_events(
    seq, thread_id, artifact_id, run_id, analyst_id, action, prior_state,
    resulting_state, reason, confidence_before, confidence_after,
    confidence_model_version, source_lineage, content_hash, prev_hash, chain_hash
  ) VALUES (
    _seq, _thread_id, _artifact_id, _run, _uid, _action, _prior_state,
    _resulting_state, _reason, _confidence_before, _confidence_after,
    _confidence_model_version, coalesce(_source_lineage, '{}'::jsonb), _content, _prev, _ch
  ) RETURNING analyst_feedback_events.id INTO _new_id;

  RETURN QUERY SELECT _new_id, _seq, false;
END;
$$;

-- Re-assert intended execute privileges (defensive; CREATE OR REPLACE preserves ACL).
REVOKE EXECUTE ON FUNCTION public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb) TO authenticated, service_role;

-- ============================================================================
-- ROLLBACK (down) — restore the prior (defective) body only if reverting:
-- re-run 20260717000000_analyst_feedback_events.sql's CREATE OR REPLACE FUNCTION
-- block verbatim. No schema/table/trigger/policy changes are made here.
-- ============================================================================
