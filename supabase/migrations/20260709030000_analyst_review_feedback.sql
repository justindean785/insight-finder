-- Analyst feedback loop (audit #2): propagate a review verdict into the evidence
-- grade (classification_grade), the artifact's persisted verdict (metadata.review_state),
-- and the chain of custody (an appended analyst_review row).
--
-- WHY AN RPC: for authenticated users `evidence_log` and `tool_usage_log` are
-- SELECT-only under RLS (verified 2026-07-09), so the frontend cannot update the
-- grade or write telemetry directly. This SECURITY DEFINER function performs the
-- effects server-side, ownership-checked. It touches ONLY the non-hashed
-- classification_grade on existing evidence rows — never classification /
-- content_hash / chain_hash — so the tamper-evident chain is preserved.
--
-- CONFIDENCE IS NOT MUTATED: the frontend adjustedConfidence() already renders the
-- review delta from the raw artifacts.confidence. Persisting the delta here too
-- would double-count it and leak the verdict into clustering's promotion base, so
-- the verdict rides on review_state (top precedence) + the grade instead. (This is
-- a deliberate deviation from the brief's "persist confidence+20" — see the PR.)
--
-- Tool-reliability-from-feedback is DEFERRED to its own ticket: tool_health.ok_pct
-- is measured on `outcome` (not the `ok` boolean), and writing outcome='failed'
-- for an analyst disagreement would conflate it with a vendor failure (the exact
-- signal-pollution the view was redesigned to remove). It will land later as a
-- distinct low-weight signal, not via ok_pct.

-- 1) Allow the 'wrong' review state (the frontend already emits it).
ALTER TABLE public.artifact_reviews DROP CONSTRAINT IF EXISTS artifact_reviews_state_check;
ALTER TABLE public.artifact_reviews ADD CONSTRAINT artifact_reviews_state_check
  CHECK (state IN ('confirmed','key','recheck','dismissed','wrong'));

-- 2) apply_artifact_review — the server-side side-effects of a review verdict.
CREATE OR REPLACE FUNCTION public.apply_artifact_review(
  _artifact_id uuid, _thread_id uuid, _state text
)
 RETURNS TABLE(new_confidence integer, grade text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _art public.artifacts%ROWTYPE;
  _grade text;
  _verified boolean := false;
  _rejected boolean := false;
  _is_verdict boolean;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = _thread_id AND t.user_id = _uid) THEN
    RAISE EXCEPTION 'thread not owned by caller';
  END IF;
  -- Ownership AND thread membership: the artifact must live in the named thread,
  -- so a caller can't graft one of their own artifacts onto another of their threads.
  SELECT * INTO _art FROM public.artifacts a
    WHERE a.id = _artifact_id AND a.user_id = _uid AND a.thread_id = _thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact not found in this thread'; END IF;

  _is_verdict := _state IN ('confirmed','key','recheck','dismissed','wrong');

  -- state -> grade. Confidence is deliberately NOT mutated here: the frontend
  -- adjustedConfidence() already renders the review delta from the raw
  -- artifacts.confidence, so persisting the delta too would DOUBLE-COUNT (a Confirm
  -- would show +40, not +20, and over-promote the tier) and would leak the analyst
  -- verdict into clustering's promotion base (cluster.ts reads artifacts.confidence).
  -- The verdict travels via review_state (top precedence) + the grade instead.
  -- Grade mapping mirrors lib/evidence_classify.ts gradeFromReviewState.
  IF    _state = 'confirmed' THEN _grade := 'verified';  _verified := true;
  ELSIF _state = 'key'       THEN _grade := 'verified';  _verified := true;
  ELSIF _state = 'recheck'   THEN _grade := 'weak';
  ELSIF _state = 'dismissed' THEN _grade := 'rejected';  _rejected := true;
  ELSIF _state = 'wrong'     THEN _grade := 'rejected';  _rejected := true;
  ELSE  _grade := 'unclassified'; -- 'new' / reset / unknown -> clear the verdict
  END IF;

  -- Persist the verdict on the ARTIFACT — the top-precedence source of truth
  -- (lib/evidence_classify.ts gradeForArtifact reads metadata.review_state), so the
  -- C-3 end-of-cycle reclassify pass PRESERVES the analyst's call. The jsonb merge
  -- is computed against the LIVE row (not a PL/pgSQL local), so a concurrent
  -- clustering write to metadata can't be clobbered by a stale read.
  IF _is_verdict THEN
    UPDATE public.artifacts
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'review_state', _state, 'user_verified', _verified, 'user_rejected', _rejected)
     WHERE id = _artifact_id;
  ELSE
    UPDATE public.artifacts
       SET metadata = COALESCE(metadata, '{}'::jsonb) - 'review_state' - 'user_verified' - 'user_rejected'
     WHERE id = _artifact_id;
  END IF;

  -- Reflect immediately on existing evidence rows. Value-match to procedural
  -- (artifact_id NULL) rows is restricted to STRONG selectors — never names/prose —
  -- mirroring evidence_classify.ts isStrongAnchor, so confirming one "Hamza Shakoor"
  -- can't grade a different person's rows. NON-hashed column only; chain untouched.
  UPDATE public.evidence_log el
     SET classification_grade = _grade
   WHERE el.thread_id = _thread_id
     AND ( el.artifact_id = _artifact_id
        OR (el.artifact_id IS NULL
            AND _art.kind IN ('email','phone','username','domain','account_id')
            AND el.kind = _art.kind AND el.value = _art.value) );

  -- Record the analyst's decision itself in the tamper-evident chain (hard =
  -- first-party attestation). Skip on reset.
  IF _is_verdict THEN
    PERFORM public.append_evidence(
      _thread_id, _artifact_id, 'analyst_review', 'analyst_review', NULL,
      'hard', _art.confidence, _art.kind, _art.value,
      jsonb_build_object('review_state', _state, 'reviewer', 'analyst', 'artifact_id', _artifact_id)::text,
      jsonb_build_object('review_state', _state, 'analyst_decision', true),
      _grade
    );
  END IF;

  RETURN QUERY SELECT _art.confidence, _grade;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_artifact_review(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_artifact_review(uuid, uuid, text) TO authenticated, service_role;
