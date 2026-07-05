-- TEMPORARY: deliberate syntax error to prove the CI migrations gate fails red.
-- This commit will be reverted immediately; never merge.
CREATE TABLE public.ci_break_test (
  id uuid PRIMARY KEY,,
  broken_on_purpose text NOT NULL
;
