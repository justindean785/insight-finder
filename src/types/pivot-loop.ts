/**
 * Structured Pivot Loop Types
 *
 * GENERATED FILE: Do not edit directly. This is generated from:
 *   supabase/functions/osint-agent/pivot-loop/types.ts
 *
 * To update types, edit the edge function types.ts file and run:
 *   npm run build:generate-types
 *
 * This ensures frontend and backend types stay in sync.
 *
 * Schema definitions for the PLAN → GATE → EXECUTE → CORROBORATE → PRUNE → NEXT PIVOT
 * investigation loop. This feature is feature-flagged (STRUCTURED_PIVOT_LOOP=false by default).
 */

/**
 * PivotDecision: The outcome of gating a candidate pivot
 */
export type PivotDecision =
  | 'PROCEED'
  | 'HOLD_FOR_CORROBORATION'
  | 'DEFER'
  | 'EXCLUDE_COLLISION'
  | 'EXCLUDE_NOISE'
  | 'EXCLUDE_SAFETY'
  | 'EXCLUDE_QUERIED';

/**
 * PivotCandidate: A proposed next investigation point
 */
export interface PivotCandidate {
  id: string;
  tool_name: string;
  selector: string;
  objective: string;
  rationale: string;

  // Scoring factors
  information_gain: number; // 0-1: estimated novelty/utility
  source_independence: number; // 0-1: how independent from prior findings
  collision_risk: number; // 0-1: risk of collision with known identities
  cost_estimate: number; // relative cost (1 = baseline)
  latency_estimate_ms?: number;

  // Parent context
  parent_artifact_id?: string;
  parent_selector?: string;
  parent_objective?: string;

  // Metadata
  created_at: string;
  rank?: number; // rank within the plan
}

/**
 * PivotPlanItem: A candidate with its decision and reasoning
 */
export interface PivotPlanItem {
  candidate: PivotCandidate;
  decision: PivotDecision;
  decision_rationale: string; // why PROCEED vs HOLD vs EXCLUDE
  gate_applied?: string; // which gate rule rejected it (e.g., "EXCLUDE_QUERIED")
  score?: number; // composite score before gating
}

/**
 * PivotPlan: The pre-flight plan for a round
 */
export interface PivotPlan {
  round_id: string;
  seed_artifact_id?: string;
  created_at: string;

  candidates: PivotCandidate[];
  plan_items: PivotPlanItem[];

  // Aggregate stats
  proceed_count: number;
  hold_count: number;
  exclude_count: number;

  // Validation state
  validated_at?: string;
  validation_errors?: string[];
}

/**
 * ArtifactMetadataExtension: Additional fields on artifact.metadata
 * (backwards compatible, optional fields)
 */
export interface ArtifactMetadataExtension {
  pivot_round_id?: string; // round that discovered this artifact
  parent_artifact_ids?: string[]; // chain of custody
  parent_selector?: string;
  parent_objective?: string;
  decision_rationale?: string; // why this tool was selected
  source_class?: string; // 'primary' | 'secondary' | 'corroborating'
}

/**
 * ExecutionResult: Outcome of executing a single tool
 */
export interface ExecutionResult {
  tool_name: string;
  selector: string;
  success: boolean;
  error_message?: string;
  artifact_ids_created: string[];
  duration_ms: number;
  created_at: string;
}

/**
 * IntelligenceDelta: Changes after a round
 */
export interface IntelligenceDelta {
  round_id: string;

  // Cluster changes
  new_clusters?: string[]; // newly linked identities
  merged_clusters?: { from: string[]; to: string }[];

  // Confidence updates
  confidence_increases: { artifact_id: string; delta: number }[];
  confidence_decreases: { artifact_id: string; delta: number }[];

  // Contradictions discovered
  contradictions: {
    artifact_id_1: string;
    artifact_id_2: string;
    conflict_description: string;
  }[];

  // Excluded selectors (for retry prevention)
  excluded_selectors: { selector: string; reason: string; tool_name: string }[];

  created_at: string;
}

/**
 * PivotRound: Complete round state (plan + execution + delta)
 */
export interface PivotRound {
  id: string;
  investigation_id: string;

  // Seed
  seed_artifact_id?: string;
  seed_reason?: string;

  // Planning phase
  plan: PivotPlan;

  // Execution phase
  execution_results: ExecutionResult[];
  execution_started_at?: string;
  execution_completed_at?: string;

  // Intelligence phase
  delta?: IntelligenceDelta;

  // Round completion
  round_complete: boolean;
  final_reason?: string; // why loop continued or stopped

  created_at: string;
  updated_at: string;
}

/**
 * StructuredLoopState: Stateful tracking across rounds
 */
export interface StructuredLoopState {
  investigation_id: string;

  // Current round
  active_round_id?: string;
  round_number: number;

  // History
  completed_rounds: string[]; // round IDs

  // Excluded selectors (survives crashes)
  excluded_selectors: Set<string>;

  // Metrics
  total_artifacts_created: number;
  total_tools_called: number;

  created_at: string;
  last_updated: string;
}

/**
 * GatingScoringInput: Parameters for pivot scoring and gating
 */
export interface GatingScoringInput {
  candidate: PivotCandidate;
  excluded_selectors: Set<string>;
  queried_selector_objectives: Map<string, Set<string>>; // tool+selector → objectives tried
  previous_collision_decisions: Map<string, boolean>; // selector → is_collision
  time_remaining_ms: number;

  // Current intelligence state
  active_clusters: string[][];
  active_contradictions: number;
}

/**
 * GatingResult: Output of gating logic
 */
export interface GatingResult {
  decision: PivotDecision;
  score: number;
  gate_applied?: string;
  rationale: string;
}
