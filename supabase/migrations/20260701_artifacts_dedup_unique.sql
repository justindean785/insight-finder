-- ⚠️ SIGN-OFF REQUIRED BEFORE APPLYING ⚠️
-- This migration DELETES duplicate artifact rows, then adds a uniqueness
-- guarantee. Artifacts feed the resources panel and are adjacent to the
-- evidence chain, which CLAUDE.md marks integrity-critical — review the dedup
-- key and keep-rule below before running it against production.
--
-- WHY: `public.artifacts` has no uniqueness constraint today, so the same
-- (thread_id, kind, value) can be written multiple times (model repeats a
-- finding, or two tool calls record the same value). The runtime now dedups
-- within a single record_artifacts batch (tool-registry.ts), but cross-call
-- and historical duplicates need this DB-level guard.
--
-- KEEP-RULE: for each (thread_id, kind, value), keep exactly ONE row — the
-- strongest/oldest evidence: highest confidence, then earliest created_at,
-- then lowest id — and delete the rest. Exact (thread_id, kind, value)
-- collisions are redundant by definition, so no unique evidence is lost.
--
-- NOTE: the unique index is on md5(value), not value, because artifact values
-- can exceed the btree row-size limit (~2704 bytes). md5 is a safe surrogate
-- for exact-match dedup here.

BEGIN;

-- 1. Remove existing duplicates, keeping the best row per (thread_id, kind, value).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY thread_id, kind, value
           ORDER BY COALESCE(confidence, 0) DESC, created_at ASC, id ASC
         ) AS rn
  FROM public.artifacts
)
DELETE FROM public.artifacts a
USING ranked r
WHERE a.id = r.id
  AND r.rn > 1;

-- 2. Prevent future duplicates. Insert-time collisions surface as a unique
--    violation; record_artifacts already falls back to per-row inserts so the
--    rest of the batch still lands.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_thread_kind_valuehash_uidx
  ON public.artifacts (thread_id, kind, md5(value));

COMMIT;
