-- Findings #9/#10 (release-gating audit, 2026-07-11): confidence values written
-- into `artifacts` were never bounded at the database layer, and artifact
-- deduplication existed only as an application-level SELECT-then-INSERT check
-- inside record_artifacts_with_evidence (20260711120100) with no DB constraint
-- backing it.
--
-- #9 — confidence bounds: `evidence_log.confidence` already carries
-- `CHECK (confidence BETWEEN 0 AND 100)` (20260528050804). `artifacts.confidence`
-- never got the same constraint, and the "Users insert own artifacts" RLS policy
-- (20260526140844) allows any authenticated client to INSERT INTO artifacts
-- directly via PostgREST — bypassing record_artifacts_with_evidence entirely, with
-- no bounds check of any kind. Six memory_save SQL functions similarly cast
-- `(e->>'confidence')::int` into `agent_memory.confidence` (also uncapped) with no
-- validation. This migration adds the same 0-100 CHECK to both columns —
-- table-level constraints apply to EVERY insert path, RPC or direct, closing the
-- bypass regardless of which code wrote the row. Non-numeric/NaN/Infinity-like
-- text already fails the `::integer` cast upstream (a Postgres error, which rolls
-- back the whole calling transaction — no partial write); this migration closes
-- the remaining gap: an in-range-looking integer that is simply out of bounds.
--
-- Added NOT VALID: this only skips the one-time validation scan of pre-existing
-- rows (relevant if this migration ever runs against a database with rows already
-- written through the unvalidated bypass) — every NEW or UPDATEd row is bounded
-- immediately, in every environment, from the moment this migration applies. See
-- the deployment runbook for the follow-up VALIDATE CONSTRAINT step.
--
-- #10 — deduplication: no UNIQUE constraint/index ever existed on `artifacts`.
-- record_artifacts_with_evidence's own SELECT-then-INSERT dedup check is
-- serialized only by the `FOR UPDATE` lock it takes on the thread row — a lock no
-- OTHER writer of `artifacts` (including a direct client INSERT via PostgREST)
-- ever takes, so two concurrent duplicate inserts (or one concurrent direct
-- insert racing the RPC) could both commit. This migration adds the missing
-- database-level uniqueness boundary: `(thread_id, kind, value, COALESCE(source,
-- ''))`, NULL-safe on `source` to match record_artifacts_with_evidence's own
-- `IS NOT DISTINCT FROM` dedup semantics exactly.
--
-- Because a UNIQUE INDEX (unlike a CHECK) cannot be added NOT VALID, any
-- pre-existing duplicates under that identity must be resolved FIRST or the
-- CREATE UNIQUE INDEX below fails. The DO block consolidates them
-- deterministically (earliest row by created_at/id survives) WITHOUT deleting any
-- evidence: every evidence_log row that pointed at a duplicate is re-pointed to
-- the surviving artifact id, never deleted, so seq/content_hash/chain_hash and
-- hash-chain integrity (verify_evidence_chain) are completely untouched — only
-- the artifacts table itself loses byte-identical duplicate rows. Idempotent: a
-- second run finds no duplicate groups (all already consolidated) and
-- `CREATE UNIQUE INDEX IF NOT EXISTS` no-ops.

-- ---- #9: confidence bounds, database-level, every insert path -----------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_confidence_range' AND conrelid = 'public.artifacts'::regclass
  ) THEN
    ALTER TABLE public.artifacts
      ADD CONSTRAINT artifacts_confidence_range CHECK (confidence BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_memory_confidence_range' AND conrelid = 'public.agent_memory'::regclass
  ) THEN
    ALTER TABLE public.agent_memory
      ADD CONSTRAINT agent_memory_confidence_range CHECK (confidence BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

-- ---- #10: consolidate any pre-existing exact duplicates, then enforce ---------
DO $$
DECLARE
  dup RECORD;
  keep_id uuid;
  dupe_ids uuid[];
BEGIN
  FOR dup IN
    SELECT thread_id, kind, value, COALESCE(source, '') AS src,
           array_agg(id ORDER BY created_at, id) AS ids
    FROM public.artifacts
    GROUP BY thread_id, kind, value, COALESCE(source, '')
    HAVING count(*) > 1
  LOOP
    keep_id := dup.ids[1];
    dupe_ids := dup.ids[2:array_length(dup.ids, 1)];
    -- Re-point custody rows to the surviving artifact — never delete evidence.
    UPDATE public.evidence_log SET artifact_id = keep_id WHERE artifact_id = ANY(dupe_ids);
    DELETE FROM public.artifacts WHERE id = ANY(dupe_ids);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_thread_kind_value_source_uidx
  ON public.artifacts (thread_id, kind, value, COALESCE(source, ''));
