/**
 * Excluded Selectors Registry
 * Persistent tracking of excluded selector+tool combinations to prevent retry
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

export interface ExcludedSelector {
  tool_name: string;
  selector: string;
  reason: 'collision' | 'noise' | 'safety' | 'queried' | 'corroboration_held';
  excluded_in_round?: number;
  exclusion_rationale?: string;
  escalated_at?: string;
}

/**
 * Load excluded selectors from persistent storage for an investigation
 */
export async function loadExcludedSelectors(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
): Promise<Map<string, ExcludedSelector>> {
  const { data, error } = await supabase
    .from('pivot_excluded_selectors')
    .select('*')
    .eq('investigation_id', investigationId)
    .is('escalated_at', null); // Only unescalated exclusions are active

  if (error) {
    console.error('[pivot-loop] Failed to load excluded selectors:', error);
    return new Map();
  }

  const map = new Map<string, ExcludedSelector>();
  for (const row of data || []) {
    const key = `${row.tool_name}:${row.selector}`;
    map.set(key, {
      tool_name: row.tool_name,
      selector: row.selector,
      reason: row.reason,
      excluded_in_round: row.excluded_in_round,
      exclusion_rationale: row.exclusion_rationale,
      escalated_at: row.escalated_at,
    });
  }
  return map;
}

/**
 * Record a new excluded selector in persistent storage
 */
export async function recordExcludedSelector(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
  toolName: string,
  selector: string,
  reason: string,
  roundNumber: number,
  decision: string,
  rationale: string,
): Promise<boolean> {
  const { error } = await supabase.from('pivot_excluded_selectors').insert({
    investigation_id: investigationId,
    tool_name: toolName,
    selector: selector,
    reason: reason,
    excluded_in_round: roundNumber,
    excluded_by_decision: decision,
    exclusion_rationale: rationale,
  });

  if (error) {
    console.error('[pivot-loop] Failed to record excluded selector:', error);
    return false;
  }
  return true;
}

/**
 * Check if a selector is excluded
 */
export function isExcluded(
  excludedMap: Map<string, ExcludedSelector>,
  toolName: string,
  selector: string,
): boolean {
  const key = `${toolName}:${selector}`;
  return excludedMap.has(key);
}

/**
 * Get the reason an selector is excluded (for decision rationale)
 */
export function getExclusionReason(
  excludedMap: Map<string, ExcludedSelector>,
  toolName: string,
  selector: string,
): string | null {
  const key = `${toolName}:${selector}`;
  const excluded = excludedMap.get(key);
  return excluded ? excluded.reason : null;
}

/**
 * Escalate a previously excluded selector to allow retry
 * (e.g., user verification or corroboration completed)
 */
export async function escalateExcludedSelector(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
  toolName: string,
  selector: string,
  escalationArtifactId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pivot_excluded_selectors')
    .update({
      escalated_at: new Date().toISOString(),
      escalation_artifact_id: escalationArtifactId,
    })
    .eq('investigation_id', investigationId)
    .eq('tool_name', toolName)
    .eq('selector', selector);

  if (error) {
    console.error('[pivot-loop] Failed to escalate excluded selector:', error);
    return false;
  }
  return true;
}

/**
 * Clear escalations (e.g., if corroboration attempt failed)
 */
export async function clearEscalation(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
  toolName: string,
  selector: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pivot_excluded_selectors')
    .update({
      escalated_at: null,
      escalation_artifact_id: null,
    })
    .eq('investigation_id', investigationId)
    .eq('tool_name', toolName)
    .eq('selector', selector);

  if (error) {
    console.error('[pivot-loop] Failed to clear escalation:', error);
    return false;
  }
  return true;
}
