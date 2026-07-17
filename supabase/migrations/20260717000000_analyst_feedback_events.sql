-- ============================================================================
-- Calibration + ground-truth capture (instrumentation-only milestone)
-- ----------------------------------------------------------------------------
-- Immutable, append-only log of every analyst judgment, plus read-only
-- calibration views. NOTHING in live confidence scoring, tiering, clustering,
-- analyst-confirmation effects, or orchestration reads this table — it is a
-- ground-truth substrate for MEASURING calibration, not for changing scores.
--
-- Security model (mirrors public.append_evidence / evidence_log):
--   * Written ONLY via record_analyst_feedback() (SECURITY DEFINER), so the
--     analyst_id is derived from auth.uid() and can NEVER be client-supplied.
--   * Thread ownership + artifact-belongs-to-thread are enforced in the RPC.
--   * Append-only: authenticated gets SELECT only; a BEFORE UPDATE/DELETE
--     trigger raises even for service_role, so history is immutable.
--   * Per-thread hash chain (prev_hash → chain_hash) makes tampering detectable.
--   * Per-thread advisory lock serializes writers so concurrent inserts can't
--     corrupt the sequence / chain.
-- Rollback: this migration is reversible by DROP (see the down section at the
--   bottom, commented). Dropping discards collected ground truth — intentional,
--   documented in docs/CALIBRATION_MILESTONE.md.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.analyst_feedback_events (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                       bigint      NOT NULL,               -- per-thread monotonic (chain order)
  thread_id                 uuid        NOT NULL,
  artifact_id               uuid,                               -- nullable: manual_tool_selection etc. aren't artifact-scoped
  run_id                    text,                               -- best-effort: thread.run_started_at at event time
  analyst_id                uuid        NOT NULL,               -- = auth.uid(), enforced server-side
  action                    text        NOT NULL,
  prior_state               text,
  resulting_state           text,
  reason                    text,
  confidence_before         integer,
  confidence_after          integer,
  confidence_model_version  text        NOT NULL,
  source_lineage            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  label_quality             text        NOT NULL DEFAULT 'clean',
  content_hash              text        NOT NULL,
  prev_hash                 text        NOT NULL,
  chain_hash                text        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analyst_feedback_action_chk CHECK (action IN (
    'confirm','key','recheck','dismiss','wrong','reject',
    'merge','split','corrected_entity','accept_pivot','reject_pivot','manual_tool_selection'
  )),
  CONSTRAINT analyst_feedback_label_quality_chk CHECK (label_quality IN ('clean','unresolved','contradictory','reversed')),
  CONSTRAINT analyst_feedback_conf_before_chk CHECK (confidence_before IS NULL OR confidence_before BETWEEN 0 AND 100),
  CONSTRAINT analyst_feedback_conf_after_chk  CHECK (confidence_after  IS NULL OR confidence_after  BETWEEN 0 AND 100)
);

-- Chain integrity: one seq per thread.
CREATE UNIQUE INDEX IF NOT EXISTS analyst_feedback_thread_seq_idx
  ON public.analyst_feedback_events (thread_id, seq);
-- RLS + per-analyst queries.
CREATE INDEX IF NOT EXISTS analyst_feedback_analyst_created_idx
  ON public.analyst_feedback_events (analyst_id, created_at DESC);
-- Join to artifacts (calibration) + "latest event per (analyst, artifact)".
CREATE INDEX IF NOT EXISTS analyst_feedback_artifact_idx
  ON public.analyst_feedback_events (artifact_id) WHERE artifact_id IS NOT NULL;
-- Calibration slices by model version.
CREATE INDEX IF NOT EXISTS analyst_feedback_model_version_idx
  ON public.analyst_feedback_events (confidence_model_version);

-- ---------------------------------------------------------------------------
-- Append-only enforcement: block UPDATE/DELETE for EVERYONE (incl. service_role)
-- so the record is immutable. Corrections are new events, never edits.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.analyst_feedback_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'analyst_feedback_events is append-only (no % permitted)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS analyst_feedback_no_update ON public.analyst_feedback_events;
CREATE TRIGGER analyst_feedback_no_update
  BEFORE UPDATE ON public.analyst_feedback_events
  FOR EACH ROW EXECUTE FUNCTION public.analyst_feedback_block_mutation();

DROP TRIGGER IF EXISTS analyst_feedback_no_delete ON public.analyst_feedback_events;
CREATE TRIGGER analyst_feedback_no_delete
  BEFORE DELETE ON public.analyst_feedback_events
  FOR EACH ROW EXECUTE FUNCTION public.analyst_feedback_block_mutation();

-- Row triggers don't cover TRUNCATE; add a statement-level guard so the log is
-- immutable against TRUNCATE too (defense in depth against an admin mistake).
DROP TRIGGER IF EXISTS analyst_feedback_no_truncate ON public.analyst_feedback_events;
CREATE TRIGGER analyst_feedback_no_truncate
  BEFORE TRUNCATE ON public.analyst_feedback_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.analyst_feedback_block_mutation();

