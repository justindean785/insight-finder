-- Findings #9/#10 (release-gating audit, 2026-07-11) + selector-scope dedup
-- data-loss fix for PR #305.
--
-- #9 — confidence bounds: `evidence_log.confidence` already carries
-- `CHECK (confidence BETWEEN 0 AND 100)` (20260528050804). `artifacts.confidence`
-- never got the same constraint, and the "Users insert own artifacts" RLS policy
-- (20260526140844) allows any authenticated client to INSERT INTO artifacts
-- directly via PostgREST — bypassing record_artifacts_with_evidence entirely, with
-- no bounds check of any kind. Six memory_save SQL functions similarly cast
-- `(e->>'confidence')::int` into `agent_memory.confidence` (also uncapped) with no
-- validation. This migration adds the same 0-100 CHECK to both columns —
-- table-level constraints apply to EVERY insert path, RPC or direct, closing the
-- bypass regardless of which code wrote the row. NOT VALID: skips only the one-time
-- scan of pre-existing rows; every NEW or UPDATEd row is bounded immediately.
--
-- #10 — deduplication (selector-scope-aware, provenance-preserving):
-- The naive key `(thread_id, kind, value, COALESCE(source,''))` is UNSAFE: `source`
-- is the TOOL name, identical across every platform a sweep tool reports, so that
-- key collapses a username found on 21 distinct platforms into ONE row (the
-- platform lives in `metadata->>'platform'`, not in `source`). This migration
-- replaces it with a SELECTOR-SCOPE-aware identity:
--   (thread_id, kind, value, subject_sentinel, artifact_selector_scope(...))
-- where the selector scope derives from platform / source_url host / breach
-- identity / explicit selector — NEVER from the tool `source` name — so distinct
-- platforms, hosts and breach sites stay separate while true duplicates collapse.
--
-- Pre-existing duplicates under the NEW identity are consolidated FIRST (a UNIQUE
-- INDEX cannot be added NOT VALID): the earliest row (created_at,id) survives, all
-- others MERGE into it — provenance, source classes, confidence GREATEST and
-- first/last_seen are unioned into the survivor's metadata so nothing is lost, and
-- every dependent row (evidence_log, artifact_reviews) is RE-POINTED at the
-- survivor, never deleted. No hard FK references artifacts.id; the only two
-- dependents are evidence_log.artifact_id and artifact_reviews.artifact_id.
--
-- ATOMIC INDEX↔RPC SWITCH: the selector function, the consolidation, the UNIQUE
-- INDEX and the CREATE OR REPLACE of record_artifacts_with_evidence (whose
-- ON CONFLICT infers that exact index) all live in THIS ONE migration = ONE
-- transaction. There is therefore never an interval where the new index exists
-- with the old RPC, nor where the new RPC (needing the index) runs before the
-- index exists. If this migration aborts, the DB rolls back to the prior state
-- (old RPC from 20260711120100, no new index) — a coherent fallback. The prior
-- 20260711120100 RPC is left in place as that baseline; this migration upgrades it
-- in-place as step (e) below.
--
-- Idempotent throughout (OR REPLACE / IF NOT EXISTS / DO blocks that no-op on a
-- second run). Confidence math is NOT reimplemented in SQL: the survivor keeps
-- base = GREATEST(all bases) and the union of every merged row's source classes /
-- metadata.source_category, so the existing read-time TS layer
-- (src/lib/intel.ts adjustedConfidence) remains the single source of truth for the
-- corroboration bonus.

