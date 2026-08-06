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

export interface TabCountItem {
  kind: string | null | undefined;
}

export interface WorkspaceTabCounts {
  evidence: { value: number; alert: number };
  tools: { value: number; alert: number };
}

/**
 * Tab badges OWN the section counts, so a tab number always means "items in
 * this tab"; alerts ride along as a red dot.
 */
export function buildWorkspaceTabCounts(
  items: readonly TabCountItem[],
  persistedTotal: number,
): WorkspaceTabCounts {
  const breachCount = items.filter((a) => isBreachKind(a.kind)).length;
  return {
    evidence: { value: items.length, alert: breachCount },
    tools: { value: persistedTotal, alert: 0 },
  };
}
