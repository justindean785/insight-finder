-- Allow non-admin users to read their OWN security test runs.
-- Admins keep the broader "view all" policy.
-- This is an audit-driven follow-up: F-A5 in the post-launch checklist.

CREATE POLICY "Users view own security tests"
  ON public.security_tests FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
