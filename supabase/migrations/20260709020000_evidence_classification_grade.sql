-- C-3: evidence classification grades beyond the binary hard/soft.
--
-- The analyst-facing grade (verified/probable/weak/contradicted/rejected/
-- unclassified) is DERIVED from the C-1 cluster tier and stored in a NEW,
-- NON-hashed `classification_grade` column. The existing `classification`
-- (hard/soft) is FOLDED INTO the tamper-evident SHA-256 content/chain hash, so it
-- must stay immutable — rewriting it post-hoc would break chain-of-custody. The
-- grade column is deliberately OUTSIDE the hash input (exactly like the archive_*
-- columns) so the end-of-cycle reclassification pass can UPDATE it freely without
-- recomputing — or invalidating — the chain.

-- 1) The mutable, non-hashed grade column. Nullable; a CHECK enforces the enum.
--    Existing rows are left NULL (backfill is optional per the brief); the
--    reclassification pass grades any NULL/'unclassified' row it later sees.
ALTER TABLE public.evidence_log
  ADD COLUMN IF NOT EXISTS classification_grade text
  CHECK (
    classification_grade IS NULL OR classification_grade IN (
      'verified','probable','weak','contradicted','rejected','unclassified'
    )
  );

-- Partial index for the reclassification pass (rows still needing a grade).
CREATE INDEX IF NOT EXISTS idx_evidence_log_ungraded
  ON public.evidence_log(thread_id)
  WHERE classification_grade IS NULL OR classification_grade = 'unclassified';

-- 2) append_evidence gains a trailing `_classification_grade` param (DEFAULT NULL
--    so existing 11-arg callers keep working). The hash input is UNCHANGED — the
--    grade is written to the column but NEVER hashed. The hashed `classification`
--    guard (hard/soft) is preserved verbatim.
DROP FUNCTION IF EXISTS public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.append_evidence(
  _thread_id uuid, _artifact_id uuid, _tool_name text, _source text, _source_url text,
  _classification text, _confidence integer, _kind text, _value text,
  _content_snapshot text, _metadata jsonb, _classification_grade text DEFAULT NULL
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
  -- Hashed classification stays hard/soft (chain-of-custody). Do not widen it.
  IF _classification IS NULL OR _classification NOT IN ('hard','soft') THEN
    RAISE EXCEPTION 'classification must be hard or soft';
  END IF;
  -- Non-hashed analyst grade: optional, but must be a known enum value if present.
  IF _classification_grade IS NOT NULL AND _classification_grade NOT IN (
    'verified','probable','weak','contradicted','rejected','unclassified'
  ) THEN
    RAISE EXCEPTION 'classification_grade must be a known evidence grade';
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

  -- HASH INPUT IS UNCHANGED — _classification_grade is intentionally absent so the
  -- grade can be reclassified later without breaking the chain.
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
    content_hash, prev_hash, chain_hash, metadata, classification_grade
  ) VALUES (
    _thread_id, _uid, _seq, _artifact_id, _tool_name, _source, _source_url,
    _classification, _confidence, _kind, _value, _content_snapshot,
    _content, _prev, _ch, coalesce(_metadata, '{}'::jsonb),
    coalesce(_classification_grade, 'unclassified')
  ) RETURNING evidence_log.id INTO _new_id;

  RETURN QUERY SELECT _new_id, _seq, _ch;
END;
$function$;

-- 3) Re-establish grants on the NEW 12-arg signature (DROP+CREATE dropped them).
REVOKE EXECUTE ON FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_evidence(uuid, uuid, text, text, text, text, integer, text, text, text, jsonb, text) TO authenticated, service_role;
