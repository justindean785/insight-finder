export type InvestigationStage =
  | "TRIAGE"
  | "REVIEW"
  | "TARGETED_PIVOT"
  | "VERIFY"
  | "REPORT";

export type ToolCostTier = "free" | "low" | "expensive";

export interface SelectorEvidenceSignal {
  selector: string;
  selectorType: string;
  confidence: number | null;
  sourceCount: number;
  sourceNames: string[];
  artifactKinds: string[];
  statuses: string[];
  relatedProfile: boolean;
  aiSummaryOnly: boolean;
  usernameCollision: boolean;
  noHit: boolean;
  emptyProfile: boolean;
  sameNameWithoutOverlap: boolean;
  displayNameOnly: boolean;
}

export interface WeakLeadDecision {
  weak: boolean;
  reasons: string[];
  autoPivotBlocked: boolean;
}

export interface PlannedCall {
  tool_name: string;
  selector: string;
  selector_type: string;
  params_preview: Record<string, unknown>;
  expected_value: number;
  cost_tier: ToolCostTier;
  reason: string;
  stop_condition: string;
  cache_status: "thread" | "user" | "stale" | "miss";
}

export interface RejectedCall {
  tool_name: string;
  selector: string;
  selector_type: string;
  expected_value: number;
  reason: string;
  cost_tier: ToolCostTier;
  weak_lead: boolean;
  stale_cache: boolean;
  manual_override: boolean;
}

export interface ExecutionCyclePlan {
  stage: InvestigationStage;
  cycle_id: number;
  goal: string;
  current_findings: string[];
  proposed_calls: PlannedCall[];
  calls_rejected: RejectedCall[];
}

export interface ExpectedValueInput {
  selectorConfidence: number | null;
  sourceIndependenceBonus?: number;
  corroborationPotential?: number;
  freshnessNeed?: number;
  costPenalty?: number;
  duplicatePenalty?: number;
  priorFailurePenalty?: number;
  collisionPenalty?: number;
  weakLeadPenalty?: number;
  repeatedToolPenalty?: number;
}

export interface RuntimeDecisionInput {
  threadId: string;
  toolName: string;
  selector: string;
  selectorType: string;
  costTier: ToolCostTier;
  expectedValue: number;
  familyKey: string;
  now?: number;
  weakLead: WeakLeadDecision;
  staleCache: boolean;
  manualOverride?: boolean;
  force?: boolean;
}

export type RuntimeDecision =
  | { allow: true; stage: InvestigationStage; cycleId: number; waitMs: number }
  | { allow: false; stage: InvestigationStage; cycleId: number; reason: string };

interface RuntimeThreadState {
  stage: InvestigationStage;
  cycleId: number;
  planRequired: boolean;
  totalCalls: number;
  activeCalls: number;
  cyclePaidCalls: number;
  cycleToolCounts: Map<string, number>;
  familyCalls: Set<string>;
  lastStartAt: number;
  findings: string[];
  plan: ExecutionCyclePlan | null;
}

const THREADS = new Map<string, RuntimeThreadState>();

const ALWAYS_ALLOWED_BEFORE_PLAN = new Set([
  "list_tools",
  "triage_seed",
  "memory_recall",
  "minimax_plan_pivots",
  "coverage_audit",
  "detect_contradictions",
  "tool_audit",
  "record_artifacts",
  "record_artifact",
  "record_finding",
  "memory_save",
]);

export const MAX_TOTAL_CALLS = 35;
export const MAX_CONCURRENT_CALLS = 3;
export const MAX_PAID_CALLS_PER_CYCLE = 2;
export const MAX_SAME_TOOL_CALLS_PER_CYCLE = 1;
export const MIN_START_GAP_MS = 750;

