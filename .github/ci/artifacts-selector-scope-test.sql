-- CI regression (selector-scope dedup, migration 20260711130000).
--
-- Every claim below is backed by a fixture in the part named next to it — nothing is
-- asserted in a header or a NOTICE that the SQL does not actually exercise.
--
--   Part A  migration consolidation: distinct PLATFORMS (21) and distinct SUBJECT_IDs
--           are never collapsed (the #305 data-loss the naive (thread,kind,value,
--           source) key caused); a true duplicate collapses to ONE survivor carrying
--           both provenances + the union of source classes + GREATEST confidence;
--           conflicting analyst verdicts survive as 'recheck' with full lineage;
--           consolidation is idempotent and leaves zero duplicate keys and zero
--           dangling refs GLOBALLY. Drops the unique index inside the txn so it can
--           seed pre-existing duplicates, then ROLLS BACK (restoring the index and
--           discarding every test row, so later CI steps see a pristine DB).
--   Part B  the runtime RPC key == the migration key (index in place).
--   Part C  the canonical merge_artifact_into: survivor subject/cluster preserved,
--           evidence re-pointed, evidence chain fields BYTE-IDENTICAL across a merge.
--   Part D  cross-thread and cross-user merges are rejected.
--   Part E  no client role (PUBLIC/anon/authenticated) can EXECUTE the merge surface;
--           service_role still can.
--   Part F  the identity contract: BREACH identity outranks platform/host (distinct
--           breaches on one provider host / one platform stay separate), distinct
--           source_url HOSTS stay separate, explicit SELECTORS stay separate — while
--           the same named breach from two tools, and platform aliases, still merge.
--   Part G1 same-state analyst reviews: agreeing verdicts keep their state but never
--           discard the loser's note or lineage.
--   Part G2 merge_lineage is APPEND-ONLY: a 3-way SEQUENTIAL consolidation keeps all
--           three original artifact_ids/states/notes (a 2-artifact test cannot catch
--           the second merge overwriting the first merge's lineage).
--   Part G3 NULL / whitespace-only notes keep their lineage entries; surviving note
--           text is neither lost nor invented.
--
-- Runs AFTER migrations, in the "Migrations (psql validation)" job. Every part is
-- wrapped in BEGIN/ROLLBACK. Not a migration; ships no fixtures.

SELECT set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', false);
INSERT INTO auth.users(id, email)
  VALUES ('cccccccc-0000-4000-8000-000000000003', 'ci-selscope@example.test')
  ON CONFLICT DO NOTHING;
-- a SECOND user, for the cross-user merge-rejection test in Part C.
INSERT INTO auth.users(id, email)
  VALUES ('cccccccc-0000-4000-8000-000000000009', 'ci-selscope2@example.test')
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

  -- (7b) …and it must not DUPLICATE lineage either. Re-running the consolidation over
  --      an already-merged survivor could re-append its own history to itself; a row
  --      count of zero would not notice. Lineage must still be exactly the 2 original
  --      reviews, the note history unchanged, and the state still recheck.
  SELECT state, note, merge_lineage INTO _rev_state, _rev_note, _rev_lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _aid_a;
  IF jsonb_array_length(_rev_lineage) <> 2 THEN
    RAISE EXCEPTION '(7b) idempotent re-run DUPLICATED merge_lineage: expected 2 entries, got %', _rev_lineage; END IF;
  IF _rev_state <> 'recheck' THEN RAISE EXCEPTION '(7b) idempotent re-run changed state to %', _rev_state; END IF;
  IF _rev_note NOT LIKE '%looks right%' OR _rev_note NOT LIKE '%wrong person%' THEN
    RAISE EXCEPTION '(7b) idempotent re-run damaged the note history: %', _rev_note; END IF;

  -- (8) GLOBAL end-state, not just the fixtures: zero duplicate selector-scope keys
  --     and zero dangling references anywhere in the table. Asserted while the unique
  --     index is still DROPPED, so it proves the CONSOLIDATION produced a clean state
  --     rather than the index merely hiding a dirty one. The key expression below must
  --     stay identical to artifacts_selector_scope_uidx's.
  SELECT count(*) INTO _n FROM (
    SELECT 1
      FROM public.artifacts
     GROUP BY thread_id, kind, value,
              COALESCE(NULLIF(btrim(subject_id), ''), '∅'),
              public.artifact_selector_scope(kind, value, source, metadata)
    HAVING count(*) > 1
  ) dupes;
  IF _n <> 0 THEN RAISE EXCEPTION '(8) % duplicate selector-scope key groups survived consolidation', _n; END IF;

  SELECT count(*) INTO _n FROM public.evidence_log e
   WHERE e.artifact_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.artifacts a WHERE a.id = e.artifact_id);
  IF _n <> 0 THEN RAISE EXCEPTION '(8) % evidence_log rows dangle at a deleted artifact', _n; END IF;

  SELECT count(*) INTO _n FROM public.artifact_reviews r
   WHERE NOT EXISTS (SELECT 1 FROM public.artifacts a WHERE a.id = r.artifact_id);
  IF _n <> 0 THEN RAISE EXCEPTION '(8) % artifact_reviews rows dangle at a deleted artifact', _n; END IF;

  -- NOTE: this NOTICE claims ONLY what Part A actually seeds. Distinct-host and
  -- distinct-breach preservation are asserted in Part F, against real fixtures —
  -- they used to be claimed here with no fixture behind them.
  RAISE NOTICE 'selector-scope consolidation (Part A) OK: 21 distinct platforms + distinct subject_ids preserved, dupes merged with provenance, conflicting verdicts → recheck, idempotent, zero dup keys + zero dangling refs globally';
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

