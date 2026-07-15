/**
 * Round Persister
 * Utilities for saving and loading pivot rounds to/from persistent storage
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { type PivotRound, type PivotPlan, type IntelligenceDelta } from './types.ts';

/**
 * Create a new round in persistent storage
 */
export async function createPivotRound(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
  roundNumber: number,
  plan: PivotPlan,
  seedArtifactId?: string,
  seedReason?: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('pivot_rounds')
    .insert({
      investigation_id: investigationId,
      round_number: roundNumber,
      seed_artifact_id: seedArtifactId,
      seed_reason: seedReason,
      plan: plan,
      execution_results: [],
      round_complete: false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[pivot-loop] Failed to create round:', error);
    return null;
  }

  return data?.id || null;
}

/**
 * Load a round by ID
 */
export async function loadPivotRound(
  supabase: ReturnType<typeof createClient>,
  roundId: string,
): Promise<PivotRound | null> {
  const { data, error } = await supabase
    .from('pivot_rounds')
    .select('*')
    .eq('id', roundId)
    .single();

  if (error) {
    console.error('[pivot-loop] Failed to load round:', error);
    return null;
  }

  return data as PivotRound;
}

/**
 * Load the latest round for an investigation
 */
export async function loadLatestRound(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
): Promise<PivotRound | null> {
  const { data, error } = await supabase
    .from('pivot_rounds')
    .select('*')
    .eq('investigation_id', investigationId)
    .order('round_number', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error('[pivot-loop] Failed to load latest round:', error);
    return null;
  }

  return data as PivotRound;
}

/**
 * Load all rounds for an investigation
 */
export async function loadRoundsForInvestigation(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
): Promise<PivotRound[]> {
  const { data, error } = await supabase
    .from('pivot_rounds')
    .select('*')
    .eq('investigation_id', investigationId)
    .order('round_number', { ascending: true });

  if (error) {
    console.error('[pivot-loop] Failed to load rounds:', error);
    return [];
  }

  return (data || []) as PivotRound[];
}

/**
 * Update round with execution results
 */
export async function updateRoundExecution(
  supabase: ReturnType<typeof createClient>,
  roundId: string,
  executionResults: unknown[],
  startedAt: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pivot_rounds')
    .update({
      execution_results: executionResults,
      execution_started_at: startedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', roundId);

  if (error) {
    console.error('[pivot-loop] Failed to update round execution:', error);
    return false;
  }

  return true;
}

/**
 * Mark execution as complete
 */
export async function completeRoundExecution(
  supabase: ReturnType<typeof createClient>,
  roundId: string,
  completedAt: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pivot_rounds')
    .update({
      execution_completed_at: completedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', roundId);

  if (error) {
    console.error('[pivot-loop] Failed to mark round complete:', error);
    return false;
  }

  return true;
}

/**
 * Update round with intelligence delta and mark complete
 */
export async function finalizeRound(
  supabase: ReturnType<typeof createClient>,
  roundId: string,
  delta: IntelligenceDelta,
  finalReason: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('pivot_rounds')
    .update({
      intelligence_delta: delta,
      round_complete: true,
      final_reason: finalReason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', roundId);

  if (error) {
    console.error('[pivot-loop] Failed to finalize round:', error);
    return false;
  }

  return true;
}

/**
 * Get summary of completed rounds (for context/analytics)
 */
export async function getRoundSummary(
  supabase: ReturnType<typeof createClient>,
  investigationId: string,
): Promise<{
  total_rounds: number;
  completed_rounds: number;
  total_artifacts_created: number;
  total_tools_executed: number;
} | null> {
  const { data: rounds, error } = await supabase
    .from('pivot_rounds')
    .select('*')
    .eq('investigation_id', investigationId)
    .order('round_number', { ascending: true });

  if (error) {
    console.error('[pivot-loop] Failed to get round summary:', error);
    return null;
  }

  let totalArtifacts = 0;
  let totalTools = 0;

  for (const round of rounds || []) {
    const results = round.execution_results || [];
    totalTools += results.length;
    for (const result of results) {
      if (result.artifact_ids_created) {
        totalArtifacts += result.artifact_ids_created.length;
      }
    }
  }

  return {
    total_rounds: (rounds || []).length,
    completed_rounds: ((rounds || []) as PivotRound[]).filter(r => r.round_complete).length,
    total_artifacts_created: totalArtifacts,
    total_tools_executed: totalTools,
  };
}
