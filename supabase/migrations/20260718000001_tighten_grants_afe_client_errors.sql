-- ============================================================================
-- 20260718000001_tighten_grants_afe_client_errors.sql   (PROPOSED — NOT applied)
-- ----------------------------------------------------------------------------
-- Durable, repo-tracked representation of the D1 least-privilege hardening.
-- Removes the Supabase default-privilege over-grant (ALL to anon/authenticated)
-- on two tables and re-grants exactly the intended minimum. Idempotent.
--
-- Narrow scope by design — does NOT touch: ALTER DEFAULT PRIVILEGES, service_role,
-- any function/view grants, or any other table. Each migration file runs atomically
-- under the Supabase CLI / the CI `psql -f` loop, so no explicit BEGIN/COMMIT.
--
-- Preserves both live consumers:
--   * client_errors  — client-side error INSERT (anon + authenticated).
--   * analyst_feedback_events — record_analyst_feedback() (SECURITY DEFINER RPC,
--     unaffected by caller table grants) + authenticated reading its own rows and
--     the security_invoker calibration views (need base-table SELECT under RLS).
-- ============================================================================

-- client_errors: INSERT-only for anon/authenticated (service_role ALL untouched).
REVOKE ALL PRIVILEGES ON TABLE public.client_errors FROM anon, authenticated;
GRANT INSERT ON TABLE public.client_errors TO anon, authenticated;

-- analyst_feedback_events: authenticated SELECT-only; anon none; writes only via RPC.
REVOKE ALL PRIVILEGES ON TABLE public.analyst_feedback_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.analyst_feedback_events TO authenticated;