-- ══════════════════════════════════════════════════════════════════════════════
-- Part C — the shared canonical merge_artifact_into + collision lookup (guardrail #6)
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _surv uuid; _loser uuid;
  _ev_before int; _ev_after int; _dangling int;
  _chain_ok boolean;
  _n int; _subj text; _clu text; _conf int; _meta jsonb;
  _rev_state text; _rev_lineage jsonb; _rev_note text;
  _found uuid;
  _hash_before jsonb; _hash_after jsonb;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- Survivor: subject 'S', platform github, cluster 'clS', base 60 — the caller's
  -- chosen destination row whose subject_id/cluster_id MUST be preserved.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, metadata, subject_id, cluster_id)
  VALUES (_tid, _uid, 'username', 'zoe', 'github_user', 60,
          '{"platform":"github","source_category":["direct_profile"]}'::jsonb, 'S', 'clS')
  RETURNING id INTO _surv;

  -- Loser: SAME kind/value/scope (platform github) but a DIFFERENT subject ('L'), so
  -- both coexist under the unique index AND reassigning the loser to subject 'S'
  -- would collide with the survivor — exactly the cluster-path case. Created via the
  -- RPC so it carries a real, verifiable evidence chain to be re-pointed.
  SELECT artifact_id INTO _loser FROM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','zoe','source','username_sweep','confidence',40,
      'metadata', jsonb_build_object('platform','github','source_category', jsonb_build_array('username_sweep')),
      'subject_id','L'))) LIMIT 1;

  -- Conflicting analyst verdicts across survivor + loser.
  INSERT INTO public.artifact_reviews(thread_id, artifact_id, user_id, state, note) VALUES
    (_tid, _surv,  _uid, 'confirmed', 'survivor verdict'),
    (_tid, _loser, _uid, 'dismissed', 'loser verdict');

  SELECT count(*) INTO _ev_before FROM public.evidence_log WHERE artifact_id = _loser;
  IF _ev_before < 1 THEN RAISE EXCEPTION 'setup: loser carries no evidence to re-point'; END IF;
  SELECT ok INTO _chain_ok FROM public.verify_evidence_chain(_tid);
  IF NOT _chain_ok THEN RAISE EXCEPTION 'setup: evidence chain invalid before merge'; END IF;

  -- (#8) Snapshot every chain field BEFORE the merge. "the chain still verifies" is
  -- a weaker claim than "the hashes never moved" — a merge that recomputed hashes
  -- could still self-verify while destroying byte-for-byte custody. Compare exactly.
  SELECT jsonb_agg(jsonb_build_object('id', id, 'content', content_hash, 'prev', prev_hash, 'chain', chain_hash) ORDER BY seq)
    INTO _hash_before FROM public.evidence_log WHERE thread_id = _tid;

  -- find_artifact_selector_collision: the loser reassigned to subject 'S' collides
  -- with the survivor (same kind/value/scope, subject 'S'); a phantom subject does not.
  SELECT public.find_artifact_selector_collision(_loser, 'S') INTO _found;
  IF _found IS DISTINCT FROM _surv THEN RAISE EXCEPTION 'collision lookup found % expected survivor %', _found, _surv; END IF;
  SELECT public.find_artifact_selector_collision(_loser, 'no-such-subject') INTO _found;
  IF _found IS NOT NULL THEN RAISE EXCEPTION 'collision lookup should be NULL for a non-colliding subject, got %', _found; END IF;

  -- ── the canonical merge ──
  PERFORM public.merge_artifact_into(_loser, _surv);

  IF EXISTS (SELECT 1 FROM public.artifacts WHERE id = _loser) THEN RAISE EXCEPTION 'loser not deleted'; END IF;
  SELECT subject_id, cluster_id, confidence, metadata INTO _subj, _clu, _conf, _meta
    FROM public.artifacts WHERE id = _surv;
  IF _subj <> 'S' OR _clu <> 'clS' THEN RAISE EXCEPTION 'survivor subject/cluster NOT preserved: subj=% clu=%', _subj, _clu; END IF;
  IF _conf <> 60 THEN RAISE EXCEPTION 'survivor confidence expected GREATEST=60, got %', _conf; END IF;
  IF jsonb_array_length(_meta->'provenance') <> 2 THEN RAISE EXCEPTION 'survivor provenance expected 2, got %', _meta->'provenance'; END IF;
  IF jsonb_array_length(_meta->'merged_from') <> 1 THEN RAISE EXCEPTION 'survivor merged_from expected 1, got %', _meta->'merged_from'; END IF;
  IF NOT (_meta->'source_category' @> '["direct_profile","username_sweep"]'::jsonb) THEN
    RAISE EXCEPTION 'survivor source_category not unioned: %', _meta->'source_category'; END IF;
  IF _meta->>'platform' <> 'github' THEN RAISE EXCEPTION 'merge changed survivor identity (platform): %', _meta->>'platform'; END IF;

  -- Evidence re-pointed to survivor, nothing dangling, chain still valid.
  SELECT count(*) INTO _ev_after FROM public.evidence_log WHERE artifact_id = _surv;
  IF _ev_after < _ev_before THEN RAISE EXCEPTION 'evidence not re-pointed: before=% after=%', _ev_before, _ev_after; END IF;
  SELECT count(*) INTO _dangling FROM public.evidence_log WHERE artifact_id = _loser;
  IF _dangling <> 0 THEN RAISE EXCEPTION 'evidence still points at deleted loser (% rows)', _dangling; END IF;
  SELECT ok INTO _chain_ok FROM public.verify_evidence_chain(_tid);
  IF NOT _chain_ok THEN RAISE EXCEPTION 'evidence chain broke after merge (artifact_id is not hashed — should be untouched)'; END IF;

  -- (#8) …and the chain fields are BYTE-IDENTICAL, not merely self-consistent.
  SELECT jsonb_agg(jsonb_build_object('id', id, 'content', content_hash, 'prev', prev_hash, 'chain', chain_hash) ORDER BY seq)
    INTO _hash_after FROM public.evidence_log WHERE thread_id = _tid;
  IF _hash_after IS DISTINCT FROM _hash_before THEN
    RAISE EXCEPTION '(#8) merge mutated evidence chain fields — content/prev/chain hashes must be byte-identical.  before=%  after=%',
      _hash_before, _hash_after;
  END IF;

  -- Conflicting reviews → survivor 'recheck' with full lineage + note history; loser review gone.
  SELECT count(*) INTO _n FROM public.artifact_reviews WHERE artifact_id = _loser;
  IF _n <> 0 THEN RAISE EXCEPTION 'loser review not removed (% rows)', _n; END IF;
  SELECT state, merge_lineage, note INTO _rev_state, _rev_lineage, _rev_note
    FROM public.artifact_reviews WHERE artifact_id = _surv AND user_id = _uid;
  IF _rev_state <> 'recheck' THEN RAISE EXCEPTION 'conflicting verdicts did not force recheck, got %', _rev_state; END IF;
  IF jsonb_array_length(_rev_lineage) <> 2 THEN RAISE EXCEPTION 'merge_lineage expected 2, got %', _rev_lineage; END IF;
  IF NOT (_rev_lineage @> '[{"state":"confirmed"}]'::jsonb AND _rev_lineage @> '[{"state":"dismissed"}]'::jsonb) THEN
    RAISE EXCEPTION 'merge_lineage lost a verdict: %', _rev_lineage; END IF;
  IF _rev_note NOT LIKE '%survivor verdict%' OR _rev_note NOT LIKE '%loser verdict%' THEN
    RAISE EXCEPTION 'note history not preserved: %', _rev_note; END IF;

  RAISE NOTICE 'merge_artifact_into (Part C) OK: subject/cluster preserved, provenance/classes unioned, evidence re-pointed, chain intact, conflicting reviews → recheck';
END $$;
ROLLBACK;

-- cross-thread AND cross-user merges must be REJECTED (separate txn, rolled back)
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _uid2 uuid := 'cccccccc-0000-4000-8000-000000000009';
  _tid_a uuid; _tid_b uuid;
  _a uuid; _b uuid; _u2 uuid;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid_a;
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid_b;

  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence)
    VALUES (_tid_a, _uid, 'username', 'x', 's', 50) RETURNING id INTO _a;
  -- different THREAD, same user.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence)
    VALUES (_tid_b, _uid, 'username', 'x', 's', 50) RETURNING id INTO _b;
  -- SAME thread as _a but a different user_id column → isolates the cross-user guard
  -- (different users otherwise live in different threads and trip the thread guard).
  --
  -- The value MUST differ from _a's. artifacts_selector_scope_uidx keys on
  -- (thread_id, kind, value, subject, scope) and deliberately does NOT include
  -- user_id, so a row identical to _a but for its owner is a duplicate BY THE INDEX
  -- and is rejected at INSERT — before merge_artifact_into's user guard is ever
  -- reached. A distinct value keeps the row insertable while still exercising the
  -- guard (same thread, different owner).
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence)
    VALUES (_tid_a, _uid2, 'username', 'x_other_owner', 's', 50) RETURNING id INTO _u2;

  -- cross-thread (same user, different thread) → reject.
  BEGIN
    PERFORM public.merge_artifact_into(_b, _a);
    RAISE EXCEPTION 'cross-thread merge was NOT rejected';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%cross-thread merge was NOT rejected%' THEN RAISE; END IF;
  END;

  -- cross-user (same thread, different user_id) → reject via the user guard.
  BEGIN
    PERFORM public.merge_artifact_into(_u2, _a);
    RAISE EXCEPTION 'cross-user merge was NOT rejected';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%cross-user merge was NOT rejected%' THEN RAISE; END IF;
  END;

  -- both survivors + would-be losers still present (no partial merge happened).
  IF NOT EXISTS (SELECT 1 FROM public.artifacts WHERE id = _a)
     OR NOT EXISTS (SELECT 1 FROM public.artifacts WHERE id = _b)
     OR NOT EXISTS (SELECT 1 FROM public.artifacts WHERE id = _u2) THEN
    RAISE EXCEPTION 'a rejected merge still mutated rows';
  END IF;

  RAISE NOTICE 'merge_artifact_into rejection OK: cross-thread and cross-user merges refused, no partial mutation';
