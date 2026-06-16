-- 2026-06-15 Security and Integrity Fixes

-- DB-1: Grant EXECUTE on bump_memory_hits to authenticated users
-- The agent calls this via user-scoped client, so it needs this permission.
GRANT EXECUTE ON FUNCTION public.bump_memory_hits(uuid[]) TO authenticated;

-- DB-2: Explicitly REVOKE EXECUTE on save_agent_memories from PUBLIC/anon
-- CREATE OR REPLACE defaults to PUBLIC grant; we must lock it down to auth/service_role.
REVOKE EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb, text) TO authenticated, service_role;

-- DB-3: Add missing Foreign Key constraints to prevent orphan-row accumulation
-- and ensure ON DELETE CASCADE for better GDPR compliance and data integrity.

-- evidence_log
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_log_user_id_fkey') THEN
    ALTER TABLE public.evidence_log ADD CONSTRAINT evidence_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_log_thread_id_fkey') THEN
    ALTER TABLE public.evidence_log ADD CONSTRAINT evidence_log_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;
  END IF;
END $$;

-- investigator_notes
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investigator_notes_user_id_fkey') THEN
    ALTER TABLE public.investigator_notes ADD CONSTRAINT investigator_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investigator_notes_thread_id_fkey') THEN
    ALTER TABLE public.investigator_notes ADD CONSTRAINT investigator_notes_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;
  END IF;
END $$;

-- tool_usage_log
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_usage_log_thread_id_fkey') THEN
    ALTER TABLE public.tool_usage_log ADD CONSTRAINT tool_usage_log_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;
  END IF;
END $$;

-- agent_memory
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memory_user_id_fkey') THEN
    ALTER TABLE public.agent_memory ADD CONSTRAINT agent_memory_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- investigation_cache
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investigation_cache_user_id_fkey') THEN
    ALTER TABLE public.investigation_cache ADD CONSTRAINT investigation_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- DB-4: Harden append_evidence against concurrent-append races
-- Adds an advisory lock on the thread ID during the hash-chain calculation.
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
  
  -- Acquire session-level advisory lock on the thread ID to prevent races
  -- in SELECT MAX(seq) and the hash chain.
  PERFORM pg_advisory_xact_lock(hashtext(_thread_id::text));

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
    coalesce(_metadata::text, '')    || '|' ||
    _prev,
    'sha256'
  ), 'hex');

  _ch := encode(digest(_content, 'sha256'), 'hex');

  INSERT INTO public.evidence_log (
    thread_id, user_id, artifact_id, tool_name, source, source_url,
    classification, confidence, kind, value,
    content_snapshot, metadata, seq, prev_hash, content_hash, chain_hash
  ) VALUES (
    _thread_id, _uid, _artifact_id, _tool_name, _source, _source_url,
    _classification, _confidence, _kind, _value,
    _content_snapshot, _metadata, _seq, _prev, _content, _ch
  ) RETURNING public.evidence_log.id INTO _new_id;

  RETURN QUERY SELECT _new_id, _seq, _ch;
END;
$function$;