-- ---------------------------------------------------------------------------
-- RLS: authenticated may READ ONLY their own events. No direct writes — all
-- inserts go through record_analyst_feedback() (SECURITY DEFINER). service_role
-- may read all (operator calibration) but still cannot UPDATE/DELETE (trigger).
-- ---------------------------------------------------------------------------
ALTER TABLE public.analyst_feedback_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.analyst_feedback_events TO authenticated;
GRANT SELECT, INSERT ON public.analyst_feedback_events TO service_role;

DROP POLICY IF EXISTS "Analysts read own feedback" ON public.analyst_feedback_events;
CREATE POLICY "Analysts read own feedback"
  ON public.analyst_feedback_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = analyst_id);

-- ---------------------------------------------------------------------------
-- record_analyst_feedback(): the ONLY write path. Derives analyst_id from
-- auth.uid(); enforces thread ownership + artifact↔thread; idempotent for a
-- repeated identical latest action; per-thread advisory lock + hash chain.
-- Returns (id, seq, deduped) — deduped=true means the last identical event was
-- returned without inserting a new row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_analyst_feedback(
  _thread_id                uuid,
  _artifact_id              uuid,
  _action                   text,
  _prior_state              text,
  _resulting_state          text,
  _reason                   text,
  _confidence_before        integer,
  _confidence_after         integer,
  _confidence_model_version text,
  _source_lineage           jsonb
) RETURNS TABLE(id uuid, seq bigint, deduped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid     uuid := auth.uid();
  _seq     bigint;
  _prev    text;
  _content text;
  _ch      text;
  _run     text;
  _last    public.analyst_feedback_events%ROWTYPE;
  _new_id  uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'must be authenticated';
  END IF;
  IF _action NOT IN (
    'confirm','key','recheck','dismiss','wrong','reject',
    'merge','split','corrected_entity','accept_pivot','reject_pivot','manual_tool_selection'
  ) THEN
    RAISE EXCEPTION 'invalid action %', _action;
  END IF;
  IF _confidence_model_version IS NULL OR length(_confidence_model_version) = 0 THEN
    RAISE EXCEPTION 'confidence_model_version required';
  END IF;
  -- Tenant + thread ownership (no client-supplied analyst_id is trusted).
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  -- Artifact, when present, must belong to the SAME thread (hence same user).
  IF _artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.artifacts a WHERE a.id = _artifact_id AND a.thread_id = _thread_id
  ) THEN
    RAISE EXCEPTION 'artifact does not belong to thread';
  END IF;

  -- Serialize writers for this thread so seq/chain can't be corrupted by a race.
  PERFORM pg_advisory_xact_lock(hashtextextended(_thread_id::text, 0));

  -- Idempotency: if this analyst's most recent event for this (thread, artifact)
  -- is identical in (action, resulting_state, reason), return it — a double click
  -- or network retry must not append a duplicate.
  SELECT * INTO _last
    FROM public.analyst_feedback_events e
   WHERE e.analyst_id = _uid
     AND e.thread_id = _thread_id
     AND e.artifact_id IS NOT DISTINCT FROM _artifact_id
   ORDER BY e.seq DESC
   LIMIT 1;
  IF _last.id IS NOT NULL
     AND _last.action = _action
     AND _last.resulting_state IS NOT DISTINCT FROM _resulting_state
     AND _last.reason IS NOT DISTINCT FROM _reason THEN
    RETURN QUERY SELECT _last.id, _last.seq, true;
    RETURN;
  END IF;

  SELECT to_char(t.run_started_at, 'YYYYMMDD"T"HH24MISS')
    INTO _run
    FROM public.threads t
   WHERE t.id = _thread_id;

  -- Qualify column refs: `id`/`seq` are also OUT-parameter names, so an
  -- unqualified `MAX(seq)` is ambiguous (caught on real PostgreSQL).
  SELECT COALESCE(MAX(afe.seq), 0) + 1 INTO _seq
    FROM public.analyst_feedback_events afe WHERE afe.thread_id = _thread_id;
  SELECT afe.chain_hash INTO _prev
    FROM public.analyst_feedback_events afe WHERE afe.thread_id = _thread_id
    ORDER BY afe.seq DESC LIMIT 1;
  IF _prev IS NULL THEN
    _prev := repeat('0', 64);
  END IF;

  _content := encode(digest(
    concat_ws('|',
      _action,
      coalesce(_artifact_id::text, ''),
      coalesce(_prior_state, ''),
      coalesce(_resulting_state, ''),
      coalesce(_reason, ''),
      coalesce(_confidence_before::text, ''),
      coalesce(_confidence_after::text, ''),
      _confidence_model_version,
      coalesce(_source_lineage::text, '{}')
    ), 'sha256'), 'hex');
  _ch := encode(digest(_prev || _content, 'sha256'), 'hex');

  INSERT INTO public.analyst_feedback_events(
    seq, thread_id, artifact_id, run_id, analyst_id, action, prior_state,
    resulting_state, reason, confidence_before, confidence_after,
    confidence_model_version, source_lineage, content_hash, prev_hash, chain_hash
  ) VALUES (
    _seq, _thread_id, _artifact_id, _run, _uid, _action, _prior_state,
    _resulting_state, _reason, _confidence_before, _confidence_after,
    _confidence_model_version, coalesce(_source_lineage, '{}'::jsonb), _content, _prev, _ch
  ) RETURNING analyst_feedback_events.id INTO _new_id;

  RETURN QUERY SELECT _new_id, _seq, false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Read-only calibration views (security_invoker so RLS applies: an analyst sees
-- calibration over THEIR labels; service_role sees global). All statistical math
-- (Brier/ECE/Wilson) lives in the tested TS module src/lib/calibration.ts; these
-- views expose the clean labeled dataset + basic per-band counts it consumes.
-- ---------------------------------------------------------------------------