END $$;
ROLLBACK;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part E — the privileged merge surface is NOT reachable by any client role.
-- Pure catalog inspection (no fixtures, no writes, nothing to roll back).
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  _targets text[] := ARRAY['merge_artifact_into','find_artifact_selector_collision','artifact_consolidate_dupes'];
  _fn record;
  _seen int := 0;
BEGIN
  FOR _fn IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           -- A function whose ACL was never touched is NOT unprivileged: Postgres
           -- DEFAULTS it to EXECUTE for PUBLIC. COALESCE onto acldefault() so a
           -- forgotten REVOKE fails this test instead of silently passing it.
           COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(_targets)
  LOOP
    _seen := _seen + 1;

    -- PUBLIC is grantee OID 0 in the ACL, and is not addressable via has_function_privilege.
    IF EXISTS (SELECT 1 FROM aclexplode(_fn.acl) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'privilege leak: PUBLIC can EXECUTE %(%)', _fn.proname, _fn.args;
    END IF;

    IF has_function_privilege('anon', _fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'privilege leak: anon can EXECUTE %(%)', _fn.proname, _fn.args;
    END IF;
    IF has_function_privilege('authenticated', _fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'privilege leak: authenticated can EXECUTE %(%)', _fn.proname, _fn.args;
    END IF;

    -- Positive control: the REVOKEs must not have locked out the runtime caller too.
    -- The edge function invokes these with the service-role client; if this ever fails,
    -- every collision-merge would throw permission-denied in production.
    IF NOT has_function_privilege('service_role', _fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role LOST EXECUTE on %(%) — the runtime merge path is broken', _fn.proname, _fn.args;
    END IF;
  END LOOP;

  -- Guard against the test silently passing because a function was renamed away.
  IF _seen <> array_length(_targets, 1) THEN
    RAISE EXCEPTION 'privilege test matched % of % target functions — name drift?', _seen, array_length(_targets, 1);
  END IF;

  RAISE NOTICE 'privileges (Part E) OK: PUBLIC/anon/authenticated cannot EXECUTE the merge surface; service_role still can';
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part F — the IDENTITY CONTRACT of artifact_selector_scope (index IN PLACE).
--
-- Regression for a live data-loss bug: breach identity used to sit BEHIND platform
-- and source_url host in the first-match ladder, so it was never even read whenever
-- either was present. HIBP reports many DIFFERENT breaches for one email under the
-- SAME host — every one of them shared a scope and collapsed into a single row.
-- These fixtures run with artifacts_selector_scope_uidx ENFORCING, so a regression
-- surfaces either as a 23505 on insert or as a wrong row count.
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _n int;
  _dd boolean;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- (F1) same kind/value/subject + SAME provider host + DIFFERENT breach_name → 2.
  --      This is the exact HIBP shape that the old ladder collapsed.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata) VALUES
    (_tid, _uid, 'breach', 'bob@example.com', 'hibp', 50, 's1',
     '{"source_url":"https://haveibeenpwned.com/breach/Adobe","breach_name":"Adobe"}'::jsonb),
    (_tid, _uid, 'breach', 'bob@example.com', 'hibp', 50, 's1',
     '{"source_url":"https://haveibeenpwned.com/breach/LinkedIn","breach_name":"LinkedIn"}'::jsonb);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='bob@example.com';
  IF _n <> 2 THEN RAISE EXCEPTION '(F1) distinct breach_name on the SAME host collapsed to % row(s)', _n; END IF;

  -- (F2) same kind/value/subject + SAME platform + DIFFERENT breach_id → 2.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata) VALUES
    (_tid, _uid, 'credential', 'carol@example.com', 'dehashed', 50, 's1',
     '{"platform":"linkedin","breach_id":"BR-1"}'::jsonb),
    (_tid, _uid, 'credential', 'carol@example.com', 'dehashed', 50, 's1',
     '{"platform":"linkedin","breach_id":"BR-2"}'::jsonb);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='carol@example.com';
  IF _n <> 2 THEN RAISE EXCEPTION '(F2) distinct breach_id on the SAME platform collapsed to % row(s)', _n; END IF;

  -- (F3) non-breach kind, no platform, DIFFERENT source_url hosts → 2 (host is the
  --      discriminator only when no platform is declared).
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata) VALUES
    (_tid, _uid, 'profile', 'dave', 'tool_a', 50, 's1', '{"source_url":"https://alpha.example/dave"}'::jsonb),
    (_tid, _uid, 'profile', 'dave', 'tool_b', 50, 's1', '{"source_url":"https://beta.example/dave"}'::jsonb);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='dave';
  IF _n <> 2 THEN RAISE EXCEPTION '(F3) distinct source_url hosts collapsed to % row(s)', _n; END IF;

  -- (F4) explicit selector is an ADDITIONAL discriminator: same platform, selector
  --      A vs B → 2. (Under the old ladder the selector branch was unreachable
  --      whenever a platform existed, so these silently merged.)
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata) VALUES
    (_tid, _uid, 'username', 'erin', 'sweep', 50, 's1', '{"platform":"github","selector":"a"}'::jsonb),
    (_tid, _uid, 'username', 'erin', 'sweep', 50, 's1', '{"platform":"github","selector":"b"}'::jsonb);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='erin';
  IF _n <> 2 THEN RAISE EXCEPTION '(F4) distinct explicit selectors collapsed to % row(s)', _n; END IF;

  -- (F5) INTENDED merge still happens: the SAME named breach reported by two
  --      different tools, from two different hosts, is ONE finding. Platform/host are
  --      provenance for a breach, not identity. Via the runtime RPC → deduped.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','breach','value','frank@example.com','source','hibp','subject_id','s1',
      'metadata', jsonb_build_object('breach_name','Adobe','source_url','https://haveibeenpwned.com/x'))));
  SELECT deduped INTO _dd FROM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','breach','value','frank@example.com','source','dehashed','subject_id','s1',
      'metadata', jsonb_build_object('breach_name','adobe','source_url','https://dehashed.com/y')))) LIMIT 1;
  IF NOT _dd THEN RAISE EXCEPTION '(F5) same named breach from two tools did NOT merge'; END IF;
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='frank@example.com';
  IF _n <> 1 THEN RAISE EXCEPTION '(F5) same named breach from two tools left % rows', _n; END IF;

  -- (F6) platform alias folding still merges (twitter.com ≡ x), unchanged by the reorder.
  PERFORM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','grace','source','sweep',
      'metadata', jsonb_build_object('platform','twitter.com'))));
  SELECT deduped INTO _dd FROM public.record_artifacts_with_evidence(_tid, jsonb_build_array(
    jsonb_build_object('kind','username','value','grace','source','sweep',
      'metadata', jsonb_build_object('platform','x')))) LIMIT 1;
  IF NOT _dd THEN RAISE EXCEPTION '(F6) twitter.com/x alias folding regressed — did not merge'; END IF;
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='grace';
  IF _n <> 1 THEN RAISE EXCEPTION '(F6) alias folding left % rows', _n; END IF;

  -- (F7) unnamed breach records never merge (md5-per-observation fallback).
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata) VALUES
    (_tid, _uid, 'stealer_log', 'heidi@example.com', 'tool_a', 50, 's1', '{"source_url":"https://dump.example/1"}'::jsonb),
    (_tid, _uid, 'stealer_log', 'heidi@example.com', 'tool_b', 50, 's1', '{"source_url":"https://dump.example/2"}'::jsonb);
  SELECT count(*) INTO _n FROM public.artifacts WHERE thread_id=_tid AND value='heidi@example.com';
  IF _n <> 2 THEN RAISE EXCEPTION '(F7) unnamed breach observations on one host collapsed to % row(s)', _n; END IF;

  RAISE NOTICE 'identity contract (Part F) OK: breach identity outranks platform/host (distinct breach_name on one host, distinct breach_id on one platform, unnamed breaches all stay separate); distinct source_url hosts stay separate; explicit selectors stay separate; the SAME named breach from two tools still merges; platform alias folding still merges';
