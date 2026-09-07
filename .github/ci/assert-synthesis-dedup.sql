-- Behavioural assertion for `artifacts_synthesis_cluster_uniq`
-- (migration 20260907000000_synthesis_finding_cluster_unique.sql).
--
-- The migrations job already proves the DDL parses and applies. That is not the
-- same as proving the constraint REFUSES what it exists to refuse, and this repo
-- has a standing rule about the difference: a behavioural test must DRIVE the
-- shipped control flow, never re-describe it. So this drives the index with the
-- four writes that matter, against the schema the migrations just built.
--
-- Everything happens inside a transaction the caller rolls back; nothing is left
-- behind. Any failure RAISEs, which `--set ON_ERROR_STOP=1` turns into a non-zero
-- exit for the job.

begin;

do $$
declare
  -- Fresh ids every run, so the assertion is independent of whatever else is in
  -- the database and cannot fail for a reason that has nothing to do with it.
  t1 constant uuid := gen_random_uuid();
  t2 constant uuid := gen_random_uuid();
  u  constant uuid := gen_random_uuid();
  syn constant jsonb := '{"finding_origin":"synthesis","synthesis_cluster_id":"clus_ci"}';
begin
  -- ── anti-vacuous guard ──────────────────────────────────────────────────────
  -- Assert the index EXISTS before testing behaviour. Without this, a migration
  -- that silently stopped running would sail through every case below, because
  -- three of the four expect an insert to be accepted.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'artifacts_synthesis_cluster_uniq'
  ) then
    raise exception
      'artifacts_synthesis_cluster_uniq is absent — the migration did not run, so nothing below proves anything';
  end if;

  insert into public.threads (id, user_id, title, status) values
    (t1, u, 'ci-synthesis-dedup-1', 'finished'),
    (t2, u, 'ci-synthesis-dedup-2', 'finished');

  -- 1. The first synthesized finding for a cluster is accepted.
  insert into public.artifacts (thread_id, user_id, kind, value, metadata)
  values (t1, u, 'finding', 'v', syn);

  -- 2. A SECOND finding for the SAME (thread, cluster) must be refused. This is
  --    the whole point: two overlapping health probes both read an empty prior
  --    set and both write.
  begin
    insert into public.artifacts (thread_id, user_id, kind, value, metadata)
    values (t1, u, 'finding', 'v', syn);
    raise exception
      'REGRESSION: a second finding for the same (thread_id, synthesis_cluster_id) was ACCEPTED';
  exception when unique_violation then
    null;  -- expected
  end;

  -- 3. The key is scoped PER THREAD. The same cluster id in another thread is a
  --    different conclusion about a different case and must still be accepted.
  insert into public.artifacts (thread_id, user_id, kind, value, metadata)
  values (t2, u, 'finding', 'v', syn);

  -- 4. Model-authored findings carry no synthesis key and must not collide with
  --    each other. Synthesis fills silence; it does not constrain the model.
  insert into public.artifacts (thread_id, user_id, kind, value, metadata) values
    (t1, u, 'finding', 'v', '{"finding_origin":"model"}'),
    (t1, u, 'finding', 'v', '{"finding_origin":"model"}');

  raise notice 'OK: synthesis dedup index refuses a duplicate cluster, per thread, and leaves model findings alone.';
end $$;

rollback;