-- One row per RESOLVED label: the analyst's FINAL judgment per (analyst, artifact)
-- (DISTINCT ON latest seq), so an immediately-reversed click keeps only the final
-- state. y = 1 (confirm/key), 0 (dismiss/wrong/reject), excluded when recheck/other.
CREATE OR REPLACE VIEW public.v_analyst_feedback_resolved
WITH (security_invoker = true) AS
SELECT DISTINCT ON (e.analyst_id, e.artifact_id)
  e.id                        AS event_id,
  e.analyst_id,
  e.thread_id,
  e.artifact_id,
  e.confidence_before         AS confidence,
  e.confidence_model_version,
  e.action,
  e.resulting_state,
  e.label_quality,
  e.source_lineage,
  a.kind                      AS artifact_kind,
  a.source                    AS artifact_source,
  e.created_at,
  CASE
    WHEN e.action IN ('confirm','key') OR e.resulting_state IN ('confirmed','key') THEN 1
    WHEN e.action IN ('dismiss','wrong','reject') OR e.resulting_state IN ('dismissed','wrong') THEN 0
    ELSE NULL
  END                         AS y
FROM public.analyst_feedback_events e
LEFT JOIN public.artifacts a ON a.id = e.artifact_id
WHERE e.artifact_id IS NOT NULL
ORDER BY e.analyst_id, e.artifact_id, e.seq DESC;

-- Clean ground truth: resolved (y not null), label_quality='clean', and NOT
-- contradictory (an artifact where different analysts reached different y).
CREATE OR REPLACE VIEW public.v_analyst_feedback_clean
WITH (security_invoker = true) AS
WITH resolved AS (
  SELECT * FROM public.v_analyst_feedback_resolved WHERE y IS NOT NULL AND label_quality = 'clean'
),
contradictory AS (
  SELECT artifact_id FROM resolved GROUP BY artifact_id HAVING count(DISTINCT y) > 1
)
SELECT r.*
FROM resolved r
WHERE r.artifact_id NOT IN (SELECT artifact_id FROM contradictory);

-- Per-confidence-band counts (the dataset for precision-by-band / reliability).
CREATE OR REPLACE VIEW public.v_calibration_by_band
WITH (security_invoker = true) AS
SELECT
  confidence_model_version,
  CASE WHEN confidence >= 90 THEN '90-100'
       WHEN confidence >= 75 THEN '75-89'
       WHEN confidence >= 55 THEN '55-74'
       WHEN confidence >= 35 THEN '35-54'
       ELSE '0-34' END                                   AS band,
  count(*)                                               AS n,
  sum(y)                                                 AS confirmed,
  round(avg(y)::numeric, 4)                              AS empirical_confirm_rate
FROM public.v_analyst_feedback_clean
WHERE confidence IS NOT NULL
GROUP BY confidence_model_version, band;

-- Confirmation / rejection rates by artifact kind.
CREATE OR REPLACE VIEW public.v_calibration_by_kind
WITH (security_invoker = true) AS
SELECT
  confidence_model_version,
  artifact_kind,
  count(*)                    AS n,
  sum(y)                      AS confirmed,
  count(*) - sum(y)           AS rejected,
  round(avg(y)::numeric, 4)   AS confirm_rate
FROM public.v_analyst_feedback_clean
GROUP BY confidence_model_version, artifact_kind;

-- ============================================================================
-- ROLLBACK (down) — run manually to fully reverse. Kept commented so the
-- forward migration is idempotent and CI-applied without executing the drop.
-- ----------------------------------------------------------------------------
-- DROP VIEW IF EXISTS public.v_calibration_by_kind;
-- DROP VIEW IF EXISTS public.v_calibration_by_band;
-- DROP VIEW IF EXISTS public.v_analyst_feedback_clean;
-- DROP VIEW IF EXISTS public.v_analyst_feedback_resolved;
-- DROP FUNCTION IF EXISTS public.record_analyst_feedback(uuid,uuid,text,text,text,text,integer,integer,text,jsonb);
-- DROP TRIGGER IF EXISTS analyst_feedback_no_delete ON public.analyst_feedback_events;
-- DROP TRIGGER IF EXISTS analyst_feedback_no_update ON public.analyst_feedback_events;
-- DROP FUNCTION IF EXISTS public.analyst_feedback_block_mutation();
-- DROP TABLE IF EXISTS public.analyst_feedback_events;
-- ============================================================================
