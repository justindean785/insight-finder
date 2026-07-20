-- CI parity assertion (see .github/ci/supabase-platform-shim.sql).
-- Production installs pgcrypto in the `extensions` schema, never `public`. If a
-- future shim change (or a stray bare CREATE EXTENSION) put digest() back into
-- `public`, a SECURITY DEFINER function with `SET search_path = public` would
-- falsely resolve it and re-mask the record_analyst_feedback regression that
-- 20260718000000 fixes. Fail the CI job loudly if that parity is ever broken.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'CI parity FAIL: extensions.digest(bytea,text) is missing — pgcrypto must be installed in the extensions schema (production parity).';
  END IF;
  IF to_regprocedure('public.digest(bytea,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'CI parity FAIL: public.digest(bytea,text) exists — production has pgcrypto only in extensions; a public-search_path SECURITY DEFINER function would falsely resolve it and re-mask the regression.';
  END IF;
  RAISE NOTICE 'pgcrypto schema parity OK: extensions.digest present, public.digest absent.';
END $$;