function getThread(threadId: string): RuntimeThreadState {
  let state = THREADS.get(threadId);
  if (!state) {
    state = {
      stage: "TRIAGE",
      cycleId: 1,
      planRequired: true,
      totalCalls: 0,
      activeCalls: 0,
      cyclePaidCalls: 0,
      cycleToolCounts: new Map(),
      familyCalls: new Set(),
      lastStartAt: 0,
      findings: [],
      plan: null,
    };
    THREADS.set(threadId, state);
  }
  return state;
}

export function clearRuntime(threadId: string): void {
  THREADS.delete(threadId);
}

export function beginCycle(threadId: string, goal = "Review current evidence and select the next highest-value pivots", findings: string[] = []): ExecutionCyclePlan {
  const state = getThread(threadId);
  state.cycleId += state.plan ? 1 : 0;
  state.planRequired = true;
  state.cyclePaidCalls = 0;
  state.cycleToolCounts = new Map();
  state.lastStartAt = 0;
  state.findings = findings;
  state.plan = {
    stage: state.stage,
    cycle_id: state.cycleId,
    goal,
    current_findings: findings,
    proposed_calls: [],
    calls_rejected: [],
  };
  return state.plan;
}

export function ensureCycle(threadId: string): ExecutionCyclePlan {
  const state = getThread(threadId);
  if (!state.plan) {
    return beginCycle(threadId);
  }
  return state.plan;
}

export function currentStage(threadId: string): InvestigationStage {
  return getThread(threadId).stage;
}

