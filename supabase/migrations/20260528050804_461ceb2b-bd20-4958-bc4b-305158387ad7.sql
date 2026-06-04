CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.evidence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  user_id uuid NOT NULL,
  seq bigint NOT NULL,
  artifact_id uuid,
  tool_name text,
  source text,
  source_url text,
  classification text NOT NULL CHECK (classification IN ('hard','soft')),
  confidence integer CHECK (confidence BETWEEN 0 AND 100),
  kind text,
  value text,
  content_snapshot text,
  content_hash text NOT NULL,
  prev_hash text NOT NULL,
  chain_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, seq)
);

CREATE INDEX idx_evidence_thread_seq ON public.evidence_log(thread_id, seq);
CREATE INDEX idx_evidence_user_time ON public.evidence_log(user_id, collected_at DESC);
CREATE INDEX idx_evidence_artifact ON public.evidence_log(artifact_id);

GRANT SELECT ON public.evidence_log TO authenticated;
GRANT ALL ON public.evidence_log TO service_role;

ALTER TABLE public.evidence_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own evidence"
  ON public.evidence_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for authenticated => append-only via RPC.

CREATE OR REPLACE FUNCTION public.append_evidence(
  _thread_id uuid,
  _artifact_id uuid,
  _tool_name text,
  _source text,
  _source_url text,
  _classification text,
  _confidence integer,
  _kind text,
  _value text,
  _content_snapshot text,
  _metadata jsonb
) RETURNS TABLE(id uuid, seq bigint, chain_hash text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _seq bigint;
  _prev text;
  _content text;
  _ch text;
  _new_id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  IF _classification IS NULL OR _classification NOT IN ('hard','soft') THEN
    RAISE EXCEPTION 'classification must be hard or soft';
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1
    INTO _seq
    FROM public.evidence_log
   WHERE thread_id = _thread_id;

  SELECT chain_hash INTO _prev
    FROM public.evidence_log
   WHERE thread_id = _thread_id
   ORDER BY seq DESC
   LIMIT 1;

  IF _prev IS NULL THEN
    _prev := repeat('0', 64);
  END IF;

  _content := encode(digest(
    coalesce(_tool_name, '')         || '|' ||
    coalesce(_source, '')            || '|' ||
    coalesce(_source_url, '')        || '|' ||
    _classification                  || '|' ||
    coalesce(_confidence::text, '')  || '|' ||
    coalesce(_kind, '')              || '|' ||
    coalesce(_value, '')             || '|' ||
    coalesce(_content_snapshot, '')  || '|' ||
    coalesce(_metadata::text, '{}'),
    'sha256'
  ), 'hex');

  _ch := encode(digest(_prev || _content, 'sha256'), 'hex');

  INSERT INTO public.evidence_log(
    thread_id, user_id, seq, artifact_id, tool_name, source, source_url,
    classification, confidence, kind, value, content_snapshot,
    content_hash, prev_hash, chain_hash, metadata
  ) VALUES (
    _thread_id, _uid, _seq, _artifact_id, _tool_name, _source, _source_url,
    _classification, _confidence, _kind, _value, _content_snapshot,
    _content, _prev, _ch, coalesce(_metadata, '{}'::jsonb)
  ) RETURNING evidence_log.id INTO _new_id;

  RETURN QUERY SELECT _new_id, _seq, _ch;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.append_evidence(uuid,uuid,text,text,text,text,integer,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_evidence(uuid,uuid,text,text,text,text,integer,text,text,text,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.verify_evidence_chain(_thread_id uuid)
RETURNS TABLE(ok boolean, total bigint, first_break bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  r RECORD;
  _prev text := repeat('0', 64);
  _expected text;
  _count bigint := 0;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  FOR r IN
    SELECT seq, content_hash, prev_hash, chain_hash
      FROM public.evidence_log
     WHERE thread_id = _thread_id
     ORDER BY seq ASC
  LOOP
    _count := _count + 1;
    _expected := encode(digest(_prev || r.content_hash, 'sha256'), 'hex');
    IF r.prev_hash <> _prev OR r.chain_hash <> _expected THEN
      RETURN QUERY SELECT false, _count, r.seq;
      RETURN;
    END IF;
    _prev := r.chain_hash;
  END LOOP;
  RETURN QUERY SELECT true, _count, NULL::bigint;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_evidence_chain(uuid) TO authenticated, service_role;