END $$;
ROLLBACK;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part G — SAME-STATE analyst reviews: the state is uncontested, but the note is
-- still analyst-authored text and must never be silently discarded. The merge used
-- to DELETE the loser's review outright in this branch, losing its note entirely and
-- recording no lineage.
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _surv uuid; _loser uuid;
  _n int; _state text; _note text; _lineage jsonb;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- Same kind/value/scope, different subject_id → both coexist under the index.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'ivan', 'github_user', 60, 'S', '{"platform":"github"}'::jsonb)
  RETURNING id INTO _surv;
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'ivan', 'sweep', 40, 'L', '{"platform":"github"}'::jsonb)
  RETURNING id INTO _loser;

  -- SAME state, DIFFERENT notes — the case that used to lose text.
  INSERT INTO public.artifact_reviews(thread_id, artifact_id, user_id, state, note) VALUES
    (_tid, _surv,  _uid, 'confirmed', 'matches the payroll record'),
    (_tid, _loser, _uid, 'confirmed', 'independently confirmed via the school yearbook');

  PERFORM public.merge_artifact_into(_loser, _surv);

  SELECT count(*) INTO _n FROM public.artifact_reviews
   WHERE user_id = _uid AND artifact_id IN (_surv, _loser);
  IF _n <> 1 THEN RAISE EXCEPTION '(G) expected exactly 1 surviving review, got %', _n; END IF;
  SELECT count(*) INTO _n FROM public.artifact_reviews WHERE artifact_id = _loser;
  IF _n <> 0 THEN RAISE EXCEPTION '(G) the redundant loser review was not removed'; END IF;

  SELECT state, note, merge_lineage INTO _state, _note, _lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _surv;

  -- state is uncontested → it must NOT be escalated to recheck.
  IF _state <> 'confirmed' THEN RAISE EXCEPTION '(G) agreeing verdicts changed state to %', _state; END IF;
  -- BOTH notes recoverable.
  IF _note NOT LIKE '%payroll record%' THEN RAISE EXCEPTION '(G) survivor note lost: %', _note; END IF;
  IF _note NOT LIKE '%school yearbook%' THEN RAISE EXCEPTION '(G) LOSER note discarded — analyst text destroyed: %', _note; END IF;
  -- full lineage of both original reviews.
  IF _lineage IS NULL OR jsonb_array_length(_lineage) <> 2 THEN
    RAISE EXCEPTION '(G) merge_lineage expected both original reviews, got %', _lineage; END IF;
  IF NOT (_lineage @> '[{"note":"matches the payroll record"}]'::jsonb
      AND _lineage @> '[{"note":"independently confirmed via the school yearbook"}]'::jsonb) THEN
    RAISE EXCEPTION '(G) merge_lineage lost an original review: %', _lineage; END IF;

  RAISE NOTICE 'same-state reviews (Part G1) OK: state left unchanged, BOTH notes preserved, full merge_lineage recorded, redundant row removed';
