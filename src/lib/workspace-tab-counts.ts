/**
 * workspace-tab-counts.ts — the counts behind the workspace tab badges.
 *
 * ONE SOURCE PER NUMBER. Every figure a tab prints is a figure some other
 * surface prints too, taken from the same selector, so the two can never read
 * differently on the same screen:
 *
 *   Evidence — "needs your call": conflicts, and rows whose linkage a release
 *              can decide. It is the case sheet's `queueTotal` (lib/case-sheet),
 *              the count beside "Needs your call", not a second derivation.
 *   Tools    — the persisted tool-call total the case header prints.
 *
 * The Evidence badge used to count the board's Analyst view (every state the
 * default filter shows) while the header counted every row, so a case read
 * "55 evidence" beside "Evidence 42" beside a sheet asking for 10 calls: three
 * numbers for one tab, none of them labelled. It also carried a red dot that
 * counted breach rows under the label "need attention", which a breach row
 * does not. The board's own filter chips still carry the Analyst-view and All
 * counts, where the filter they describe is.
 */

export interface WorkspaceTabCounts {
  /** `unit` is read by screen readers after the number ("10 awaiting your call"),
   *  so the badge is never a bare figure a reader could take for "10 of N
   *  evidence items" when it actually counts decisions needed. */
  evidence: { value: number; alert: number; hint?: string; unit?: string };
  /** `unit` is read by screen readers after the number ("18 tool calls"), so
   *  the badge is not a bare figure that could be taken for distinct tools. */
  tools: { value: number; alert: number; unit: string };
}

/**
 * `needsCall` is null until the review verdicts have been READ: those verdicts
 * decide the queue, so before then there is no honest number and the badge
 * shows none rather than a confident one.
 */
export function buildWorkspaceTabCounts(
  toolsTotal: number,
  needsCall: number | null,
): WorkspaceTabCounts {
  return {
    evidence: needsCall === null
      ? { value: 0, alert: 0 }
      : {
        value: needsCall,
        alert: 0,
        // Hint names the scope so the header's "55 evidence logged" and the
        // chip's "Evidence 10" are not read as the same denominator; the
        // chip counts open calls, the header counts persisted rows.
        hint: `${needsCall} awaiting your call — conflicts and rows whose linkage to the subject is unproven. Not a count of evidence items.`,
        unit: "awaiting your call",
      },
    tools: { value: toolsTotal, alert: 0, unit: toolsTotal === 1 ? "tool call" : "tool calls" },
  };
}
