
CREATE OR REPLACE FUNCTION public.save_agent_memories(_user_id uuid, _thread_id uuid, _entries jsonb)
RETURNS TABLE (id uuid, subject text, kind text, hit_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  SELECT user_id, kind, subject, subject_kind, related_values, content, confidence, source_thread_id
    FROM rows
  ON CONFLICT (user_id, kind, subject, md5(content))
  DO UPDATE SET
    hit_count       = m.hit_count + 1,
    confidence      = GREATEST(m.confidence, EXCLUDED.confidence),
    related_values  = ARRAY(SELECT DISTINCT unnest(m.related_values || EXCLUDED.related_values)),
    subject_kind    = COALESCE(EXCLUDED.subject_kind, m.subject_kind),
    source_thread_id= COALESCE(EXCLUDED.source_thread_id, m.source_thread_id),
    updated_at      = now(),
    last_used_at    = now()
  RETURNING m.id, m.subject, m.kind, m.hit_count;
END;
$$;

REVOKE ALL ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb) TO authenticated, service_role;