END $$;
ROLLBACK;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part G2 — merge_lineage is APPEND-ONLY across a MULTI-STAGE consolidation.
-- Three duplicates merged sequentially (A+B, then survivor+C). Deriving lineage from
-- only the two live review rows would rebuild it as [survivor, C] on the second merge
-- and silently destroy the original A and B entries. Two-artifact tests cannot see
-- this; it needs three.
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _a uuid; _b uuid; _c uuid;
  _n int; _state text; _note text; _lineage jsonb;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'judy', 'github_user', 60, 'A', '{"platform":"github"}'::jsonb) RETURNING id INTO _a;
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'judy', 'sweep', 50, 'B', '{"platform":"github"}'::jsonb) RETURNING id INTO _b;
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'judy', 'other', 40, 'C', '{"platform":"github"}'::jsonb) RETURNING id INTO _c;

  -- created_at is set EXPLICITLY. The column defaults to now(), which is the
  -- TRANSACTION timestamp — inserting all three in one txn gives them an identical
  -- created_at, so ORDER BY (created_at, id, ord) would fall back to the random uuid
  -- id and lineage order would not follow insertion order. Distinct timestamps make
  -- the ordering both deterministic AND meaningful, so it can actually be asserted.
  INSERT INTO public.artifact_reviews(thread_id, artifact_id, user_id, state, note, created_at) VALUES
    (_tid, _a, _uid, 'confirmed', 'note-A', '2020-01-01T00:00:00Z'),
    (_tid, _b, _uid, 'confirmed', 'note-B', '2020-01-02T00:00:00Z'),
    (_tid, _c, _uid, 'confirmed', 'note-C', '2020-01-03T00:00:00Z');

  PERFORM public.merge_artifact_into(_b, _a);   -- stage 1: lineage = [A, B]
  PERFORM public.merge_artifact_into(_c, _a);   -- stage 2: MUST become [A, B, C]

  SELECT count(*) INTO _n FROM public.artifact_reviews WHERE user_id = _uid;
  IF _n <> 1 THEN RAISE EXCEPTION '(G2) expected 1 surviving review, got %', _n; END IF;

  SELECT state, note, merge_lineage INTO _state, _note, _lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _a;

  IF _state <> 'confirmed' THEN RAISE EXCEPTION '(G2) agreeing verdicts changed state to %', _state; END IF;

  -- all THREE original lineage entries survive — not just the last merge's two.
  IF _lineage IS NULL OR jsonb_array_length(_lineage) <> 3 THEN
    RAISE EXCEPTION '(G2) merge_lineage lost history across the 2nd merge: expected 3 entries, got %', _lineage; END IF;

  -- FLAT, not nested: the 2nd merge must splice the prior lineage's entries in, not
  -- embed the survivor's array (or the survivor row) as a single element.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(_lineage) e WHERE jsonb_typeof(e) <> 'object') THEN
    RAISE EXCEPTION '(G2) merge_lineage is nested — entries must be flat objects: %', _lineage; END IF;

  -- every original artifact_id, STATE and note is recoverable.
  IF NOT (_lineage @> jsonb_build_array(jsonb_build_object('artifact_id', _a, 'state', 'confirmed', 'note', 'note-A'))
      AND _lineage @> jsonb_build_array(jsonb_build_object('artifact_id', _b, 'state', 'confirmed', 'note', 'note-B'))
      AND _lineage @> jsonb_build_array(jsonb_build_object('artifact_id', _c, 'state', 'confirmed', 'note', 'note-C'))) THEN
    RAISE EXCEPTION '(G2) merge_lineage dropped an original artifact_id/state/note triple: %', _lineage; END IF;

  -- DETERMINISTIC ORDER: oldest review first, and a merged-in history keeps its
  -- internal order. With distinct created_at the result must be exactly [A, B, C].
  IF _lineage->0->>'artifact_id' IS DISTINCT FROM _a::text
     OR _lineage->1->>'artifact_id' IS DISTINCT FROM _b::text
     OR _lineage->2->>'artifact_id' IS DISTINCT FROM _c::text THEN
    RAISE EXCEPTION '(G2) merge_lineage order is not deterministic [A,B,C], got %', _lineage; END IF;

  -- and every original note is still recoverable from the note text too.
  IF _note NOT LIKE '%note-A%' OR _note NOT LIKE '%note-B%' OR _note NOT LIKE '%note-C%' THEN
    RAISE EXCEPTION '(G2) a note was discarded across the multi-stage merge: %', _note; END IF;

  RAISE NOTICE 'multi-stage lineage (Part G2) OK: 3-way sequential consolidation keeps all 3 original artifact_id/state/note triples, flat (not nested), in deterministic [A,B,C] order — merge_lineage is append-only';
