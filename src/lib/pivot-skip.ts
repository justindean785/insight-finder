import { normalizeTarget } from "@/lib/next-step-cards";
import { pivotSkipStorageKey } from "@/lib/recommended-pivots";

/**
 * Pivots the analyst chose not to see. A DISPLAY preference, kept on this
 * device (localStorage, per case): it is not a review verdict, writes no
 * evidence, and changes no score or rank. `computePivots` already hard-hides any
 * target in this set, and the chat rail, the Next tab and the older Pivots panel
 * all read the same key, so a hidden lead stays hidden on every surface and
 * "Show hidden" brings it back everywhere.
 */
export const PIVOT_SKIP_EVENT = "swarmbot:pivot-skip-changed";

export function readPivotSkip(threadId: string): Set<string> {
  try {
    const raw = localStorage.getItem(pivotSkipStorageKey(threadId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function write(threadId: string, next: Set<string>): Set<string> {
  try {
    localStorage.setItem(pivotSkipStorageKey(threadId), JSON.stringify(Array.from(next)));
  } catch { /* private mode: the in-memory state still applies for this view */ }
  window.dispatchEvent(new CustomEvent(PIVOT_SKIP_EVENT, { detail: { threadId } }));
  return next;
}

/** Hide these targets (raw values; stored in the engine's normalized form). */
export function hidePivots(threadId: string, targets: readonly string[]): Set<string> {
  const next = readPivotSkip(threadId);
  for (const t of targets) {
    const k = normalizeTarget(t);
    if (k) next.add(k);
  }
  return write(threadId, next);
}

/** Show these targets again, or everything when none are named. */
export function restorePivots(threadId: string, targets?: readonly string[]): Set<string> {
  if (!targets) return write(threadId, new Set());
  const next = readPivotSkip(threadId);
  for (const t of targets) next.delete(normalizeTarget(t));
  return write(threadId, next);
}
