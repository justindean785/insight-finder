
-- Fix ambiguous OUT-parameter name collisions ("kind" / "seq") inside
-- function bodies. Rename the OUT columns; callers only read .id from
-- both functions, so this is safe.

DROP FUNCTION IF EXISTS public.save_agent_memories(uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.save_agent_memories(_user_id uuid, _thread_id uuid, _entries jsonb)
 RETURNS TABLE(id uuid, out_subject text, out_kind text, out_hit_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;

  RETURN QUERY
  WITH rows AS (
    SELECT
      _uid                                                              AS user_id,
      (e->>'kind')                                                      AS kind,
      lower(trim(e->>'subject'))                                        AS subject,
      NULLIF(e->>'subject_kind','')                                     AS subject_kind,
      COALESCE(
        ARRAY(
          SELECT lower(trim(x)) FROM jsonb_array_elements_text(
            COALESCE(e->'related_values','[]'::jsonb)
          ) AS x WHERE length(trim(x)) > 0
        ),
        ARRAY[]::text[]
      )                                                                 AS related_values,
      (e->>'content')                                                   AS content,
      COALESCE((e->>'confidence')::int, 60)                             AS confidence,
      _thread_id                                                        AS source_thread_id
    FROM jsonb_array_elements(_entries) AS e
  )
  INSERT INTO public.agent_memory AS m
    (user_id, kind, subject, subject_kind, related_values, content, confidence, source_thread_id)
  SELECT r.user_id, r.kind, r.subject, r.subject_kind, r.related_values, r.content, r.confidence, r.source_thread_id
    FROM rows r
  ON CONFLICT (user_id, kind, subject)
  DO UPDATE SET
    hit_count       = m.hit_count + 1,
    confidence      = GREATEST(m.confidence, EXCLUDED.confidence),
    related_values  = ARRAY(SELECT DISTINCT unnest(m.related_values || EXCLUDED.related_values)),
    subject_kind    = COALESCE(EXCLUDED.subject_kind, m.subject_kind),
    content         = CASE
                        WHEN length(EXCLUDED.content) > length(m.content) THEN EXCLUDED.content
                        ELSE m.content
                      END,
    source_thread_id= COALESCE(EXCLUDED.source_thread_id, m.source_thread_id),
    updated_at      = now(),
    last_used_at    = now()
  RETURNING m.id, m.subject, m.kind, m.hit_count;
END;
$function$;

DROP FUNCTION IF EXISTS public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.append_evidence(
  _thread_id uuid, _artifact_id uuid, _tool_name text, _source text, _source_url text,
  _classification text, _confidence integer, _kind text, _value text,
  _content_snapshot text, _metadata jsonb
)
 RETURNS TABLE(id uuid, out_seq bigint, out_chain_hash text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT COALESCE(MAX(el.seq), 0) + 1
    INTO _seq
    FROM public.evidence_log el
   WHERE el.thread_id = _thread_id;

  SELECT el.chain_hash INTO _prev
    FROM public.evidence_log el
   WHERE el.thread_id = _thread_id
   ORDER BY el.seq DESC
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
$function$;
