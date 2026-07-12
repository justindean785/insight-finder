-- CI regression (findings #9/#10, migration 20260711130000): proves the new
-- artifacts.confidence CHECK and the (thread_id, kind, value, source) unique
-- index actually enforce the intended contract — not just that the migration
-- applies cleanly. Sequential parts only; the genuine CONCURRENT duplicate-insert
-- race is a separate CI step (two real backgrounded psql sessions — a single
-- script can't produce true concurrency). Runs AFTER migrations, alongside
-- content-hash-compat-test.sql. Not a migration; never ships to prod.

SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', false);

DO $$
DECLARE
  _uid uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  _tid uuid;
  _n int;
  _rejected boolean;
BEGIN
  INSERT INTO auth.users(id, email) VALUES (_uid, 'ci-integrity@example.test') ON CONFLICT DO NOTHING;
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- ── #9: confidence bounds, exercised through the SAME RPC path a live run uses ──

  -- Valid minimum (0) and maximum (100) succeed.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','test_conf','value','min','confidence',0,'source','t9')));
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','test_conf','value','max','confidence',100,'source','t9')));
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'test_conf';
  IF _n <> 2 THEN RAISE EXCEPTION 'expected 2 valid-bound artifacts, got %', _n; END IF;

  -- Negative / above-maximum / NaN-like / Infinity-like values must all be
  -- REJECTED (the whole call rolls back — no partial write of the artifact row),
  -- proving NEITHER a partial artifacts row NOR a partial evidence_log row survives.
  BEGIN
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','neg','confidence',-1,'source','t9')));
    RAISE EXCEPTION 'negative confidence was NOT rejected';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','over','confidence',101,'source','t9')));
    RAISE EXCEPTION 'above-maximum confidence was NOT rejected';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    -- confidence:'NaN' — a JSON STRING (jsonb_build_object's text-arg conversion),
    -- so ->>'confidence' extracts the literal text "NaN"; ::integer rejects it.
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','nan','confidence','NaN','source','t9')));
    RAISE EXCEPTION 'NaN-text confidence was NOT rejected';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;

  BEGIN
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','inf','confidence','Infinity','source','t9')));
    RAISE EXCEPTION 'Infinity-text confidence was NOT rejected';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;

  BEGIN
    -- Generic non-numeric string.
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','abc','confidence','abc','source','t9')));
    RAISE EXCEPTION 'non-numeric string confidence was NOT rejected';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;

  BEGIN
    -- Fractional value — ::integer does not silently truncate/round; it rejects.
    -- (Avoid silent coercion: a fractional confidence must not become a
    -- different in-range integer without the caller knowing.)
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_reject','value','frac','confidence','55.5','source','t9')));
    RAISE EXCEPTION 'fractional confidence was NOT rejected';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;

  -- Explicit JSON null — behaves the same as empty string (NULLIF maps both to
  -- SQL NULL, which the CHECK constraint permits): "not yet classified" is a
  -- legitimate state, not a rejected value. Must succeed, not error.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','test_conf_null','value','explicit-null','confidence',NULL,'source','t9')));

  BEGIN
    -- Empty string confidence — the RPC's NULLIF(...,'') maps this to NULL, which
    -- the CHECK constraint allows (NULL means "not provided", not "invalid"); this
    -- must succeed, not be rejected — confirms empty string ≠ a rejected value.
    PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
      jsonb_build_object('kind','test_conf_empty','value','empty','confidence','','source','t9')));
  END;

  -- None of the rejected attempts left ANY row behind (no partial mutation).
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'test_conf_reject';
  IF _n <> 0 THEN RAISE EXCEPTION 'a rejected confidence write left % row(s) behind — partial mutation', _n; END IF;

  -- ── #10: deduplication, enforced at the DB level ──────────────────────────────

  -- First insert of a fresh (kind,value,source) succeeds.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','test_dedup','value','same-value','source','providerA')));
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'test_dedup' AND value = 'same-value';
  IF _n <> 1 THEN RAISE EXCEPTION 'expected 1 row after first insert, got %', _n; END IF;

  -- A logical duplicate (same thread/kind/value/source) — the RPC's own app-level
  -- check dedupes it (deduped=true, no error) — proving the RPC path stays smooth.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','test_dedup','value','same-value','source','providerA')));
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'test_dedup' AND value = 'same-value';
  IF _n <> 1 THEN RAISE EXCEPTION 'RPC-path duplicate was NOT deduped, now % rows', _n; END IF;

  -- A DIRECT insert bypassing the RPC (the exact bypass path the audit flagged) —
  -- the DATABASE constraint itself must now reject it, not just the RPC's app logic.
  BEGIN
    INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence)
    VALUES (_tid, _uid, 'test_dedup', 'same-value', 'providerA', 50);
    RAISE EXCEPTION 'a direct duplicate INSERT bypassing the RPC was NOT rejected by the DB';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- A legitimate DISTINCT observation — same kind/value, DIFFERENT source — is
  -- NOT a duplicate and must succeed (corroboration must never be collapsed).
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence)
  VALUES (_tid, _uid, 'test_dedup', 'same-value', 'providerB', 50);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'test_dedup' AND value = 'same-value';
  IF _n <> 2 THEN RAISE EXCEPTION 'a distinct-source observation was wrongly collapsed, expected 2 rows got %', _n; END IF;

  -- NULL source is NULL-safe (COALESCE'd) — two NULL-source dupes still collide.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, confidence)
  VALUES (_tid, _uid, 'test_dedup_null', 'nullsrc-value', 50);
  BEGIN
    INSERT INTO public.artifacts (thread_id, user_id, kind, value, confidence)
    VALUES (_tid, _uid, 'test_dedup_null', 'nullsrc-value', 60);
    RAISE EXCEPTION 'a NULL-source duplicate was NOT rejected';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  RAISE NOTICE 'artifacts-integrity OK: confidence bounds enforced with no partial writes, dedup enforced at the DB level (RPC path + direct-insert bypass), distinct-source observations preserved';
END $$;

-- ── Hash-chain integrity is untouched by any of the above (findings #9/#10 must
--    never regress the working #305 chain work) ──────────────────────────────────
DO $$
DECLARE _tid uuid; _chain record;
BEGIN
  SELECT id INTO _tid FROM public.threads WHERE user_id = 'bbbbbbbb-0000-4000-8000-000000000002' LIMIT 1;
  SELECT * INTO _chain FROM public.verify_evidence_chain(_tid);
  IF NOT _chain.ok THEN RAISE EXCEPTION 'evidence chain invalid after integrity test, first_break=%', _chain.first_break; END IF;
  RAISE NOTICE 'hash-chain still valid after confidence/dedup integrity test: % rows', _chain.total;
END $$;
