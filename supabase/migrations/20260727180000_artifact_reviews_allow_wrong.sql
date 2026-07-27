-- Allow the 'wrong' review state on public.artifact_reviews.
--
-- THE BUG: the CHECK constraint permitted only
--   ('confirmed','key','recheck','dismissed')
-- but the product's "mark false" control writes state='wrong'
-- (src/lib/review.ts REVIEW_CONFIDENCE_DELTA.wrong = -40, and reviews.ts
-- REJECTED_REVIEW_STATES = {dismissed, wrong}).
--
-- Every "mark false" therefore violated the constraint and was rejected by the
-- database. The frontend never checks the upsert's error, and it sets local
-- state BEFORE the write, so the analyst saw a green mark, got a durable
-- agent_memory lesson written on the very next line, and no review row at all.
--
-- Measured on production before this migration:
--   confirmed 310 | key 185 | dismissed 116 | recheck 38 | wrong 0
-- Zero in 649 rows — not because the control was unused (one analyst session on
-- 2026-07-27 produced 45 rejections visible in the UI) but because every single
-- one was discarded on write.
--
-- Downstream this silently disabled the whole rejection path: reviews.ts filters
-- on REJECTED_REVIEW_STATES, so it was looking for rows that could never exist,
-- and a finding the analyst marked FALSE stayed eligible for clustering, the
-- investigation cache, salvage and recovery reports.
--
-- Idempotent: safe to re-run.
alter table public.artifact_reviews
  drop constraint if exists artifact_reviews_state_check;

alter table public.artifact_reviews
  add constraint artifact_reviews_state_check
  check (state = any (array['confirmed', 'key', 'recheck', 'dismissed', 'wrong']));
