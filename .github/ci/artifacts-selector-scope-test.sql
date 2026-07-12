-- CI regression (selector-scope dedup, migration 20260711130000): proves the
-- selector-scope identity + provenance-merge does NOT collapse distinct-platform /
-- distinct-subject / distinct-host / distinct-breach observations (the #305
-- data-loss the naive (thread,kind,value,source) key would have caused), that a
-- genuine duplicate collapses to ONE survivor carrying BOTH provenances and the
-- union of source classes, that conflicting analyst verdicts survive as 'recheck'
-- with full lineage, and that the runtime RPC key == the migration key.
--
-- Runs AFTER migrations, in the "Migrations (psql validation)" job. Part A drops
-- the unique index inside a transaction so it can seed pre-existing duplicates,
-- exercises public.artifact_consolidate_dupes(), then ROLLS BACK — restoring the
-- index and discarding all test rows so later CI steps see a pristine DB. Part B
-- exercises the live RPC with the index in place. Not a migration; never ships.

SELECT set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', false);
INSERT INTO auth.users(id, email)
  VALUES ('cccccccc-0000-4000-8000-000000000003', 'ci-selscope@example.test')
  ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part A — migration consolidation (index dropped, rolled back at the end)
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _n int;
  _removed1 int;
  _removed2 int;
  _aid_a uuid;
  _aid_b uuid;
  _meta jsonb;
  _conf int;
  _rev_state text;
  _rev_note text;
  _rev_lineage jsonb;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- Seed duplicates only possible with the index temporarily gone.
  DROP INDEX public.artifacts_selector_scope_uidx;

  -- (1) Same username on 21 DISTINCT platforms → 21 distinct scopes → 21 retained.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata)
  SELECT _tid, _uid, 'username', 'alice_21', 'username_sweep', 50, jsonb_build_object('platform', p)
  FROM unnest(ARRAY['github','reddit','instagram','tiktok','twitch','youtube','facebook',
                    'linkedin','pinterest','snapchat','telegram','discord','mastodon','spotify',
                    'soundcloud','medium','tumblr','flickr','vimeo','steam','patreon']) AS p;

  -- Platform ALIASES canonicalize: twitter.com + x → 'twitter' → SAME scope → 1.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata) VALUES
    (_tid, _uid, 'username', 'alias_user', 'username_sweep', 50, '{"platform":"twitter.com"}'::jsonb),
    (_tid, _uid, 'username', 'alias_user', 'username_sweep', 50, '{"platform":"x"}'::jsonb);

  -- (2) Same user/platform/subject/provenance repeated 3× → collapses to 1.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id)
  SELECT _tid, _uid, 'email', 'bob@example.com', 'holehe', 50,
         '{"platform":"spotify"}'::jsonb, 'subjA'
  FROM generate_series(1, 3);

  -- (3) Same value+platform but DIFFERENT subject_id → distinct subjects → 2 kept.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id) VALUES
    (_tid, _uid, 'username', 'carol', 'username_sweep', 50, '{"platform":"github"}'::jsonb, 's1'),
    (_tid, _uid, 'username', 'carol', 'username_sweep', 50, '{"platform":"github"}'::jsonb, 's2');

  -- (4) Same value+platform+subject via two DIFFERENT tools/source_urls → 1 survivor
  --     carrying BOTH provenances + union of source classes + GREATEST confidence.
  --     Earlier row (keep) has the LOWER base to prove confidence lifts to max.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id, created_at)
  VALUES (_tid, _uid, 'username', 'dave', 'username_sweep', 40,
          '{"platform":"github","source_url":"https://github.com/dave","source_category":["username_sweep"]}'::jsonb,
          's1', '2020-01-01T00:00:00Z');
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id, created_at)
  VALUES (_tid, _uid, 'username', 'dave', 'github_user', 60,
          '{"platform":"github","source_url":"https://github.com/dave","source_category":["direct_profile"]}'::jsonb,
          's1', '2020-01-02T00:00:00Z');

  -- (5) NULL/absent platform vs a known platform → different scopes → never merge.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata) VALUES
    (_tid, _uid, 'handle', 'eve', 'some_tool', 50, '{}'::jsonb),
    (_tid, _uid, 'handle', 'eve', 'some_tool', 50, '{"platform":"mastodon"}'::jsonb);

  -- (review-conflict) two artifacts that MERGE, each with a conflicting verdict.
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id, created_at)
  VALUES (_tid, _uid, 'email', 'grace@example.com', 'holehe', 50,
          '{"platform":"linkedin"}'::jsonb, 's1', '2020-02-01T00:00:00Z')
  RETURNING id INTO _aid_a;
  INSERT INTO public.artifacts (thread_id, user_id, kind, value, source, confidence, metadata, subject_id, created_at)
  VALUES (_tid, _uid, 'email', 'grace@example.com', 'ghunt', 55,
          '{"platform":"linkedin"}'::jsonb, 's1', '2020-02-02T00:00:00Z')
  RETURNING id INTO _aid_b;
  INSERT INTO public.artifact_reviews (thread_id, artifact_id, user_id, state, note) VALUES
    (_tid, _aid_a, _uid, 'confirmed', 'looks right'),
    (_tid, _aid_b, _uid, 'dismissed', 'no, wrong person');

  -- ── consolidate (first run) ──────────────────────────────────────────────────
  _removed1 := public.artifact_consolidate_dupes();
  IF _removed1 <= 0 THEN RAISE EXCEPTION 'consolidation removed nothing — the fixtures did not collapse'; END IF;

  -- (1) 21 platforms retained.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'alice_21';
  IF _n <> 21 THEN RAISE EXCEPTION '(1) 21 distinct platforms collapsed to % rows', _n; END IF;

  -- alias → 1.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'alias_user';
  IF _n <> 1 THEN RAISE EXCEPTION '(alias) twitter.com/x did not canonicalize to one row, got %', _n; END IF;

  -- (2) → 1.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'bob@example.com';
  IF _n <> 1 THEN RAISE EXCEPTION '(2) identical rows did not collapse to 1, got %', _n; END IF;

  -- (3) different subject → 2.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'carol';
  IF _n <> 2 THEN RAISE EXCEPTION '(3) distinct subject_id was collapsed, got % rows', _n; END IF;

  -- (4) → 1 survivor with both provenances, union classes, GREATEST confidence.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'dave';
  IF _n <> 1 THEN RAISE EXCEPTION '(4) two-tool duplicate did not collapse to 1, got %', _n; END IF;
  SELECT metadata, confidence INTO _meta, _conf
    FROM public.artifacts WHERE thread_id = _tid AND value = 'dave';
  IF _conf <> 60 THEN RAISE EXCEPTION '(4) survivor confidence expected GREATEST=60, got %', _conf; END IF;
  IF jsonb_array_length(_meta->'provenance') <> 2 THEN
    RAISE EXCEPTION '(4) survivor provenance expected 2 entries, got %', jsonb_array_length(_meta->'provenance'); END IF;
  IF NOT (_meta->'source_category' @> '["username_sweep","direct_profile"]'::jsonb)
     OR jsonb_array_length(_meta->'source_category') <> 2 THEN
    RAISE EXCEPTION '(4) survivor source_category not the union of both classes: %', _meta->'source_category'; END IF;
  IF jsonb_array_length(_meta->'merged_from') <> 1 THEN
    RAISE EXCEPTION '(4) survivor merged_from expected 1 id, got %', _meta->'merged_from'; END IF;
  IF NOT (_meta ? 'first_seen' AND _meta ? 'last_seen') THEN
    RAISE EXCEPTION '(4) survivor missing first_seen/last_seen'; END IF;

  -- (5) NULL vs known platform → 2.
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND value = 'eve';
  IF _n <> 2 THEN RAISE EXCEPTION '(5) NULL-platform and known-platform were merged, got % rows', _n; END IF;

  -- (review-conflict) survivor review forced to recheck with full lineage.
  SELECT count(*) INTO _n FROM public.artifact_reviews
    WHERE user_id = _uid AND artifact_id = _aid_a;
  IF _n <> 1 THEN RAISE EXCEPTION '(review) expected exactly 1 survivor review on keep_id, got %', _n; END IF;
  SELECT count(*) INTO _n FROM public.artifact_reviews
    WHERE user_id = _uid AND artifact_id = _aid_b;
  IF _n <> 0 THEN RAISE EXCEPTION '(review) the dupe-pointed review was not removed, still % rows', _n; END IF;
  SELECT state, note, merge_lineage INTO _rev_state, _rev_note, _rev_lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _aid_a;
  IF _rev_state <> 'recheck' THEN RAISE EXCEPTION '(review) conflicting verdicts did not force recheck, got %', _rev_state; END IF;
  IF jsonb_array_length(_rev_lineage) <> 2 THEN RAISE EXCEPTION '(review) merge_lineage expected 2 entries, got %', _rev_lineage; END IF;
  IF NOT (_rev_lineage @> '[{"state":"confirmed"}]'::jsonb AND _rev_lineage @> '[{"state":"dismissed"}]'::jsonb) THEN
    RAISE EXCEPTION '(review) merge_lineage lost a prior verdict: %', _rev_lineage; END IF;
  IF _rev_note NOT LIKE '%looks right%' OR _rev_note NOT LIKE '%wrong person%' THEN
    RAISE EXCEPTION '(review) note history was not preserved: %', _rev_note; END IF;

  -- (7) idempotency: a second consolidation collapses NOTHING and asserts still pass.
  _removed2 := public.artifact_consolidate_dupes();
  IF _removed2 <> 0 THEN RAISE EXCEPTION '(7) second consolidation was not idempotent, removed % rows', _removed2; END IF;

  RAISE NOTICE 'selector-scope consolidation (Part A) OK: 21 platforms + distinct subjects/hosts preserved, dupes merged with provenance, conflicting verdicts → recheck, idempotent';
