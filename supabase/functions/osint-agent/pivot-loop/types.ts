/**
 * Edge function types for pivot loop
 *
 * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for pivot loop types.
 * Frontend (src/types/pivot-loop.ts) is generated from this file via:
 *   npm run build:generate-types
 *
 * DO NOT manually edit src/types/pivot-loop.ts — it will be overwritten.
 * ALL type changes must be made here first, then regenerated.
 */

export type PivotDecision =
  | 'PROCEED'
  | 'HOLD_FOR_CORROBORATION'
  | 'DEFER'
  | 'EXCLUDE_COLLISION'
  | 'EXCLUDE_NOISE'
  | 'EXCLUDE_SAFETY'
  | 'EXCLUDE_QUERIED';

export interface PivotCandidate {
  id: string;
  tool_name: string;
  selector: string;
  objective: string;
  rationale: string;
  information_gain: number;
  source_independence: number;
  collision_risk: number;
  cost_estimate: number;
  latency_estimate_ms?: number;
  parent_artifact_id?: string;
  parent_selector?: string;
  parent_objective?: string;
  created_at: string;
  rank?: number;
}

export interface PivotPlanItem {
  candidate: PivotCandidate;
  decision: PivotDecision;
  decision_rationale: string;
  gate_applied?: string;
  score?: number;
}

export interface PivotPlan {
  round_id: string;
  seed_artifact_id?: string;
  created_at: string;
  candidates: PivotCandidate[];
  plan_items: PivotPlanItem[];
  proceed_count: number;
  hold_count: number;
  exclude_count: number;
  validated_at?: string;
  validation_errors?: string[];
}

export interface ExecutionResult {
  tool_name: string;
  selector: string;
  success: boolean;
  error_message?: string;
  artifact_ids_created: string[];
  duration_ms: number;
  created_at: string;
}

export interface IntelligenceDelta {
  round_id: string;
  new_clusters?: string[];
  merged_clusters?: { from: string[]; to: string }[];
  confidence_increases: { artifact_id: string; delta: number }[];
  confidence_decreases: { artifact_id: string; delta: number }[];
  contradictions: {
    artifact_id_1: string;
    artifact_id_2: string;
    conflict_description: string;
  }[];
  excluded_selectors: { selector: string; reason: string; tool_name: string }[];
  created_at: string;
}

export interface PivotRound {
  id: string;
  investigation_id: string;
  seed_artifact_id?: string;
  seed_reason?: string;
  plan: PivotPlan;
  execution_results: ExecutionResult[];
  execution_started_at?: string;
  execution_completed_at?: string;
  delta?: IntelligenceDelta;
  round_complete: boolean;
  final_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface GatingScoringInput {
  candidate: PivotCandidate;
  excluded_selectors: Set<string>;
  queried_selector_objectives: Map<string, Set<string>>;
  previous_collision_decisions: Map<string, boolean>;
  time_remaining_ms: number;
  active_clusters: string[][];
  active_contradictions: number;
}

export interface GatingResult {
  decision: PivotDecision;
  score: number;
  gate_applied?: string;
  rationale: string;
}
