-- Behavioural assertion for agent_memory's scope-aware uniqueness
-- (migration 20260911000000_agent_memory_scope_uniqueness.sql).
--
-- memory_save failed in production because a stale 3-column unique index on
-- (user_id, kind, subject) survived the move to scope-aware memory: saving a
-- subject in 'global' and then in 'case' was refused. Applying the migration
-- only proves the DDL parses; this DRIVES the save path, against the schema the
-- migrations just built, with the writes that matter.
--
-- Everything happens inside a transaction rolled back at the end. Any failure
-- RAISEs, which `--set ON_ERROR_STOP=1` turns into a non-zero exit for the job.

begin;

do $$
declare
  u constant uuid := gen_random_uuid();
  n int;
  hits int;
begin
  -- ── anti-vacuous guards ────────────────────────────────────────────────────
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'agent_memory_user_kind_subject_scope_uniq'
  ) then
    raise exception 'agent_memory_user_kind_subject_scope_uniq is absent — scope-aware memory did not build, nothing below proves anything';
  end if;

  -- No unique index on agent_memory may omit `scope` (other than the primary key):
  -- that is the exact shape of the stale index that failed memory_save.
  select count(*) into n
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace s on s.oid = t.relnamespace
  where s.nspname = 'public' and t.relname = 'agent_memory'
    and i.indisunique and not i.indisprimary
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = t.oid and a.attnum = any(i.indkey) and a.attname = 'scope'
    );
  if n > 0 then
    raise exception 'REGRESSION: % unique index(es) on agent_memory omit scope — a subject saved in both scopes will be refused', n;
  end if;

  -- Exactly ONE save_agent_memories. With a second overload beside the
  -- 4-argument one (whose `_scope` has a default), every 3-argument call is
  -- "not unique" and fails — the analyst "Mark false" lesson did.
  select count(*) into n
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname = 'save_agent_memories';
  if n <> 1 then
    raise exception 'REGRESSION: % save_agent_memories overloads — a 3-argument call is ambiguous', n;
  end if;

  perform set_config('request.jwt.claim.sub', u::text, true);

  -- 1. The same subject may live in BOTH scopes: global knowledge and this case.
  perform * from public.save_agent_memories(u, null,
    '[{"kind":"pattern","subject":"ci-memory.example","content":"email-only domain"}]'::jsonb, 'global');
  perform * from public.save_agent_memories(u, null,
    '[{"kind":"pattern","subject":"ci-memory.example","content":"email-only domain, this case"}]'::jsonb, 'case');
  select count(*) into n from public.agent_memory where user_id = u and subject = 'ci-memory.example';
  if n <> 2 then
    raise exception 'REGRESSION: expected one row per scope (2), found %', n;
  end if;

  -- 2. Re-saving within a scope still UPSERTS (no duplicate, hit_count bumps).
  perform * from public.save_agent_memories(u, null,
    '[{"kind":"pattern","subject":"ci-memory.example","content":"email-only domain"}]'::jsonb, 'case');
  select count(*) into n from public.agent_memory where user_id = u and subject = 'ci-memory.example';
  if n <> 2 then
    raise exception 'REGRESSION: a re-save within a scope created a duplicate (% rows)', n;
  end if;

  -- 3. A 3-argument call — named, exactly as PostgREST sends the analyst "Mark
  --    false" lesson from src/lib/review.ts — resolves, lands in 'global' and
  --    upserts the existing global row.
  select hit_count into hits from public.agent_memory
  where user_id = u and subject = 'ci-memory.example' and scope = 'global';
  perform * from public.save_agent_memories(
    _user_id => u, _thread_id => null,
    _entries => '[{"kind":"pattern","subject":"ci-memory.example","content":"email-only domain"}]'::jsonb);
  select count(*) into n from public.agent_memory where user_id = u and subject = 'ci-memory.example';
  if n <> 2 then
    raise exception 'REGRESSION: a 3-argument save created a row instead of upserting (% rows)', n;
  end if;
  if not exists (
    select 1 from public.agent_memory
    where user_id = u and subject = 'ci-memory.example' and scope = 'global' and hit_count = hits + 1
  ) then
    raise exception 'REGRESSION: a 3-argument save did not upsert the GLOBAL row (hit_count was %)', hits;
  end if;

  raise notice 'OK: agent_memory is unique per scope; a 3-argument save resolves and upserts.';
end $$;

rollback;