END $$;
ROLLBACK;

-- ══════════════════════════════════════════════════════════════════════════════
-- Part G3 — NULL / empty notes must not cost us the lineage entry.
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  _uid uuid := 'cccccccc-0000-4000-8000-000000000003';
  _tid uuid;
  _s1 uuid; _l1 uuid; _s2 uuid; _l2 uuid;
  _note text; _lineage jsonb; _state text;
BEGIN
  INSERT INTO public.threads(user_id) VALUES (_uid) RETURNING id INTO _tid;

  -- (G3a) survivor note NULL, loser note present → the loser's text must survive AND
  --       the NULL-note row must still appear in the lineage.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'karl', 'github_user', 60, 'S', '{"platform":"github"}'::jsonb) RETURNING id INTO _s1;
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'karl', 'sweep', 40, 'L', '{"platform":"github"}'::jsonb) RETURNING id INTO _l1;
  INSERT INTO public.artifact_reviews(thread_id, artifact_id, user_id, state, note) VALUES
    (_tid, _s1, _uid, 'confirmed', NULL),
    (_tid, _l1, _uid, 'confirmed', 'the only note');

  PERFORM public.merge_artifact_into(_l1, _s1);

  SELECT state, note, merge_lineage INTO _state, _note, _lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _s1;
  IF _state <> 'confirmed' THEN RAISE EXCEPTION '(G3a) state changed to %', _state; END IF;
  IF _note IS DISTINCT FROM 'the only note' THEN
    RAISE EXCEPTION '(G3a) expected the single real note, got %', _note; END IF;
  IF _lineage IS NULL OR jsonb_array_length(_lineage) <> 2 THEN
    RAISE EXCEPTION '(G3a) a NULL-note review was dropped from the lineage: %', _lineage; END IF;

  -- (G3b) BOTH notes NULL → no note, but the lineage still records both reviews.
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'lena', 'github_user', 60, 'S', '{"platform":"github"}'::jsonb) RETURNING id INTO _s2;
  INSERT INTO public.artifacts(thread_id, user_id, kind, value, source, confidence, subject_id, metadata)
  VALUES (_tid, _uid, 'username', 'lena', 'sweep', 40, 'L', '{"platform":"github"}'::jsonb) RETURNING id INTO _l2;
  INSERT INTO public.artifact_reviews(thread_id, artifact_id, user_id, state, note) VALUES
    (_tid, _s2, _uid, 'dismissed', NULL),
    (_tid, _l2, _uid, 'dismissed', '   ');   -- whitespace-only == empty

  PERFORM public.merge_artifact_into(_l2, _s2);

  SELECT note, merge_lineage INTO _note, _lineage
    FROM public.artifact_reviews WHERE user_id = _uid AND artifact_id = _s2;
  IF _note IS NOT NULL AND btrim(_note) <> '' THEN
    RAISE EXCEPTION '(G3b) invented note text out of two empty notes: %', _note; END IF;
  IF _lineage IS NULL OR jsonb_array_length(_lineage) <> 2 THEN
    RAISE EXCEPTION '(G3b) empty-note reviews were dropped from the lineage: %', _lineage; END IF;

  RAISE NOTICE 'null/empty notes (Part G3) OK: NULL- and whitespace-note reviews keep their lineage entries; the surviving note text is neither lost nor invented';
END $$;
ROLLBACK;
