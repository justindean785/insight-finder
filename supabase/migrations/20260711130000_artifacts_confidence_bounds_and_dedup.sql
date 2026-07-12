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

-- ---- (b2) THE single canonical merge --------------------------------------------
-- Fold `_loser` into `_survivor` (same thread + same user only). This is the ONE
-- implementation shared by BOTH the migration/ops consolidation AND the runtime
-- cluster subject-reassignment collision path, so all merge semantics agree. The
-- CALLER decides who survives; the survivor's subject_id and cluster_id are
-- PRESERVED (never touched here) — only provenance/classes/sources/first-last_seen
-- are unioned in, confidence lifted to GREATEST, custody + analyst reviews
-- re-pointed (conflicting verdicts → recheck + full merge_lineage), and the loser
-- deleted. Reuses artifact_norm_categories / artifact_norm_sources /
-- jsonb_text_union (no forked merge logic). Rows are locked in deterministic id
-- order to avoid deadlocks between concurrent merges.
--
-- SECURITY DEFINER + not client-exposed: cross-thread / cross-user merges are
-- rejected INSIDE the function, and EXECUTE is revoked from PUBLIC/anon/
-- authenticated and granted only to service_role (the admin cluster path).
CREATE OR REPLACE FUNCTION public.merge_artifact_into(_loser uuid, _survivor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _lo uuid; _hi uuid;
  _l_thread uuid; _l_user uuid; _l_meta jsonb; _l_source text; _l_conf int; _l_created timestamptz;
  _s_thread uuid; _s_user uuid; _s_meta jsonb; _s_source text; _s_conf int; _s_created timestamptz;
  _merged_meta jsonb;
  _provenance jsonb;
  _first_seen timestamptz;
  _last_seen timestamptz;
  rev_user RECORD;
BEGIN
  IF _loser IS NULL OR _survivor IS NULL THEN
    RAISE EXCEPTION 'merge_artifact_into: null artifact id (loser=%, survivor=%)', _loser, _survivor;
  END IF;
  IF _loser = _survivor THEN RETURN _survivor; END IF;

  -- Deterministic lock order (least,greatest) → no deadlock between mirror merges.
  _lo := least(_loser, _survivor);
  _hi := greatest(_loser, _survivor);
  PERFORM 1 FROM public.artifacts WHERE id = _lo FOR UPDATE;
  PERFORM 1 FROM public.artifacts WHERE id = _hi FOR UPDATE;

  SELECT thread_id, user_id, metadata, source, confidence, created_at
    INTO _l_thread, _l_user, _l_meta, _l_source, _l_conf, _l_created
    FROM public.artifacts WHERE id = _loser;
  SELECT thread_id, user_id, metadata, source, confidence, created_at
    INTO _s_thread, _s_user, _s_meta, _s_source, _s_conf, _s_created
    FROM public.artifacts WHERE id = _survivor;

  IF _l_thread IS NULL OR _s_thread IS NULL THEN
    RAISE EXCEPTION 'merge_artifact_into: loser % or survivor % not found', _loser, _survivor;
  END IF;
  IF _l_thread IS DISTINCT FROM _s_thread THEN
    RAISE EXCEPTION 'merge_artifact_into: cross-thread merge rejected (loser thread %, survivor thread %)', _l_thread, _s_thread;
  END IF;
  IF _l_user IS DISTINCT FROM _s_user THEN
    RAISE EXCEPTION 'merge_artifact_into: cross-user merge rejected (loser user %, survivor user %)', _l_user, _s_user;
  END IF;

  -- provenance: keep each row's prior provenance array if it has one, else seed a
  -- single entry from its own columns; survivor first, then loser.
  _provenance :=
    (CASE WHEN jsonb_typeof(_s_meta->'provenance') = 'array' THEN _s_meta->'provenance'
          ELSE jsonb_build_array(jsonb_build_object(
                 'artifact_id', to_jsonb(_survivor), 'source', to_jsonb(_s_source),
                 'source_url', _s_meta->'source_url', 'confidence', to_jsonb(_s_conf),
                 'created_at', coalesce(_s_meta->'first_seen', to_jsonb(_s_created)))) END)
    ||
    (CASE WHEN jsonb_typeof(_l_meta->'provenance') = 'array' THEN _l_meta->'provenance'
          ELSE jsonb_build_array(jsonb_build_object(
                 'artifact_id', to_jsonb(_loser), 'source', to_jsonb(_l_source),
                 'source_url', _l_meta->'source_url', 'confidence', to_jsonb(_l_conf),
                 'created_at', coalesce(_l_meta->'first_seen', to_jsonb(_l_created)))) END);

  _first_seen := least(
    coalesce(NULLIF(_s_meta->>'first_seen','')::timestamptz, _s_created),
    coalesce(NULLIF(_l_meta->>'first_seen','')::timestamptz, _l_created));
  _last_seen := greatest(
    coalesce(NULLIF(_s_meta->>'last_seen','')::timestamptz, _s_created),
    coalesce(NULLIF(_l_meta->>'last_seen','')::timestamptz, _l_created));

  -- Start from the survivor's metadata so its keys (incl. cluster_id/subject_id
  -- surfaced by the cluster path, promoted_confidence, etc.) are all preserved.
  _merged_meta := coalesce(_s_meta, '{}'::jsonb)
    || jsonb_build_object(
         'source_category', public.jsonb_text_union(
             public.artifact_norm_categories(_s_meta), public.artifact_norm_categories(_l_meta)),
         'sources', public.jsonb_text_union(
             public.artifact_norm_sources(_s_source, _s_meta), public.artifact_norm_sources(_l_source, _l_meta)),
         'provenance', _provenance,
         'first_seen', to_jsonb(_first_seen),
         'last_seen',  to_jsonb(_last_seen),
         'merged_from', coalesce(_s_meta->'merged_from', '[]'::jsonb)
                        || coalesce(_l_meta->'merged_from', '[]'::jsonb)
                        || to_jsonb(ARRAY[_loser])
       );

  -- Survivor keeps its subject_id/cluster_id; only base + metadata change.
  UPDATE public.artifacts
     SET metadata = _merged_meta, confidence = GREATEST(_s_conf, _l_conf)
   WHERE id = _survivor;

  -- Re-point custody — never delete evidence.
  UPDATE public.evidence_log SET artifact_id = _survivor WHERE artifact_id = _loser;

  -- Re-point analyst reviews (UNIQUE(user_id, artifact_id) → at most one row per
  -- user per artifact). Conflicting verdicts across loser/survivor → recheck +
  -- full merge_lineage + concatenated notes; never silently pick a winner.
  FOR rev_user IN
    SELECT ar.user_id AS uid,
           count(DISTINCT ar.state) AS distinct_states,
           bool_or(ar.artifact_id = _survivor) AS has_surv,
           jsonb_agg(jsonb_build_object('artifact_id', ar.artifact_id, 'state', ar.state, 'note', ar.note)
                     ORDER BY ar.created_at, ar.id) AS lineage,
           string_agg(NULLIF(btrim(coalesce(ar.note, '')), ''), E'\n---\n' ORDER BY ar.created_at, ar.id) AS notes
    FROM public.artifact_reviews ar
    WHERE ar.artifact_id IN (_loser, _survivor)
    GROUP BY ar.user_id
  LOOP
    IF rev_user.distinct_states <= 1 THEN
      IF rev_user.has_surv THEN
        DELETE FROM public.artifact_reviews WHERE user_id = rev_user.uid AND artifact_id = _loser;
      ELSE
        UPDATE public.artifact_reviews SET artifact_id = _survivor
          WHERE user_id = rev_user.uid AND artifact_id = _loser;
      END IF;
    ELSE
      IF rev_user.has_surv THEN
        UPDATE public.artifact_reviews
          SET state = 'recheck', merge_lineage = rev_user.lineage, note = rev_user.notes, updated_at = now()
          WHERE user_id = rev_user.uid AND artifact_id = _survivor;
        DELETE FROM public.artifact_reviews WHERE user_id = rev_user.uid AND artifact_id = _loser;
      ELSE
        UPDATE public.artifact_reviews
          SET artifact_id = _survivor, state = 'recheck', merge_lineage = rev_user.lineage,
              note = rev_user.notes, updated_at = now()
          WHERE user_id = rev_user.uid AND artifact_id = _loser;
      END IF;
    END IF;
  END LOOP;

  DELETE FROM public.artifacts WHERE id = _loser;
  RETURN _survivor;
