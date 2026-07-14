-- Transactional artifact + chain-of-custody recording (PR #305 review, finding #3).
--
-- Records each accepted artifact AND its tamper-evident evidence_log entry inside
-- ONE transaction (a plpgsql function is atomic): if any custody write fails, the
-- whole call rolls back, so no uncustodied artifact can remain. Replicates the
-- append_evidence hash chain EXACTLY (seq = MAX(seq)+1 per thread; prev_hash =
-- last chain_hash or 64 zeros; content_hash = sha256 of the 9 '|'-joined fields;
-- chain_hash = sha256(prev || content)) so verify_evidence_chain stays valid.
--
-- Idempotency: an identical (thread, kind, value, source) artifact already present
-- is skipped (deduped=true) — a retry produces no second artifact or evidence row.
-- The thread row is locked FOR UPDATE to serialize seq allocation against
-- concurrent evidence writers; a unique_violation on (thread_id, seq) is retried.

CREATE OR REPLACE FUNCTION public.record_artifacts_with_evidence(_thread_id uuid, _rows jsonb)
RETURNS TABLE(artifact_id uuid, evidence_id uuid, seq bigint, deduped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _uid uuid := auth.uid();
  _row jsonb;
  _kind text; _value text; _source text; _conf integer; _meta jsonb;
  _class text; _src_url text; _snapshot text;
  _art_id uuid; _existing_art uuid;
  _seq bigint; _prev text; _content text; _ch text; _ev_id uuid;
  _attempts int;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  IF jsonb_typeof(_rows) <> 'array' THEN RAISE EXCEPTION 'rows must be a jsonb array'; END IF;

  -- Serialize seq allocation for this thread against concurrent evidence writes.
  PERFORM 1 FROM public.threads t WHERE t.id = _thread_id FOR UPDATE;

  FOR _row IN SELECT elem FROM jsonb_array_elements(_rows) AS t(elem)
  LOOP
    _kind   := _row->>'kind';
    _value  := _row->>'value';
    _source := _row->>'source';
    _conf   := NULLIF(_row->>'confidence','')::integer;
    _meta   := COALESCE(_row->'metadata', '{}'::jsonb);
    IF _kind IS NULL OR _value IS NULL THEN CONTINUE; END IF;

    -- Idempotency: skip both inserts when the same artifact already exists.
    SELECT a.id INTO _existing_art FROM public.artifacts a
      WHERE a.thread_id = _thread_id AND a.kind = _kind AND a.value = _value
        AND a.source IS NOT DISTINCT FROM _source
      LIMIT 1;
    IF _existing_art IS NOT NULL THEN
      artifact_id := _existing_art; evidence_id := NULL; seq := NULL; deduped := true;
      RETURN NEXT;
      CONTINUE;
    END IF;

    INSERT INTO public.artifacts (thread_id, user_id, kind, value, confidence, source, metadata, cluster_id, subject_id)
    VALUES (_thread_id, _uid, _kind, _value, _conf, _source, _meta, _row->>'cluster_id', _row->>'subject_id')
    RETURNING id INTO _art_id;

    _class    := CASE WHEN COALESCE(_conf,0) >= 85 THEN 'hard' ELSE 'soft' END;
    _src_url  := _meta->>'source_url';
    _snapshot := left(_meta::text, 1500);

    _attempts := 0;
    LOOP
      SELECT COALESCE(MAX(el.seq),0)+1 INTO _seq FROM public.evidence_log el WHERE el.thread_id = _thread_id;
      SELECT el.chain_hash INTO _prev FROM public.evidence_log el
        WHERE el.thread_id = _thread_id ORDER BY el.seq DESC LIMIT 1;
      IF _prev IS NULL THEN _prev := repeat('0', 64); END IF;

      _content := encode(digest(
        coalesce(_source, '')            || '|' ||
        coalesce(_source, '')            || '|' ||
        coalesce(_src_url, '')           || '|' ||
        _class                           || '|' ||
        coalesce(_conf::text, '')        || '|' ||
        coalesce(_kind, '')              || '|' ||
        coalesce(_value, '')             || '|' ||
        coalesce(_snapshot, '')          || '|' ||
        coalesce(_meta::text, '{}'),
        'sha256'), 'hex');
      _ch := encode(digest(_prev || _content, 'sha256'), 'hex');

      BEGIN
        INSERT INTO public.evidence_log(
          thread_id, user_id, seq, artifact_id, tool_name, source, source_url,
          classification, confidence, kind, value, content_snapshot,
          content_hash, prev_hash, chain_hash, metadata
        ) VALUES (
          _thread_id, _uid, _seq, _art_id, _source, _source, _src_url,
          _class, _conf, _kind, _value, _snapshot,
          _content, _prev, _ch, _meta
        ) RETURNING id INTO _ev_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        _attempts := _attempts + 1;
        IF _attempts >= 5 THEN RAISE; END IF;
        -- A concurrent append took this seq; recompute prev/seq and retry.
      END;
    END LOOP;

    artifact_id := _art_id; evidence_id := _ev_id; seq := _seq; deduped := false;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_artifacts_with_evidence(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_artifacts_with_evidence(uuid, jsonb) TO authenticated, service_role;
