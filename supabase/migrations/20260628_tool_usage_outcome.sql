-- Honest tool-call telemetry: add a granular `outcome` column to tool_usage_log.
--
-- The old `ok` boolean conflated three very different things as "failure":
--   • real provider failures (5xx, genuine 4xx, timeout, abort)
--   • intentional GOVERNANCE skips (budget/burst/concurrency caps, dedup,
--     provider suppression, gating, missing-key/disabled stubs)
--   • EMPTY results (the lookup ran fine, the target simply has no record)
-- which inflated the beta failure rate (~22%) with non-errors. The application
-- now classifies every call via classifyToolOutcome() and writes the bucket
-- here; `ok` is relaxed to "not a hard failure" (skipped/empty → true).
--
-- Safe + idempotent: additive column, backfill only fills NULLs, indexed for
-- the dashboard. No existing column is altered or dropped.

ALTER TABLE public.tool_usage_log ADD COLUMN IF NOT EXISTS outcome text;

-- Backfill historical rows from their recorded ok / error_msg / status_code so
-- the dashboard reads honest numbers retroactively.
UPDATE public.tool_usage_log SET outcome = CASE
  WHEN ok THEN 'ok'
  WHEN error_msg ~* '(execution plan required|duplicate call|burst limit|same-tool (cycle limit|budget)|paid-call (cycle limit|budget)|active-call concurrency|internal concurrency cap|high-cost tool already used|weak lead blocked|expected value\s+[0-9]+\s+below|disabled after [0-9]+ consecutive|degraded this run|suppressed for investigation|selector blacklisted|unavailable:\s*(disabled|missing_key|gated)|gated|not configured|provider disabled in config|rate-limited\s*[-—]\s*provider)'
    THEN 'skipped'
  WHEN error_msg ~* '(no usable result|not found)' OR status_code = 404 THEN 'empty'
  ELSE 'failed'
END
WHERE outcome IS NULL;

CREATE INDEX IF NOT EXISTS tool_usage_log_outcome_idx ON public.tool_usage_log (outcome);
