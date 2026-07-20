-- Least-privilege grant assertions for the D1 hardening (20260718000001) plus the
-- client_errors (20260712) and analyst_feedback_events (20260717) surface.
-- Runs against a FULLY migrated database. Pure catalog assertions
-- (has_table_privilege / has_function_privilege) — creates no data.
--
-- Meaningful only because the CI shim replicates Supabase's default-privilege
-- over-grant (ALL to anon/authenticated on every new public table): without the
-- D1 REVOKE these would be ALL, so a green run proves D1 actually tightened.
\set ON_ERROR_STOP on

-- client_errors: anon + authenticated may INSERT ONLY; never SELECT/UPDATE/DELETE/TRUNCATE.
DO $$
BEGIN
  IF NOT has_table_privilege('anon','public.client_errors','INSERT')            THEN RAISE EXCEPTION 'client_errors: anon must have INSERT'; END IF;
  IF     has_table_privilege('anon','public.client_errors','SELECT')            THEN RAISE EXCEPTION 'client_errors: anon must NOT have SELECT'; END IF;
  IF     has_table_privilege('anon','public.client_errors','UPDATE')            THEN RAISE EXCEPTION 'client_errors: anon must NOT have UPDATE'; END IF;
  IF     has_table_privilege('anon','public.client_errors','DELETE')            THEN RAISE EXCEPTION 'client_errors: anon must NOT have DELETE'; END IF;
  IF     has_table_privilege('anon','public.client_errors','TRUNCATE')          THEN RAISE EXCEPTION 'client_errors: anon must NOT have TRUNCATE'; END IF;
  IF NOT has_table_privilege('authenticated','public.client_errors','INSERT')   THEN RAISE EXCEPTION 'client_errors: authenticated must have INSERT'; END IF;
  IF     has_table_privilege('authenticated','public.client_errors','SELECT')   THEN RAISE EXCEPTION 'client_errors: authenticated must NOT have SELECT'; END IF;
  IF     has_table_privilege('authenticated','public.client_errors','UPDATE')   THEN RAISE EXCEPTION 'client_errors: authenticated must NOT have UPDATE'; END IF;
  IF     has_table_privilege('authenticated','public.client_errors','DELETE')   THEN RAISE EXCEPTION 'client_errors: authenticated must NOT have DELETE'; END IF;
  IF     has_table_privilege('authenticated','public.client_errors','TRUNCATE') THEN RAISE EXCEPTION 'client_errors: authenticated must NOT have TRUNCATE'; END IF;
  -- service_role intended privileges preserved (migration GRANT ALL): spot-check DELETE.
  IF NOT has_table_privilege('service_role','public.client_errors','DELETE')    THEN RAISE EXCEPTION 'client_errors: service_role must retain DELETE (preserved)'; END IF;
  RAISE NOTICE 'PASS: client_errors least-privilege grants correct';
END $$;

-- analyst_feedback_events: authenticated SELECT ONLY; anon nothing; writes only via the SECDEF RPC.
DO $$
BEGIN
  IF     has_table_privilege('anon','public.analyst_feedback_events','SELECT')            THEN RAISE EXCEPTION 'afe: anon must NOT have SELECT'; END IF;
  IF     has_table_privilege('anon','public.analyst_feedback_events','INSERT')            THEN RAISE EXCEPTION 'afe: anon must NOT have INSERT'; END IF;
  IF     has_table_privilege('anon','public.analyst_feedback_events','TRUNCATE')          THEN RAISE EXCEPTION 'afe: anon must NOT have TRUNCATE'; END IF;
  IF NOT has_table_privilege('authenticated','public.analyst_feedback_events','SELECT')   THEN RAISE EXCEPTION 'afe: authenticated must have SELECT'; END IF;
  IF     has_table_privilege('authenticated','public.analyst_feedback_events','INSERT')   THEN RAISE EXCEPTION 'afe: authenticated must NOT have INSERT (writes only via RPC)'; END IF;
  IF     has_table_privilege('authenticated','public.analyst_feedback_events','UPDATE')   THEN RAISE EXCEPTION 'afe: authenticated must NOT have UPDATE'; END IF;
  IF     has_table_privilege('authenticated','public.analyst_feedback_events','DELETE')   THEN RAISE EXCEPTION 'afe: authenticated must NOT have DELETE'; END IF;
  IF     has_table_privilege('authenticated','public.analyst_feedback_events','TRUNCATE') THEN RAISE EXCEPTION 'afe: authenticated must NOT have TRUNCATE'; END IF;
  -- service_role intended privileges preserved (migration GRANT SELECT, INSERT): spot-check INSERT.
  IF NOT has_table_privilege('service_role','public.analyst_feedback_events','INSERT')    THEN RAISE EXCEPTION 'afe: service_role must retain INSERT (preserved)'; END IF;
  RAISE NOTICE 'PASS: analyst_feedback_events least-privilege grants correct';
END $$;

-- Function EXECUTE grants preserved; purge locked to service_role.
DO $$
BEGIN
  IF NOT has_function_privilege('authenticated','public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'record_analyst_feedback: authenticated EXECUTE must be preserved'; END IF;
  IF NOT has_function_privilege('service_role','public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'record_analyst_feedback: service_role EXECUTE must be preserved'; END IF;
  IF NOT has_function_privilege('service_role','public.purge_client_errors(integer)','EXECUTE') THEN RAISE EXCEPTION 'purge_client_errors: service_role EXECUTE must be preserved'; END IF;
  IF     has_function_privilege('anon','public.purge_client_errors(integer)','EXECUTE')          THEN RAISE EXCEPTION 'purge_client_errors: anon must NOT execute'; END IF;
  IF     has_function_privilege('authenticated','public.purge_client_errors(integer)','EXECUTE') THEN RAISE EXCEPTION 'purge_client_errors: authenticated must NOT execute'; END IF;
  RAISE NOTICE 'PASS: function EXECUTE grants correct';
END $$;

SELECT 'ALL LEAST-PRIVILEGE GRANT ASSERTIONS PASSED' AS result;
