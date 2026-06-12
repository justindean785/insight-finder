-- Fix: save_agent_memories threw
--   "ON CONFLICT DO UPDATE command cannot affect row a second time"
-- whenever a single batch contained two entries that normalized to the same
-- conflict key (user_id, kind, subject, scope). Postgres forbids ON CONFLICT
-- touching the same target row twice in one statement, so the entire
-- memory_save call failed even though the per-key merge logic was correct.
--
-- The agent emits one batched memory_save at end-of-run, and LLMs routinely
-- repeat a subject (e.g. two "lesson" rows about the same handle), so this hit
-- real runs. Fix: collapse in-batch duplicates to a single representative row
-- before the upsert, preferring the richest entry (most related_values, then
-- longest content, then highest confidence). Cross-statement merges against
-- rows already in the table are unchanged and still handled by ON CONFLICT.
CREATE OR REPLACE FUNCTION public.save_agent_memories(
  _user_id   uuid,
  _thread_id uuid,
  _entries   jsonb,
  _scope     text DEFAULT 'global'
)
RETURNS TABLE(id uuid, out_subject text, out_kind text, out_hit_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _s   text := COALESCE(NULLIF(_scope,''), 'global');
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;
  IF _s NOT IN ('global','case') THEN
    _s := 'global';
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
      _thread_id                                                        AS source_thread_id,
      _s                                                                AS scope
    FROM jsonb_array_elements(_entries) AS e
    WHERE length(trim(coalesce(e->>'subject',''))) > 0
      AND length(trim(coalesce(e->>'kind',''))) > 0
      AND length(trim(coalesce(e->>'content',''))) > 0
  ),
  -- Collapse in-batch duplicates so ON CONFLICT sees each target row once.
  deduped AS (
    SELECT DISTINCT ON (user_id, kind, subject, scope)
      user_id, kind, subject, subject_kind, related_values,
      content, confidence, source_thread_id, scope
    FROM rows
    ORDER BY
      user_id, kind, subject, scope,
      cardinality(related_values) DESC,
      length(content) DESC,
      confidence DESC
  )
  INSERT INTO public.agent_memory AS m
    (user_id, kind, subject, subject_kind, related_values, content, confidence, source_thread_id, scope)
  SELECT r.user_id, r.kind, r.subject, r.subject_kind, r.related_values, r.content, r.confidence, r.source_thread_id, r.scope
    FROM deduped r
  ON CONFLICT (user_id, kind, subject, scope)
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
