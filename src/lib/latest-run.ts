import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { AuthorityState } from "@/lib/authority";

export interface LatestRunSummary {
  startedAt: string;
  /** Records created at or after the run's durable start marker. */
  added: number;
  /** verified + infrastructure + probable, the same "supported" set the Overview lead uses. */
  supported: number;
  conflict: number;
  quarantined: number;
  /** Everything else new: review, weak, failed. */
  other: number;
}

const SUPPORTED: ReadonlySet<AuthorityState> = new Set(["verified", "infrastructure", "probable"]);

/**
 * What the latest run added, read off the durable `run_started_at` marker and
 * each record's `created_at`. Authority comes from the caller (`authorityFor`),
 * so this computes no evidence semantics of its own. No marker means no run to
 * describe, so it returns null rather than treating the whole case as new.
 */
export function summarizeLatestRun(
  items: readonly Artifact[],
  startedAt: string | null,
  stateOf: (a: Artifact) => AuthorityState,
): LatestRunSummary | null {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const out: LatestRunSummary = { startedAt: startedAt!, added: 0, supported: 0, conflict: 0, quarantined: 0, other: 0 };
  for (const a of items) {
    const t = Date.parse(a.created_at);
    if (!Number.isFinite(t) || t < start) continue;
    out.added += 1;
    const s = stateOf(a);
    if (SUPPORTED.has(s)) out.supported += 1;
    else if (s === "conflict") out.conflict += 1;
    else if (s === "quarantined") out.quarantined += 1;
    else out.other += 1;
  }
  return out;
}
