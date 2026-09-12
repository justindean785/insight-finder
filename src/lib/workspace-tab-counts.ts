/**
 * workspace-tab-counts.ts — the counts behind the workspace tab badges.
 *
 * WHY THIS EXISTS. This expression used to live inline, byte-identical, in both
 * CaseViewPage and ChatPage. When PR #405 collapsed `kind:"breach"` artifacts
 * into `breach_exposure` rows and swept the codebase for consumers of the
 * retired literal, both copies were missed — they are page components, not lib
 * modules — and both Evidence alert badges silently read 0 in production.
 *
 * Extracting it gives the badge one definition, one test, and one place to edit.
 *
 * Structurally typed on purpose: `Artifact` lives in `useThreadArtifacts`, and
 * importing a hook module here would drag React and the Supabase client into a
 * leaf. Same idiom as `isReputationArtifact` in intel.ts.
 */
import { isBreachKind } from "@/lib/breach-kinds";
import { countAnalystActionable, type AuthorityState } from "@/lib/authority";

export interface TabCountItem {
  kind: string | null | undefined;
}

export interface WorkspaceTabCounts {
  evidence: { value: number; alert: number; hint?: string };
  tools: { value: number; alert: number };
}

/**
 * Tab badges OWN the section counts; alerts ride along as a red dot.
 *
 * The Evidence badge counts what NEEDS A DECISION, not every row ever persisted.
 *
 * Those are different numbers by a lot. The board's default filter is "Analyst
 * view" and has hidden weak leads, quarantined rows and excluded namesakes since
 * #543 — measured, an average scan lands ~60 artifacts of which ~5 clear that
 * bar. But the badge beside it read `items.length`, so the tab advertised 123
 * while the board showed a dozen. That gap is the whole of "8 minute
 * investigations and 123 artifacts to sort through": the work was already being
 * filtered, and the badge kept announcing the noise.
 *
 * It counts through the SAME `ANALYST_ACTIONABLE_STATES` the board filters on, so
 * the two cannot drift — the failure this module was extracted to prevent, one
 * level up. Nothing is hidden: the board's "All" chip still carries the full
 * count and every row stays persisted and reviewable.
 *
 * `authority` is optional so a caller without a tally (or mid-load, before one
 * exists) degrades to the raw count rather than rendering a confident zero.
 */
export function buildWorkspaceTabCounts(
  items: readonly TabCountItem[],
  persistedTotal: number,
  authority?: Record<AuthorityState, number> | null,
): WorkspaceTabCounts {
  const breachCount = items.filter((a) => isBreachKind(a.kind)).length;
  return {
    evidence: authority
      ? {
        value: countAnalystActionable(authority),
        alert: breachCount,
        // The case header reports every persisted row; this badge reports what
        // needs a decision. Both numbers are on screen at once, so the gap is
        // stated here rather than left looking like two surfaces disagreeing.
        hint: `${countAnalystActionable(authority)} of ${items.length} need a decision — leads, quarantined and excluded rows are under the All filter`,
      }
      : { value: items.length, alert: breachCount },
    tools: { value: persistedTotal, alert: 0 },
  };
}
