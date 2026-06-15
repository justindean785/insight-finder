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
  freshSeedBonus?: number;
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
  totalCalls: number;
  activeCalls: number;
  paidCalls: number;
  toolCounts: Map<string, number>;
  familyCalls: Set<string>;
  lastStartAt: number;
  findings: string[];
  plan: ExecutionCyclePlan | null;
}

const THREADS = new Map<string, RuntimeThreadState>();

// Runaway-cost backstops, enforced PER RUN (per investigation thread) — NOT per
// cycle and NOT advisory. startCall refuses once any of these is hit; that is
// the only place the runtime says "no". Everything else (which tool, in what
// order, weak-lead handling) is advisory and lives in the planner/prompt.
//
// These reset ONLY when the thread is cleared (clearRuntime → a brand-new
// investigation). beginCycle must NEVER refresh them: beginCycle runs on every
// free record_artifacts, and the old per-cycle counters let free recording
// silently hand paid-execution allowance back, defeating the budget. Counters
// are therefore lifetime-of-run.
//
// Old per-cycle values (paid=2, same-tool=1) also choked yield — the agent
// burned its cycle on 2 paid tools, hit the cap, fell back to free tools, and
// finished with 0 artifacts. As per-run backstops they are set generously so an
// investigation can pivot freely; MAX_TOTAL_CALLS is the ultimate ceiling.
// Tuned for speed + provider-rate-limit friendliness. Still fail-open: startCall
// never blocks on confirmation/EV/weak-lead — these are pure runaway/cost/rate
// backstops. Lower concurrency + a wider start gap keep bursts under common
// provider limits (e.g. stolen.tax = 2 req/s); tighter budgets stop the agent
// grinding low-value fan-out on a no-match seed.
export const MAX_TOTAL_CALLS = 30;
export const MAX_CONCURRENT_CALLS = 3;
export const MAX_PAID_CALLS = 12;
export const MAX_SAME_TOOL_CALLS = 4;
export const MIN_START_GAP_MS = 600;

function getThread(threadId: string): RuntimeThreadState {
  let state = THREADS.get(threadId);
  if (!state) {
    state = {
      stage: "TRIAGE",
      cycleId: 1,
      totalCalls: 0,
      activeCalls: 0,
      paidCalls: 0,
      toolCounts: new Map(),
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
  // NOTE: paidCalls / toolCounts are deliberately NOT reset here. They are
  // per-run runaway backstops; beginCycle fires on every free record_artifacts,
  // and resetting them would let free recording refresh paid-execution budget
  // (the reset bug). Only clearRuntime (a new investigation) zeroes them.
  // lastStartAt resets so a fresh cycle isn't penalized by the prior pacing gap.
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
    + (input.freshSeedBonus ?? 0)
    - (input.costPenalty ?? 0)
    - (input.duplicatePenalty ?? 0)
    - (input.priorFailurePenalty ?? 0)
    - (input.collisionPenalty ?? 0)
    - (input.weakLeadPenalty ?? 0)
    - (input.repeatedToolPenalty ?? 0);
  return Math.max(0, Math.min(100, Math.round(score)));
}

// NOTE: there is intentionally no expected-value threshold gate. Expected value
// is advisory — it ranks pivots (scoreExpectedValue) but never blocks a call.
// Low EV → lower ranking, never allow:false. (Removed requiredThreshold.)

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
  ensureCycle(threadId);
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

  if (state.totalCalls >= MAX_TOTAL_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `call budget exhausted (${MAX_TOTAL_CALLS})` };
  }
  if (state.activeCalls >= MAX_CONCURRENT_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `active-call concurrency limit reached (${MAX_CONCURRENT_CALLS})` };
  }
  if (input.costTier !== "free" && state.paidCalls >= MAX_PAID_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `paid-call budget exhausted (${MAX_PAID_CALLS} per run)` };
  }
  if ((state.toolCounts.get(input.toolName) ?? 0) >= MAX_SAME_TOOL_CALLS) {
    return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `same-tool budget exhausted (${MAX_SAME_TOOL_CALLS} per run)` };
  }
  const scheduledStartAt = Math.max(now, state.lastStartAt + MIN_START_GAP_MS);
  const waitMs = Math.max(0, scheduledStartAt - now);
  state.stage = nextStageForTool(state.stage, input.toolName);
  state.totalCalls += 1;
  state.activeCalls += 1;
  if (input.costTier !== "free") state.paidCalls += 1;
  state.toolCounts.set(input.toolName, (state.toolCounts.get(input.toolName) ?? 0) + 1);
  state.familyCalls.add(input.familyKey);
  state.lastStartAt = scheduledStartAt;
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
