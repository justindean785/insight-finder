-- C-1 (deterministic clustering): give artifacts a cluster_id + subject_id, written by
-- the in-code union-find (supabase/functions/osint-agent/lib/cluster.ts) as the last
-- deterministic step of every run — independent of the LLM correlate tool. Both are
-- nullable so excluded_collision rows (and any not-yet-clustered rows) stay null without
-- breaking the existing artifacts write contract for current consumers.
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS cluster_id TEXT;
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS subject_id TEXT;

-- Group a thread's artifacts by resolved subject for the UI / consolidation reads.
CREATE INDEX IF NOT EXISTS idx_artifacts_subject ON public.artifacts(thread_id, subject_id);

-- Backfill note: a union-find is code, not SQL, so there is no destructive SQL backfill
-- here. Existing rows acquire cluster_id/subject_id the next time their thread runs
-- (applyClusteringToThread in lib/cluster.ts), or via a one-off invocation of the
-- cluster.ts CLI (`deno run -A lib/cluster.ts --fixture <thread-export>.csv`).
