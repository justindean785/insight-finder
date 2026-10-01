-- Two failures in agent memory, one root: the move to scope-aware memory in
-- 20260529145859 left the pre-scope objects behind.
--
-- 1. memory_save failed on a live case (2026-09-11) with
--      duplicate key value violates unique constraint "agent_memory_dedup_idx"
--      Key (user_id, kind, subject)=(…, pattern, bencaleb.com) already exists.
--    (The model then narrated it as "memory saves are being blocked by the
--    cross-subject merge guard", which is not what happened.)
--
--    20260529145859 added a `scope` column ('global' | 'case') and a unique index
--    on (user_id, kind, subject, scope). It meant to REPLACE the old 3-column
--    uniqueness — "Drop old unique constraint/index if it exists, replace with
--    scope-aware one" — but dropped it by a constraint name that never existed
--    (agent_memory_user_id_kind_subject_key). The real 3-column uniqueness is the
--    INDEX agent_memory_dedup_idx (20260528005449), and it survived. A subject
--    saved in one scope and then in the other passes the upsert's 4-column
--    ON CONFLICT arbiter and is refused by the stale index, failing the whole
--    memory_save batch.
--
-- 2. The analyst "Mark false" lesson (src/lib/review.ts) calls
--    save_agent_memories with three arguments. The pre-scope 3-argument overload
--    still exists beside the 4-argument one, whose `_scope` has a DEFAULT, so a
--    3-argument call matches both:
--      function public.save_agent_memories(uuid, unknown, jsonb) is not unique
--    — the lesson is never saved, and the analyst is told "Marked false, but the
--    agent lesson was not saved".
--
-- Both reproduced by applying every migration in order to a clean PostgreSQL 15,
-- as CI does.
--
-- FIX, in this order:
--   a. Drop the redundant 3-argument overload. A 3-argument call then resolves
--      to the 4-argument function with its default scope 'global' — which is
--      what the old overload's inserts meant (the column default). It is also
--      the only function that upserted ON CONFLICT (user_id, kind, subject), so
--      dropping it first means nothing depends on the index when it goes.
--   b. Restate the scope-aware unique index (a no-op where it exists).
--   c. Drop the stale 3-column index.
--
-- Behaviour is asserted in CI by .github/ci/assert-agent-memory-scope.sql.
--
-- ROLLBACK (not recommended — restores both failures): recreate
--   CREATE UNIQUE INDEX agent_memory_dedup_idx ON public.agent_memory (user_id, kind, subject);
-- (fails if a subject now exists in both scopes) and the 20260528235750
-- save_agent_memories(uuid, uuid, jsonb) with its grants.

DROP FUNCTION IF EXISTS public.save_agent_memories(uuid, uuid, jsonb);

CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_user_kind_subject_scope_uniq
  ON public.agent_memory (user_id, kind, subject, scope);

DROP INDEX IF EXISTS public.agent_memory_dedup_idx;
