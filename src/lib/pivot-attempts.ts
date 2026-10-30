import { __collectTargets } from "@/hooks/useThreadQueriedTargets";

/**
 * What tools have already done against each selector on this thread, read from
 * `tool_usage_log`. READ-ONLY and pure: it summarises rows it is handed and never
 * runs anything. Cached replays are counted apart from live calls, because a
 * replay consumed no paid slot and says nothing new about the selector.
 *
 * LIMIT (measured, not assumed): the log records whether a call succeeded, not
 * what it returned. A successful call that found nothing and one that found ten
 * rows look the same here, so "duplicate-only" and "empty" cannot be told apart
 * from this table. Those signals need the tool output, which is not stored.
 */
export type AttemptRow = {
  tool_name: string;
  ok: boolean;
  cached: boolean;
  input_json: unknown;
};

export type AttemptSummary = {
  /** Live calls (cached replays excluded). */
  liveCount: number;
  /** Live calls that returned ok. */
  okCount: number;
  /** Live calls that failed. */
  failedCount: number;
  /** Cached replays — no paid slot consumed, no new information. */
  cachedCount: number;
  /** Distinct tool names that were run against the selector, sorted. */
  tools: string[];
};

type Mutable = { liveCount: number; okCount: number; failedCount: number; cachedCount: number; tools: Set<string> };

/**
 * Summarise prior attempts per normalized selector. Keys use the same
 * `normalizeTarget` form as the pivot engine's queried set, so a summary can be
 * looked up with the candidate's own key.
 */
export function summarizeAttempts(rows: readonly AttemptRow[]): Map<string, AttemptSummary> {
  const acc = new Map<string, Mutable>();
  for (const row of rows) {
    const targets = new Set<string>();
    __collectTargets(row.input_json, targets);
    targets.delete("");
    for (const t of targets) {
      let s = acc.get(t);
      if (!s) {
        s = { liveCount: 0, okCount: 0, failedCount: 0, cachedCount: 0, tools: new Set() };
        acc.set(t, s);
      }
      s.tools.add(row.tool_name);
      if (row.cached) {
        s.cachedCount += 1;
        continue;
      }
      s.liveCount += 1;
      if (row.ok) s.okCount += 1;
      else s.failedCount += 1;
    }
  }
  const out = new Map<string, AttemptSummary>();
  for (const [key, s] of acc) {
    out.set(key, {
      liveCount: s.liveCount,
      okCount: s.okCount,
      failedCount: s.failedCount,
      cachedCount: s.cachedCount,
      tools: [...s.tools].sort(),
    });
  }
  return out;
}