END $$;
ROLLBACK;  -- restores artifacts_selector_scope_uidx and discards all Part A rows

-- ══════════════════════════════════════════════════════════════════════════════
-- Part B — runtime RPC key == migration key (index in place)
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _n int;
  _dd boolean;
  _meta jsonb;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- (6a) First insert of an identity → fresh artifact (deduped=false).
  SELECT deduped INTO _dd FROM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','frank','source','github_user',
      'metadata', jsonb_build_object('platform','github')))) LIMIT 1;
  IF _dd THEN RAISE EXCEPTION '(6) first insert wrongly reported as a merge'; END IF;

  -- (6b) Second insert of the SAME identity (different tool) → merges (deduped=true),
  --      yields ONE artifact whose metadata now carries BOTH provenance entries.
  SELECT deduped INTO _dd FROM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','frank','source','username_sweep',
      'metadata', jsonb_build_object('platform','github')))) LIMIT 1;
  IF NOT _dd THEN RAISE EXCEPTION '(6) second insert of same identity was not a merge'; END IF;
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'username' AND value = 'frank';
  IF _n <> 1 THEN RAISE EXCEPTION '(6) runtime dedup failed: expected 1 frank artifact, got %', _n; END IF;
  SELECT metadata INTO _meta FROM public.artifacts WHERE thread_id = _tid AND value = 'frank';
  IF jsonb_array_length(_meta->'provenance') <> 2 THEN
    RAISE EXCEPTION '(6) runtime merge did not accumulate provenance, got %', _meta->'provenance'; END IF;

  -- (6c) Same value, DISTINCT platform → the index must NOT merge it (runtime key
  --      == migration key): a distinct-platform observation is never collapsed.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','frank','source','username_sweep',
      'metadata', jsonb_build_object('platform','reddit'))));
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id = _tid AND kind = 'username' AND value = 'frank';
  IF _n <> 2 THEN RAISE EXCEPTION '(6) runtime key wrongly merged a distinct platform: expected 2, got %', _n; END IF;

  RAISE NOTICE 'selector-scope runtime (Part B) OK: RPC dedupes same identity + merges provenance, index preserves distinct platforms';
END $$;
ROLLBACK;