-- ---- #9: confidence bounds, database-level, every insert path -----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_confidence_range' AND conrelid = 'public.artifacts'::regclass
  ) THEN
    ALTER TABLE public.artifacts
      ADD CONSTRAINT artifacts_confidence_range CHECK (confidence BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_memory_confidence_range' AND conrelid = 'public.agent_memory'::regclass
  ) THEN
    ALTER TABLE public.agent_memory
      ADD CONSTRAINT agent_memory_confidence_range CHECK (confidence BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

-- ---- (a) selector-scope function + deterministic metadata-merge helpers -------

-- Canonical dedup SCOPE for an artifact — the discriminator that, together with
-- (thread_id, kind, value, subject), decides whether two rows are the SAME
-- observation. It is derived ONLY from where/what was observed (platform, host,
-- breach identity, explicit selector) and NEVER from the tool `source` name, so a
-- sweep tool reporting one username on 21 platforms yields 21 distinct scopes.
-- IMMUTABLE so it is usable in the UNIQUE INDEX expression and ON CONFLICT target.
CREATE OR REPLACE FUNCTION public.artifact_selector_scope(_kind text, _value text, _source text, _metadata jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- 1. explicit platform → canonical platform alias
    WHEN NULLIF(btrim(_metadata->>'platform'), '') IS NOT NULL THEN
      'plat:' || (CASE lower(btrim(_metadata->>'platform'))
        WHEN 'twitter/x'    THEN 'twitter'
        WHEN 'x/twitter'    THEN 'twitter'
        WHEN 'twitter.com'  THEN 'twitter'
        WHEN 'x'            THEN 'twitter'
        WHEN 'x.com'        THEN 'twitter'
        WHEN 'office365.com' THEN 'office365'
        WHEN 'xbox_gamertag' THEN 'xbox'
        WHEN 'xbox live'    THEN 'xbox'
        ELSE lower(btrim(_metadata->>'platform'))
      END)
    -- 2. source_url → host (scheme + leading www. stripped, lowercased)
    WHEN _metadata->>'source_url' ~* '^https?://' THEN
      'host:' || regexp_replace(
                   regexp_replace(
                     regexp_replace(lower(_metadata->>'source_url'), '^https?://', ''),
                     '[/?#].*$', ''),
                   '^www\.', '')
    -- 3. breach/leak kinds → breach identity; md5 fallback keeps DISTINCT breach
    --    sites/provenance SEPARATE (never merge) when no named breach is present.
    WHEN _kind ~* 'breach|leak|exposure|credential|stealer' THEN
      'breach:' || coalesce(
        NULLIF(lower(btrim(_metadata->>'breach_name')), ''),
        NULLIF(lower(btrim(_metadata->>'breach')), ''),
        NULLIF(lower(btrim(_metadata->>'source_db')), ''),
        NULLIF(lower(btrim(_metadata->>'source_breach_id')), ''),
        NULLIF(lower(btrim(_metadata->>'breach_id')), ''),
        NULLIF(lower(btrim(_metadata->>'source_name')), ''),
        'h' || substr(md5(
          coalesce(_metadata->>'source_url', '') || '|' ||
          coalesce(_source, '')                  || '|' ||
          coalesce(_metadata::text, '')
        ), 1, 16))
    -- 4. explicit selector metadata
    WHEN NULLIF(btrim(_metadata->>'selector'), '') IS NOT NULL THEN
      'sel:' || lower(btrim(_metadata->>'selector'))
    -- 5. no discriminator
    ELSE ''
  END
$$;

-- Normalize metadata->'source_category' (array | scalar string | absent) to a
-- distinct, lower/trimmed jsonb text array. Feeds the survivor's unioned classes.
CREATE OR REPLACE FUNCTION public.artifact_norm_categories(_meta jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT lower(btrim(e)) ORDER BY lower(btrim(e)))
                    FILTER (WHERE btrim(coalesce(e, '')) <> ''), '[]'::jsonb)
  FROM jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(_meta->'source_category') = 'array'  THEN _meta->'source_category'
      WHEN jsonb_typeof(_meta->'source_category') = 'string' THEN jsonb_build_array(_meta->'source_category')
      ELSE '[]'::jsonb
    END
  ) AS e
$$;

-- Distinct raw source provenance strings for an artifact: its own `source` plus
-- any prior metadata.sources array. Preserves original case (only trims/dedups)
-- so the read-time TS layer can still class-split legacy rows lacking a category.
CREATE OR REPLACE FUNCTION public.artifact_norm_sources(_source text, _meta jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT s ORDER BY s) FILTER (WHERE s <> ''), '[]'::jsonb)
  FROM (
    SELECT btrim(_source) AS s WHERE btrim(coalesce(_source, '')) <> ''
    UNION
    SELECT btrim(e) FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(_meta->'sources') = 'array' THEN _meta->'sources' ELSE '[]'::jsonb END
    ) AS e
  ) t
$$;

-- Union of two jsonb text arrays, distinct + ordered (deterministic).
CREATE OR REPLACE FUNCTION public.jsonb_text_union(_a jsonb, _b jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e) FILTER (WHERE e <> ''), '[]'::jsonb)
  FROM (
    SELECT jsonb_array_elements_text(coalesce(_a, '[]'::jsonb)) AS e
    UNION
    SELECT jsonb_array_elements_text(coalesce(_b, '[]'::jsonb))
  ) t
$$;

