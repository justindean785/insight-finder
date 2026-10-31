/**
 * The three memory populations the Intelligence header names (plan
 * 2026-10-31 §4.1): stored (exact count of every `agent_memory` row), the
 * recent sample (the newest rows the page fetches, capped below) and shown
 * (the sample minus rows hidden in this browser). Kept out of the page file so
 * the caption logic is a pure function with its own tests.
 */

/** The page fetches this many of the newest rows; the header calls them the recent sample. */
export const MEMORY_SAMPLE_CAP = 500;

export type MemoryTotal =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ok"; total: number };

/**
 * The one sentence that names which memories the header's numbers are over.
 * Pure, so the state matrix in the plan (2026-10-31 §5.1) is testable row by
 * row. It must never claim completeness while the count is loading or failed.
 *
 *   loading           → "… of —"
 *   count failed      → "497 shown · total unavailable"
 *   total > sample    → "500 most recent of 1,672"
 *   total ≤ sample    → "12 memories (all stored)"
 *   + hidden rows     → "… · 3 hidden locally"
 */
export function describeMemorySample(p: {
  loading: boolean;
  sample: number;
  shown: number;
  hidden: number;
  total: MemoryTotal;
}): string {
  const hiddenNote = p.hidden > 0 ? ` · ${p.hidden.toLocaleString()} hidden locally` : "";
  if (p.loading || p.total.state === "loading") return "… of —";
  if (p.total.state === "error") return `${p.shown.toLocaleString()} shown · total unavailable${hiddenNote}`;
  if (p.total.total > p.sample) {
    return `${p.sample.toLocaleString()} most recent of ${p.total.total.toLocaleString()}${hiddenNote}`;
  }
  const n = p.sample;
  return `${n.toLocaleString()} ${n === 1 ? "memory" : "memories"} (all stored)${hiddenNote}`;
}