END $$;

REVOKE EXECUTE ON FUNCTION public.merge_artifact_into(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.merge_artifact_into(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_artifact_into(uuid, uuid) TO service_role;

-- Locate the pre-existing artifact that a row `_loser` would COLLIDE with if it
-- were reassigned to subject `_subject_id` — i.e. the same-thread row sharing
-- kind + value + subject sentinel + selector scope. Returns its id (the merge
-- survivor) or NULL. Read-only; service_role only. Keeps the selector-scope
-- derivation server-side so the runtime never forks that logic into TypeScript.
CREATE OR REPLACE FUNCTION public.find_artifact_selector_collision(_loser uuid, _subject_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _thread uuid; _kind text; _value text; _source text; _meta jsonb; _scope text; _subj text; _sid uuid;
BEGIN
  SELECT thread_id, kind, value, source, metadata
    INTO _thread, _kind, _value, _source, _meta
    FROM public.artifacts WHERE id = _loser;
  IF _thread IS NULL THEN RETURN NULL; END IF;
  _scope := public.artifact_selector_scope(_kind, _value, _source, _meta);
  _subj  := coalesce(NULLIF(btrim(_subject_id), ''), '∅');
  SELECT id INTO _sid FROM public.artifacts
    WHERE thread_id = _thread AND kind = _kind AND value = _value
      AND coalesce(NULLIF(btrim(subject_id), ''), '∅') = _subj
      AND public.artifact_selector_scope(kind, value, source, metadata) = _scope
      AND id <> _loser
    LIMIT 1;
  RETURN _sid;
END $$;

REVOKE EXECUTE ON FUNCTION public.find_artifact_selector_collision(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.find_artifact_selector_collision(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_artifact_selector_collision(uuid, text) TO service_role;

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
  _loser uuid;
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
    all_ids := dup.ids;
    keep_id := all_ids[1];  -- earliest (created_at, id) survives
    -- Fold every other row into the survivor via the ONE canonical merge, so the
    -- migration/ops path and the runtime cluster path share identical semantics.
    FOREACH _loser IN ARRAY all_ids[2:array_length(all_ids, 1)]
    LOOP
      PERFORM public.merge_artifact_into(_loser, keep_id);
      _removed := _removed + 1;
    END LOOP;
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

-- Maintenance-only surface: this is invoked by THIS migration (as the owner) and by
-- the service role; no client ever calls it. A function whose ACL is never touched
-- keeps Postgres' default grant of EXECUTE to PUBLIC, so revoke it explicitly rather
-- than relying on it being "internal". (It is SECURITY INVOKER and its inner
-- merge_artifact_into is already service-role-only, so a client call could not have
-- destroyed data — it would have hit permission-denied mid-merge. It still has no
-- business being callable.) The owner retains EXECUTE regardless, so the call below
-- is unaffected.
REVOKE EXECUTE ON FUNCTION public.artifact_consolidate_dupes() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.artifact_consolidate_dupes() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.artifact_consolidate_dupes() TO service_role;

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
