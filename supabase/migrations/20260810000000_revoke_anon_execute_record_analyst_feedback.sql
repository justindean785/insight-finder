-- Least privilege: no anonymous EXECUTE on a SECURITY DEFINER function.
--
-- FINDING. The Lovable security scan reported "Public users can execute a
-- SECURITY DEFINER function". Verified live against skzqwbyvmwqarfgfvyky:
-- public.record_analyst_feedback is SECURITY DEFINER and carried EXECUTE for the
-- `anon` role alongside authenticated/postgres/service_role. It is the only
-- SECURITY DEFINER function in `public` with an anon grant.
--
-- SEVERITY — deliberately stated honestly rather than inflated. The function is
-- NOT exploitable as granted: its first statement is
--
--     IF _uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
--
-- and it then requires `EXISTS (SELECT 1 FROM public.threads t WHERE t.id =
-- _thread_id AND t.user_id = _uid)`, with any supplied artifact required to
-- belong to that same thread. An anonymous caller has a NULL auth.uid() and is
-- rejected before touching a row. So this is hygiene — removing a grant that
-- should never have existed — not the closing of an open door. It is worth doing
-- because the internal guard is the ONLY thing standing between an unauthenticated
-- caller and a SECURITY DEFINER body, and a grant that relies entirely on a
-- runtime check is one refactor away from being a real hole.
--
-- SCOPE. EXECUTE for `authenticated` is deliberately RETAINED: the client calls
-- this RPC directly when an analyst confirms/rejects/retracts a finding, and the
-- function validates tenant + thread ownership internally, which is exactly the
-- contract a SECURITY DEFINER function granted to end users must meet.
--
-- Every SECURITY DEFINER function in `public` was checked for the sibling defect
-- at the same time: all 11 already pin `search_path` (9 to `public`, 2 to
-- `public, extensions`), so no search_path change is bundled here.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.record_analyst_feedback(
--     uuid, uuid, text, text, text, text, integer, integer, text, jsonb
--   ) TO anon;

REVOKE EXECUTE ON FUNCTION public.record_analyst_feedback(
  uuid, uuid, text, text, text, text, integer, integer, text, jsonb
) FROM anon;

-- Defense in depth. An earlier draft of this comment justified the line by
-- claiming a future CREATE OR REPLACE would re-establish PUBLIC EXECUTE. That is
-- WRONG, and it was corrected in review: PostgreSQL preserves a function's owner
-- and ACL across CREATE OR REPLACE. Probed on this database to be sure — created
-- a throwaway function, revoked EXECUTE from PUBLIC, replaced it, and read
-- pg_proc.proacl back: PUBLIC was still absent.
--
-- The REAL re-grant risk is DROP + CREATE, or adding a NEW OVERLOADED SIGNATURE
-- (a different argument list is a different function and gets a fresh ACL).
-- Either path re-runs this project's default privileges — and on this database
-- pg_default_acl for functions in `public` grants EXECUTE to anon, authenticated
-- AND service_role:
--
--   schema  objtype  owner            default_acl
--   public  f        supabase_admin   postgres=X, anon=X, authenticated=X, service_role=X
--   public  f        postgres         postgres=X, anon=X, authenticated=X, service_role=X
--
-- So the revoke above is NOT self-sustaining: recreate this function under a new
-- signature and `anon` comes straight back, silently. Anyone changing this
-- function's argument list must re-apply the revoke.
--
-- The PUBLIC revoke below is kept because it is harmless and correct as a
-- belt-and-braces default, not because CREATE OR REPLACE would undo it.
REVOKE EXECUTE ON FUNCTION public.record_analyst_feedback(
  uuid, uuid, text, text, text, text, integer, integer, text, jsonb
) FROM PUBLIC;
