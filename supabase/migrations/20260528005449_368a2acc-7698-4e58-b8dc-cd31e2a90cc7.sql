
-- Drop content-hash-based dedup; use (user_id, kind, subject) so re-saving the
-- same lesson with reworded content updates instead of duplicating.
DROP INDEX IF EXISTS public.agent_memory_dedup_idx;

-- Collapse existing duplicates: keep the row with highest hit_count (then newest),
-- merge related_values + max confidence into the survivor, delete losers.
WITH ranked AS (
  SELECT id, user_id, kind, subject, content, related_values, confidence, hit_count,
         row_number() OVER (
           PARTITION BY user_id, kind, subject
           ORDER BY hit_count DESC, updated_at DESC, created_at DESC
         ) AS rn,
         first_value(id) OVER (
           PARTITION BY user_id, kind, subject
           ORDER BY hit_count DESC, updated_at DESC, created_at DESC
         ) AS keeper_id
  FROM public.agent_memory
),
merged AS (
  SELECT keeper_id,
         ARRAY(SELECT DISTINCT unnest(array_agg(rv))) AS rvs,
         MAX(conf) AS max_conf,
         SUM(hc) AS total_hits
  FROM (
    SELECT keeper_id,
           unnest(COALESCE(related_values, ARRAY[]::text[])) AS rv,
           confidence AS conf,
           hit_count AS hc
    FROM ranked
  ) x
  GROUP BY keeper_id
)
UPDATE public.agent_memory m
   SET related_values = merged.rvs,
       confidence     = GREATEST(m.confidence, COALESCE(merged.max_conf, m.confidence)),
       hit_count      = GREATEST(m.hit_count, COALESCE(merged.total_hits, m.hit_count))
  FROM merged
 WHERE m.id = merged.keeper_id;

DELETE FROM public.agent_memory m
 USING (
   SELECT id FROM (
     SELECT id, row_number() OVER (
       PARTITION BY user_id, kind, subject
       ORDER BY hit_count DESC, updated_at DESC, created_at DESC
     ) AS rn
     FROM public.agent_memory
   ) r WHERE rn > 1
 ) dup
 WHERE m.id = dup.id;

CREATE UNIQUE INDEX agent_memory_dedup_idx
  ON public.agent_memory (user_id, kind, subject);

-- Update RPC to upsert on the new key and merge content (keep longest).
CREATE OR REPLACE FUNCTION public.save_agent_memories(_user_id uuid, _thread_id uuid, _entries jsonb)
 RETURNS TABLE(id uuid, subject text, kind text, hit_count integer)
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
  SELECT user_id, kind, subject, subject_kind, related_values, content, confidence, source_thread_id
    FROM rows
  ON CONFLICT (user_id, kind, subject)
  DO UPDATE SET
    hit_count       = m.hit_count + 1,
    confidence      = GREATEST(m.confidence, EXCLUDED.confidence),
    related_values  = ARRAY(SELECT DISTINCT unnest(m.related_values || EXCLUDED.related_values)),
    subject_kind    = COALESCE(EXCLUDED.subject_kind, m.subject_kind),
    -- keep the longer (more detailed) content; ties keep existing
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
