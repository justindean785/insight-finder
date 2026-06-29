/**
 * Thread status helpers.
 *
 * A thread is "active" (in progress) until the backend writes a terminal status.
 * Status is treated as an OPEN string, not a closed enum: the osint-agent edge
 * function can write values the UI doesn't enumerate (e.g. "failed_context_limit",
 * legacy "completed"). The Cases sidebar partitions threads into active vs.
 * finished using this predicate and its negation, so the two buckets are EXACT
 * complements — no status value can ever fall through both and render nowhere.
 */
export function isActiveThreadStatus(status: string | null | undefined): boolean {
  return (status ?? "active") === "active";
}
