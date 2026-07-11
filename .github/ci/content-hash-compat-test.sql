-- CI regression (PR #305): prove record_artifacts_with_evidence writes a
-- tamper-evident chain that is BYTE-FOR-BYTE compatible with the legacy
-- append_evidence construction, and that both writers share ONE chain that
-- verify_evidence_chain accepts.
--
-- "Compatible" here is the load-bearing property: every row's stored
-- content_hash must equal the canonical 9-field hash RECOMPUTED FROM ITS OWN
-- STORED COLUMNS in append_evidence's exact field order
--   (tool_name, source, source_url, classification, confidence, kind, value,
--    content_snapshot, metadata)
-- with append_evidence's exact null/separator/coalesce/cast handling. This is
-- what lets an independent auditor recompute content_hash from evidence_log and
-- detect tampering — the new writer must not break it.
--
-- Runs AFTER the migrations apply, in the "Migrations (psql validation)" job.
-- It is NOT a migration (never ships to prod). auth.uid() resolves from the GUC
-- the platform shim reads (request.jwt.claim.sub). psql runs as the superuser,
-- so it bypasses RLS to seed the thread; the SECURITY DEFINER RPCs still see the
-- session GUC, so their auth.uid() + thread-ownership guards are exercised for real.

SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', false);

DO $$
DECLARE
  _uid uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  _tid uuid;
  r record;
  _recompute text;
  _chain record;
  _rows jsonb;
  _n int;
BEGIN
  INSERT INTO auth.users(id, email) VALUES (_uid, 'ci@example.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- Matrix: normal row; NULL confidence + no metadata key (coalesce '{}');
  -- Unicode + emoji + an embedded '|' separator + angle brackets in the value;
  -- a related-account row; and an EXACT duplicate of row 1 (must dedup).
  _rows := jsonb_build_array(
    jsonb_build_object('kind','username','value','https://instagram.com/pjsmakka','confidence',50,
      'source','anchor_profile_read',
      'metadata', jsonb_build_object('source_url','https://instagram.com/pjsmakka/','platform','instagram')),
    jsonb_build_object('kind','url','value','http://example.com/a',
      'source','anchor_profile_read',
      'metadata', jsonb_build_object('source_url','http://example.com/a')),
    jsonb_build_object('kind','name','value', E'naïve café \U0001F525 <script>|pipe',
      'confidence',45,'source','anchor_serp_read'),
    jsonb_build_object('kind','username','value','rel_account','confidence',30,
      'source','anchor_profile_read'),
    jsonb_build_object('kind','username','value','https://instagram.com/pjsmakka','confidence',50,
      'source','anchor_profile_read',
      'metadata', jsonb_build_object('source_url','https://instagram.com/pjsmakka/','platform','instagram'))
  );

  PERFORM public.record_artifacts_with_evidence(_tid, _rows);

  -- Cross-writer: append_evidence continues the SAME chain (different tool_name
  -- vs source, so the loop below also proves append_evidence's own rows recompute).
  PERFORM public.append_evidence(_tid, NULL, 'manual_tool', 'manual_source', NULL,
                                 'soft', 60, 'note', 'v', 'snap', '{}'::jsonb);

  -- (1) Every row (from BOTH writers) must recompute canonically from its columns.
  FOR r IN SELECT * FROM public.evidence_log WHERE thread_id = _tid ORDER BY seq LOOP
    _recompute := encode(digest(
      coalesce(r.tool_name, '')        || '|' ||
      coalesce(r.source, '')           || '|' ||
      coalesce(r.source_url, '')       || '|' ||
      r.classification                 || '|' ||
      coalesce(r.confidence::text, '') || '|' ||
      coalesce(r.kind, '')             || '|' ||
      coalesce(r.value, '')            || '|' ||
      coalesce(r.content_snapshot, '') || '|' ||
      coalesce(r.metadata::text, '{}'),
      'sha256'), 'hex');
    IF _recompute IS DISTINCT FROM r.content_hash THEN
      RAISE EXCEPTION 'content_hash NOT canonical-recomputable at seq %: stored=% recompute=%',
        r.seq, r.content_hash, _recompute;
    END IF;
  END LOOP;

  -- (2) Idempotent dedup: 5 rows in, 1 exact dup → 4 recorded; +1 append = 5.
  SELECT count(*) INTO _n FROM public.evidence_log WHERE thread_id = _tid;
  IF _n <> 5 THEN RAISE EXCEPTION 'expected 5 evidence rows (4 recorded + 1 append), got %', _n; END IF;

  -- (3) Retry idempotency: re-running the same rows records NOTHING new.
  PERFORM public.record_artifacts_with_evidence(_tid, _rows);
  SELECT count(*) INTO _n FROM public.evidence_log WHERE thread_id = _tid;
  IF _n <> 5 THEN RAISE EXCEPTION 'retry duplicated evidence rows: now %', _n; END IF;

  -- (4) The combined chain (both writers) must verify with no break.
  SELECT * INTO _chain FROM public.verify_evidence_chain(_tid);
  IF NOT _chain.ok THEN RAISE EXCEPTION 'evidence chain invalid, first_break=%', _chain.first_break; END IF;
  IF _chain.total <> 5 THEN RAISE EXCEPTION 'chain total expected 5, got %', _chain.total; END IF;

  RAISE NOTICE 'content-hash compat OK: % rows, canonical-recomputable, chain valid, dedup+retry idempotent', _chain.total;
END $$;