-- Merge ONE incoming observation into an existing survivor's metadata (the
-- write-path / RPC two-row case). Unions source classes + raw sources, appends a
-- provenance entry (seeding the survivor's own entry if it had none), and extends
-- first/last_seen. Never drops existing survivor keys. Pure in its args (the
-- observation time is passed in) → IMMUTABLE, so it is safe inside ON CONFLICT.
CREATE OR REPLACE FUNCTION public.artifact_merge_incoming(
  _existing jsonb, _existing_id uuid, _existing_source text, _existing_conf int,
  _incoming jsonb, _incoming_id uuid, _incoming_source text, _incoming_conf int,
  _now timestamptz
)
RETURNS jsonb
-- STABLE (not IMMUTABLE): to_jsonb(timestamptz) is timezone-dependent. Only used
-- in ON CONFLICT DO UPDATE at runtime, never in an index, so STABLE is sufficient.
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(_existing, '{}'::jsonb)
    || jsonb_build_object(
         'source_category', public.jsonb_text_union(
             public.artifact_norm_categories(_existing),
             public.artifact_norm_categories(_incoming)),
         'sources', public.jsonb_text_union(
             public.artifact_norm_sources(_existing_source, _existing),
             public.artifact_norm_sources(_incoming_source, _incoming)),
         'provenance',
           (CASE WHEN jsonb_typeof(_existing->'provenance') = 'array'
                 THEN _existing->'provenance'
                 ELSE jsonb_build_array(jsonb_build_object(
                        'artifact_id', to_jsonb(_existing_id),
                        'source',      to_jsonb(_existing_source),
                        'source_url',  _existing->'source_url',
                        'confidence',  to_jsonb(_existing_conf),
                        'created_at',  coalesce(_existing->'first_seen', to_jsonb(_now))
                      )) END)
           || jsonb_build_array(jsonb_build_object(
                'artifact_id', to_jsonb(_incoming_id),
                'source',      to_jsonb(_incoming_source),
                'source_url',  _incoming->'source_url',
                'confidence',  to_jsonb(_incoming_conf),
                'created_at',  to_jsonb(_now)
              )),
         'first_seen', coalesce(_existing->'first_seen', to_jsonb(_now)),
         'last_seen',  to_jsonb(_now)
       )
$$;

-- ---- (b) retain conflicting analyst history across a merge ---------------------
ALTER TABLE public.artifact_reviews ADD COLUMN IF NOT EXISTS merge_lineage jsonb;

-- ---- (c) consolidate pre-existing duplicates under the NEW identity ------------
-- Extracted into an idempotent maintenance function so it can be (i) called once
-- by this migration, and (ii) re-invoked (e.g. the CI idempotency/regression
-- tests, or an ops re-heal) with the SAME guarantees. Returns the number of
-- artifact rows consolidated away (0 when nothing to do). Not granted to any
-- client role — owner/superuser only.
CREATE OR REPLACE FUNCTION public.artifact_consolidate_dupes()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  dup RECORD;
  keep_id uuid;
  all_ids uuid[];
  dupe_ids uuid[];
  _survivor_meta jsonb;
  _merged_meta jsonb;
  _provenance jsonb;
  _cats jsonb;
  _srcs jsonb;
  _max_conf int;
  _first_seen timestamptz;
  _last_seen timestamptz;
  rev_user RECORD;
  _dangling int;
  _removed int := 0;
BEGIN
  FOR dup IN
    SELECT thread_id, kind, value,
           coalesce(NULLIF(btrim(subject_id), ''), '∅') AS subj,
           public.artifact_selector_scope(kind, value, source, metadata) AS scope,
           array_agg(id ORDER BY created_at, id) AS ids
    FROM public.artifacts
    GROUP BY thread_id, kind, value,
             coalesce(NULLIF(btrim(subject_id), ''), '∅'),
             public.artifact_selector_scope(kind, value, source, metadata)
    HAVING count(*) > 1
  LOOP
    all_ids  := dup.ids;
    keep_id  := all_ids[1];
    dupe_ids := all_ids[2:array_length(all_ids, 1)];

    -- Aggregates over the WHOLE group (survivor + dupes).
    SELECT jsonb_agg(
             jsonb_build_object(
               'artifact_id', a.id,
               'source',      a.source,
               'source_url',  a.metadata->'source_url',
               'confidence',  a.confidence,
               'created_at',  a.created_at
             ) ORDER BY a.created_at, a.id),
           max(a.confidence), min(a.created_at), max(a.created_at)
    INTO _provenance, _max_conf, _first_seen, _last_seen
    FROM public.artifacts a
    WHERE a.id = ANY(all_ids);

    SELECT coalesce(jsonb_agg(DISTINCT c ORDER BY c), '[]'::jsonb) INTO _cats
    FROM (
      SELECT jsonb_array_elements_text(public.artifact_norm_categories(a.metadata)) AS c
      FROM public.artifacts a WHERE a.id = ANY(all_ids)
    ) s WHERE c <> '';

    SELECT coalesce(jsonb_agg(DISTINCT s ORDER BY s), '[]'::jsonb) INTO _srcs
    FROM (
      SELECT jsonb_array_elements_text(public.artifact_norm_sources(a.source, a.metadata)) AS s
      FROM public.artifacts a WHERE a.id = ANY(all_ids)
    ) t WHERE s <> '';

    SELECT metadata INTO _survivor_meta FROM public.artifacts WHERE id = keep_id;

    _merged_meta := coalesce(_survivor_meta, '{}'::jsonb)
      || jsonb_build_object(
           'source_category', _cats,
           'sources',         _srcs,
           'provenance',      coalesce(_provenance, '[]'::jsonb),
           'first_seen',      _first_seen,
           'last_seen',       _last_seen,
           'merged_from',     coalesce(_survivor_meta->'merged_from', '[]'::jsonb) || to_jsonb(dupe_ids)
         );

    -- Survivor keeps GREATEST base; the read-time TS layer recomputes the bonus.
    UPDATE public.artifacts SET confidence = _max_conf, metadata = _merged_meta WHERE id = keep_id;

    -- Re-point custody rows — never delete evidence.
    UPDATE public.evidence_log SET artifact_id = keep_id WHERE artifact_id = ANY(dupe_ids);

    -- Re-point analyst reviews, respecting UNIQUE (user_id, artifact_id) and NEVER
    -- silently choosing a winner among conflicting verdicts.
    FOR rev_user IN
      SELECT ar.user_id AS uid,
             count(DISTINCT ar.state) AS distinct_states,
             bool_or(ar.artifact_id = keep_id) AS has_keep,
             jsonb_agg(jsonb_build_object('artifact_id', ar.artifact_id, 'state', ar.state, 'note', ar.note)
                       ORDER BY ar.created_at, ar.id) AS lineage,
             string_agg(NULLIF(btrim(coalesce(ar.note, '')), ''), E'\n---\n' ORDER BY ar.created_at, ar.id) AS notes
      FROM public.artifact_reviews ar
      WHERE ar.artifact_id = ANY(all_ids)
      GROUP BY ar.user_id
    LOOP
      IF rev_user.distinct_states <= 1 THEN
        -- All this user's verdicts agree → keep exactly one row on keep_id.
        IF rev_user.has_keep THEN
          DELETE FROM public.artifact_reviews
            WHERE user_id = rev_user.uid AND artifact_id = ANY(dupe_ids);
        ELSE
          UPDATE public.artifact_reviews SET artifact_id = keep_id
            WHERE id = (SELECT id FROM public.artifact_reviews
                         WHERE user_id = rev_user.uid AND artifact_id = ANY(dupe_ids)
                         ORDER BY created_at, id LIMIT 1);
          DELETE FROM public.artifact_reviews
            WHERE user_id = rev_user.uid AND artifact_id = ANY(dupe_ids);
        END IF;
      ELSE
        -- CONFLICT: force the survivor review to 'recheck', preserve the full
        -- prior verdict list in merge_lineage and the concatenated note history.
        IF rev_user.has_keep THEN
          UPDATE public.artifact_reviews
            SET state = 'recheck', merge_lineage = rev_user.lineage, note = rev_user.notes, updated_at = now()
            WHERE user_id = rev_user.uid AND artifact_id = keep_id;
        ELSE
          UPDATE public.artifact_reviews
            SET artifact_id = keep_id, state = 'recheck', merge_lineage = rev_user.lineage,
                note = rev_user.notes, updated_at = now()
            WHERE id = (SELECT id FROM public.artifact_reviews
                         WHERE user_id = rev_user.uid AND artifact_id = ANY(dupe_ids)
                         ORDER BY created_at, id LIMIT 1);
        END IF;
        DELETE FROM public.artifact_reviews
          WHERE user_id = rev_user.uid AND artifact_id = ANY(dupe_ids);
      END IF;
    END LOOP;

    DELETE FROM public.artifacts WHERE id = ANY(dupe_ids);
    _removed := _removed + coalesce(array_length(dupe_ids, 1), 0);
  END LOOP;

  -- ---- postconditions (abort the whole migration transaction on violation) ----
  IF EXISTS (
    SELECT 1 FROM public.artifacts
    GROUP BY thread_id, kind, value,
             coalesce(NULLIF(btrim(subject_id), ''), '∅'),
             public.artifact_selector_scope(kind, value, source, metadata)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'artifact dedup postcondition failed: a duplicate final-key group with count>1 still exists';
  END IF;

  SELECT count(*) INTO _dangling
  FROM public.evidence_log el
  WHERE el.artifact_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.artifacts a WHERE a.id = el.artifact_id);
  IF _dangling > 0 THEN
    RAISE EXCEPTION 'evidence_log has % row(s) pointing at a deleted artifact after consolidation', _dangling;
  END IF;

  SELECT count(*) INTO _dangling
  FROM public.artifact_reviews ar
  WHERE NOT EXISTS (SELECT 1 FROM public.artifacts a WHERE a.id = ar.artifact_id);
  IF _dangling > 0 THEN
    RAISE EXCEPTION 'artifact_reviews has % row(s) pointing at a deleted artifact after consolidation', _dangling;
  END IF;

  RETURN _removed;
END $$;

-- Run the consolidation once now (before the UNIQUE INDEX below can be created).
SELECT public.artifact_consolidate_dupes();

-- ---- (d) enforce the selector-scope identity ----------------------------------
-- Self-healing: drop the old UNSAFE index name if a prior attempt created it.
DROP INDEX IF EXISTS public.artifacts_thread_kind_value_source_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_selector_scope_uidx
  ON public.artifacts (
    thread_id, kind, value,
    (coalesce(NULLIF(btrim(subject_id), ''), '∅')),
    public.artifact_selector_scope(kind, value, source, metadata)
  );

-- ---- (e) upgrade the write-path RPC to the SAME selector-scope identity --------
-- Created here (after the index) so the ON CONFLICT inference always resolves the
-- index that exists in this same transaction. Everything about the evidence hash
-- chain (seq allocation, prev_hash, 9-field content_hash, chain_hash,
-- unique_violation retry, thread FOR UPDATE, auth checks) is preserved EXACTLY;
-- ONLY the artifact idempotency changed: the race-prone SELECT-then-INSERT is now
-- an atomic INSERT ... ON CONFLICT DO UPDATE that MERGES provenance/classes and
-- lifts confidence to the max base. A new observation is ALWAYS logged to
-- evidence_log (on both a fresh insert and a merge); `deduped` reports whether the
-- artifact row was merged (xmax<>0) rather than freshly inserted.
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
  _art_id uuid; _was_merge boolean;
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

    _class    := CASE WHEN COALESCE(_conf,0) >= 85 THEN 'hard' ELSE 'soft' END;
    _src_url  := _meta->>'source_url';
    _snapshot := left(_meta::text, 1500);

    -- Atomic idempotent upsert on the selector-scope identity. Same selector
    -- function as the migration's UNIQUE INDEX, so runtime and consolidation
    -- derive identical keys — a distinct-platform row can NEVER be wrongly merged.
    INSERT INTO public.artifacts (thread_id, user_id, kind, value, confidence, source, metadata, cluster_id, subject_id)
    VALUES (_thread_id, _uid, _kind, _value, _conf, _source, _meta, _row->>'cluster_id', _row->>'subject_id')
    ON CONFLICT (thread_id, kind, value,
                 (coalesce(NULLIF(btrim(subject_id), ''), '∅')),
                 public.artifact_selector_scope(kind, value, source, metadata))
    DO UPDATE SET
      metadata = public.artifact_merge_incoming(
                   artifacts.metadata, artifacts.id, artifacts.source, artifacts.confidence,
                   EXCLUDED.metadata, artifacts.id, EXCLUDED.source, EXCLUDED.confidence, now()),
      confidence = GREATEST(artifacts.confidence, EXCLUDED.confidence)
    -- xid has no `<>` operator; compare via text so this is portable. xmax='0'
    -- on a fresh INSERT and a live xid on an ON CONFLICT UPDATE → was_merge.
    RETURNING id, (xmax::text <> '0') INTO _art_id, _was_merge;

    -- A new observation is ALWAYS logged to the custody chain — insert OR merge.
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

    artifact_id := _art_id; evidence_id := _ev_id; seq := _seq; deduped := _was_merge;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_artifacts_with_evidence(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_artifacts_with_evidence(uuid, jsonb) TO authenticated, service_role;
