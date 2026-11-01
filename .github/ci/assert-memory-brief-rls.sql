-- Behavioural assertion: the tool-lesson brief's read of agent_memory (M1,
-- supabase/functions/osint-agent/lib/memory-brief.ts `toolLessonQuery`) can only
-- ever see the requesting user's own rows, because RLS enforces it for the
-- `authenticated` role the edge function queries as.
--
-- Why this is driven and not grepped: the CI job runs psql as the `postgres`
-- superuser, which BYPASSES row-level security. Setting `request.jwt.claim.sub`
-- alone therefore proves nothing — the policy is never consulted. This script
-- switches to the real `authenticated` role (created NOLOGIN by
-- .github/ci/supabase-platform-shim.sql exactly as the platform does), checks
-- that the switch took and that the role cannot bypass RLS, and then exercises
-- cross-user READ and WRITE. It also checks that `service_role` (BYPASSRLS, as in
-- production) still sees everything, so the test fails loudly if the shim's role
-- set ever drifts from the platform's.
--
-- Everything happens inside a transaction rolled back at the end. Any failure
-- RAISEs, which `--set ON_ERROR_STOP=1` turns into a non-zero exit for the job.

begin;

do $$
declare
  a constant uuid := gen_random_uuid();
  b constant uuid := gen_random_uuid();
  n int;
  bypass boolean;
begin
  -- ── anti-vacuous guards ────────────────────────────────────────────────────
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'role authenticated is absent — the platform shim did not run, nothing below proves anything';
  end if;
  select rolbypassrls into bypass from pg_roles where rolname = 'authenticated';
  if bypass then
    raise exception 'role authenticated has BYPASSRLS — the assertion below would be vacuous';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relname = 'agent_memory' and c.relrowsecurity
  ) then
    raise exception 'REGRESSION: row-level security is OFF on public.agent_memory';
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_memory' and cmd = 'SELECT'
  ) then
    raise exception 'REGRESSION: public.agent_memory has no SELECT policy';
  end if;

  -- ── seed as superuser: two users, the shapes the brief queries for ────────
  insert into public.agent_memory (user_id, kind, scope, subject, content)
  values
    (a, 'lesson', 'global', 'tool:ci_probe_tool', 'A: global lesson'),
    (a, 'lesson', 'case',   'tool:ci_probe_tool', 'A: case lesson'),
    (b, 'lesson', 'global', 'tool:ci_probe_tool', 'B: global lesson');

  -- ── act as user A through the authenticated role ───────────────────────────
  perform set_config('request.jwt.claim.sub', a::text, true);
  execute 'set local role authenticated';
  if current_user <> 'authenticated' then
    raise exception 'role switch did not take (current_user = %)', current_user;
  end if;

  -- read: the brief's predicate shape (prefix match is the widest the query ever gets)
  select count(*) into n from public.agent_memory where subject like 'tool:%';
  if n <> 2 then
    raise exception 'REGRESSION: user A sees % tool: rows, expected exactly its own 2', n;
  end if;
  select count(*) into n from public.agent_memory where subject like 'tool:%' and user_id = b;
  if n <> 0 then
    raise exception 'REGRESSION: user A can read % of user B''s tool: rows', n;
  end if;
  -- the narrow query the brief actually runs
  select count(*) into n from public.agent_memory
   where user_id = a and scope = 'global' and kind = 'lesson' and subject in ('tool:ci_probe_tool');
  if n <> 1 then
    raise exception 'REGRESSION: the brief predicate returned % rows for user A, expected 1', n;
  end if;

  -- write: cross-user UPDATE and DELETE must touch nothing (policies use WITH CHECK / USING on user_id)
  update public.agent_memory set content = 'tampered' where user_id = b and subject = 'tool:ci_probe_tool';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'REGRESSION: user A updated % of user B''s rows', n;
  end if;
  delete from public.agent_memory where user_id = b and subject = 'tool:ci_probe_tool';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'REGRESSION: user A deleted % of user B''s rows', n;
  end if;
  -- and cannot plant a row under B's id
  begin
    insert into public.agent_memory (user_id, kind, scope, subject, content)
    values (b, 'lesson', 'global', 'tool:ci_probe_tool', 'A planted this as B');
    raise exception 'REGRESSION: user A inserted a row owned by user B';
  exception
    when insufficient_privilege then null; -- RLS WITH CHECK refused it: correct
  end;

  execute 'reset role';

  -- ── service_role (the admin client) bypasses RLS, as in production ─────────
  execute 'set local role service_role';
  select count(*) into n from public.agent_memory where subject = 'tool:ci_probe_tool';
  if n <> 3 then
    raise exception 'service_role sees % probe rows, expected 3 — the shim''s role set has drifted from the platform', n;
  end if;
  execute 'reset role';

  raise notice 'OK: the authenticated role reads and writes only its own agent_memory rows; service_role sees all.';
end $$;

rollback;