export function scoreExpectedValue(input: ExpectedValueInput): number {
  const confidenceBase = input.selectorConfidence ?? 45;
  const score = confidenceBase
    + (input.sourceIndependenceBonus ?? 0)
    + (input.corroborationPotential ?? 0)
    + (input.freshnessNeed ?? 0)
    - (input.costPenalty ?? 0)
    - (input.duplicatePenalty ?? 0)
    - (input.priorFailurePenalty ?? 0)
    - (input.collisionPenalty ?? 0)
    - (input.weakLeadPenalty ?? 0)
    - (input.repeatedToolPenalty ?? 0);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function requiredThreshold(costTier: ToolCostTier, repeatedToolFamily = false): number {
  if (repeatedToolFamily) return 80;
  if (costTier === "free") return 35;
  if (costTier === "low") return 50;
  return 70;
}

export function analyzeWeakLead(signal: SelectorEvidenceSignal): WeakLeadDecision {
  const reasons: string[] = [];
  if (signal.confidence != null && signal.confidence < 50) reasons.push("confidence below 50");
  if (signal.sourceCount <= 1 && signal.sourceNames.length > 0) reasons.push("single-source lead");
  if (signal.aiSummaryOnly) reasons.push("AI-summary-only lead");
  if (signal.relatedProfile) reasons.push("related_profile artifact");
  if (signal.displayNameOnly) reasons.push("display name is only an identity clue");
  if (signal.usernameCollision) reasons.push("username collision");
  if (signal.noHit) reasons.push("no-hit breach result");
  if (signal.emptyProfile) reasons.push("empty or private profile");
  if (signal.sameNameWithoutOverlap) reasons.push("same-name candidate without direct selector overlap");
  return {
    weak: reasons.length > 0,
    reasons,
    autoPivotBlocked: reasons.length > 0,
  };
}

export function notePlanCall(threadId: string, planned: PlannedCall): void {
  const plan = ensureCycle(threadId);
  plan.proposed_calls.push(planned);
}

export function noteRejectedCall(threadId: string, rejected: RejectedCall): void {
  const plan = ensureCycle(threadId);
  plan.calls_rejected.push(rejected);
}

export function completePlan(threadId: string): void {
  const state = getThread(threadId);
  state.planRequired = false;
}

export function recordFindingSummary(threadId: string, finding: string): void {
  const state = getThread(threadId);
  if (!finding.trim()) return;
  state.findings = [...state.findings, finding].slice(-12);
  ensureCycle(threadId).current_findings = state.findings;
}

function nextStageForTool(current: InvestigationStage, toolName: string): InvestigationStage {
  if (toolName === "triage_seed" || toolName === "list_tools" || toolName === "memory_recall") return "REVIEW";
  if (toolName === "coverage_audit" || toolName === "detect_contradictions" || toolName === "tool_audit") return "VERIFY";
  if (toolName === "record_finding" || toolName === "memory_save") return "REPORT";
  if (current === "TRIAGE") return "REVIEW";
  if (current === "REVIEW") return "TARGETED_PIVOT";
  return current;
}

export function startCall(input: RuntimeDecisionInput): RuntimeDecision {
  const state = getThread(input.threadId);
  const now = input.now ?? Date.now();
  const repeatedFamily = state.familyCalls.has(input.familyKey);
  const threshold = requiredThreshold(input.costTier, repeatedFamily);

  if (input.weakLead.autoPivotBlocked && !input.manualOverride) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `weak lead blocked: ${input.weakLead.reasons.join("; ")}` };
  }
  if (state.planRequired && !ALWAYS_ALLOWED_BEFORE_PLAN.has(input.toolName)) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: "execution plan required for this cycle" };
  }
  if (state.totalCalls >= MAX_TOTAL_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `call budget exhausted (${MAX_TOTAL_CALLS})` };
  }
  if (state.activeCalls >= MAX_CONCURRENT_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `active-call concurrency limit reached (${MAX_CONCURRENT_CALLS})` };
  }
  if (input.costTier !== "free" && state.cyclePaidCalls >= MAX_PAID_CALLS_PER_CYCLE) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `paid-call cycle limit reached (${MAX_PAID_CALLS_PER_CYCLE})` };
  }
  if ((state.cycleToolCounts.get(input.toolName) ?? 0) >= MAX_SAME_TOOL_CALLS_PER_CYCLE) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `same-tool cycle limit reached (${MAX_SAME_TOOL_CALLS_PER_CYCLE})` };
  }
  // The expected-value gate suppresses low-value EXTERNAL evidence-gathering
  // pivots. It must NOT block the agent's own orchestration tools (planning,
  // memory recall, recording, auditing, triage) — those are bookkeeping, not
  // data-source spend, and they carry their own rate limits (e.g. memory_recall's
  // 30s window, the planner's once-per-round guard, the same-tool-per-cycle cap).
  // Without this exemption the planner (minimax_plan_pivots, "expensive" tier →
  // threshold 70) can never clear the gate on a bare seed, planRequired never
  // clears, every other tool is blocked by "execution plan required", and the
  // investigation deadlocks into a retry loop and FAILS.
  if (
    !ALWAYS_ALLOWED_BEFORE_PLAN.has(input.toolName) &&
    input.expectedValue < threshold &&
    !(input.staleCache && input.manualOverride)
  ) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `expected value ${input.expectedValue} below ${threshold}` };
  }

  const scheduledStartAt = Math.max(now, state.lastStartAt + MIN_START_GAP_MS);
  const waitMs = Math.max(0, scheduledStartAt - now);
  state.stage = nextStageForTool(state.stage, input.toolName);
  state.totalCalls += 1;
  state.activeCalls += 1;
  if (input.costTier !== "free") state.cyclePaidCalls += 1;
  state.cycleToolCounts.set(input.toolName, (state.cycleToolCounts.get(input.toolName) ?? 0) + 1);
  state.familyCalls.add(input.familyKey);
  state.lastStartAt = scheduledStartAt;
  if (input.toolName === "minimax_plan_pivots") state.planRequired = false;
  return { allow: true, stage: state.stage, cycleId: state.cycleId, waitMs };
}

export function finishCall(threadId: string, toolName: string): void {
  const state = getThread(threadId);
  state.activeCalls = Math.max(0, state.activeCalls - 1);
  if (toolName === "coverage_audit" || toolName === "detect_contradictions" || toolName === "tool_audit") {
    state.stage = "VERIFY";
  } else if (toolName === "record_finding" || toolName === "memory_save") {
    state.stage = "REPORT";
  }
}
