-- Close a SECURITY DEFINER function left with default PUBLIC EXECUTE.
--
-- FOUND BY the new CI assertion (see .github/workflows/ci.yml, "SECURITY DEFINER
-- grant assertion"), on its first run — which is the point of adding it.
--
-- THE DEFECT. `save_agent_memories` has been redefined many times, and
-- 20260529145859 introduced a NEW SIGNATURE by adding `_scope text`:
--
--     save_agent_memories(_user_id uuid, _thread_id uuid, _entries jsonb, _scope text)
--
-- In PostgreSQL a different argument list is a DIFFERENT function with a fresh
-- ACL — the GRANT/REVOKE statements that accompanied the 3-argument version do
-- not carry over, and none were written for the 4-argument one. So it was created
-- with a NULL ACL, which is not "no access": a null proacl means the built-in
-- default applies, and for functions that default is EXECUTE TO PUBLIC.
--
-- Verified by applying every migration in order to a clean PostgreSQL 16 (the
-- same sequence CI runs). Result, before this migration:
--
--     save_agent_memories(uuid, uuid, jsonb, text)  ->  NULL ACL  (= PUBLIC EXECUTE)
--
-- and with this project's real default privileges also mirrored in (see the shim),
-- it materializes as `=X/postgres, anon=X/postgres, ...` — PUBLIC *and* anon.
--
-- SCOPE OF THE RISK — stated honestly. The LIVE database is NOT affected: its copy
-- of this overload carries an explicit `postgres/authenticated/service_role` ACL,
-- so no anonymous caller can reach it today (queried directly against
-- skzqwbyvmwqarfgfvyky). The exposure is latent and structural: any environment
-- rebuilt FROM THESE MIGRATIONS — a fresh Supabase project, a restore, a staging
-- clone, a preview branch — gets the PUBLIC-executable version. The function also
-- validates auth.uid() internally, so this is hygiene rather than an open door,
-- exactly as with record_analyst_feedback. It is still wrong for a SECURITY
-- DEFINER function to be world-executable, and a runtime check is the wrong and
-- only line of defence.
--
-- This migration is a NO-OP against production (the revokes remove grants that are
-- already absent; the grants restate ones already present) and a real fix for every
-- environment built from source.
--
-- ROLLBACK (not recommended — restores PUBLIC EXECUTE):
--   GRANT EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb, text) TO PUBLIC;

REVOKE EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_agent_memories(uuid, uuid, jsonb, text)
  TO authenticated, service_role;
