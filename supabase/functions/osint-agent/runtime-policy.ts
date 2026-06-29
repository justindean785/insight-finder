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
export const MAX_CONCURRENT_CALLS = 6;
export const MAX_PAID_CALLS = 12;

// ---- Configurable runtime limits ---------------------------------------------
// Hard caps are now configurable and DEFAULT TO UNLIMITED investigation depth.
// The old constants above remain exported for other importers, but startCall
// reads `runtimeLimits.*` (which tests mutate directly). All env reads are
// guarded so this module can be imported from Node (vitest) where `Deno` does
// not exist and from Deno without --allow-env (which throws PermissionError).
function readEnv(name: string): string | undefined {
  try {
    // Access Deno.env via globalThis so the FRONTEND tsc gate (no Deno types)
    // still compiles — src/test imports this module, and a bare `Deno` reference
    // breaks the build with TS2304. Runtime behavior is unchanged (Deno provides
    // the global; Node/browser get undefined → fallback).
    const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env;
    return env?.get ? (env.get(name) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "") return fallback;
  // "unlimited" words mean exactly that — not the (possibly finite) fallback.
  if (s === "inf" || s === "infinity" || s === "infinite" || s === "unlimited" || s === "none") {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

// EXPORTED MUTABLE config — tests mutate this directly to enable caps.
export const runtimeLimits = {
  maxPaidCallsPerRun: envNumber("MAX_PAID_CALLS_PER_RUN", Number.POSITIVE_INFINITY),
  maxTotalToolCallsPerRun: envNumber("MAX_TOTAL_TOOL_CALLS_PER_RUN", Number.POSITIVE_INFINITY),
  maxParallelTools: envNumber("MAX_PARALLEL_TOOLS", MAX_CONCURRENT_CALLS),
  maxSameToolCallsPerRun: envNumber("MAX_SAME_TOOL_CALLS_PER_RUN", Number.POSITIVE_INFINITY),
  stopOnBudgetExhausted: envBool("STOP_ON_BUDGET_EXHAUSTED", false),
};

// Tools that record/persist evidence — NEVER throttled by runaway budgets, so a
// recording call can never be starved by the total/paid/same-tool caps.
export const ALWAYS_ALLOW_TOOLS = new Set<string>([
  "record_artifacts",
  "record_artifact",
  "record_evidence",
  "record_finding",
  "record_report",
  "append_evidence",
  "memory_save",
]);

// Concurrency over the parallel cap QUEUES (escalating backoff) rather than failing.
export const CONCURRENCY_BACKOFF_MS = 250;
export const MAX_CONCURRENCY_BACKOFF_MS = 5000;
// Same-tool: a HIGH runaway backstop only. Raw same-tool count must NOT be the
// thing that kills the best pivot. Beyond SAME_TOOL_SOFT_LIMIT, repeat calls are
// SPACED with an escalating cooldown (queue-like) rather than refused; the true
// ceilings are the total/paid budgets above. (Was 4 — which mislabeled
// Minimax/OATHNET reuse as a "rate limit" and diverted away from the
// highest-value tool while property/registry pivots were still pending.)
export const SAME_TOOL_SOFT_LIMIT = 6;
export const SAME_TOOL_COOLDOWN_MS = 400;
export const MAX_SAME_TOOL_CALLS = 16;
export const MIN_START_GAP_MS = envNumber("MIN_START_GAP_MS", 200);

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

  // Evidence-recording tools are NEVER blocked by the runaway budgets — recording
  // can't be starved by the total/paid/same-tool caps. Free-tier tools are NOT
  // blanket-exempt here: they skip only the PAID cap (via its own costTier guard
  // below), but stay bound by the total/same-tool runaway backstops when enabled.
  const essential = ALWAYS_ALLOW_TOOLS.has(input.toolName);

  // Internal runaway/cost backstops. These apply ONLY when budget enforcement is
  // explicitly enabled (STOP_ON_BUDGET_EXHAUSTED) AND the call is non-essential
  // AND the relevant limit is finite AND exceeded. By default everything is
  // unlimited, so none of these fires. NONE of these is a provider rate limit —
  // the reasons say so explicitly. (Concurrency is handled below as a QUEUE,
  // never allow:false.)
  const sameToolCount = state.toolCounts.get(input.toolName) ?? 0;
  if (runtimeLimits.stopOnBudgetExhausted && !essential) {
    if (Number.isFinite(runtimeLimits.maxTotalToolCallsPerRun) && state.totalCalls >= runtimeLimits.maxTotalToolCallsPerRun) {
      return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `internal run cap reached (${runtimeLimits.maxTotalToolCallsPerRun} calls this investigation) — internal throttle, not a provider limit` };
    }
    if (Number.isFinite(runtimeLimits.maxPaidCallsPerRun) && input.costTier !== "free" && state.paidCalls >= runtimeLimits.maxPaidCallsPerRun) {
      return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `internal paid-call cap reached (${runtimeLimits.maxPaidCallsPerRun} this run) — internal throttle, not a provider limit` };
    }
    if (Number.isFinite(runtimeLimits.maxSameToolCallsPerRun) && sameToolCount >= runtimeLimits.maxSameToolCallsPerRun) {
      return { allow: false, stage: state.stage, cycleId: state.cycleId, reason: `internal per-tool cap reached (${input.toolName} ran ${runtimeLimits.maxSameToolCallsPerRun}× this run) — vary the selector or choose another pivot; internal throttle, not a provider limit` };
    }
  }

  // CONCURRENCY: never refuse — QUEUE the call with an escalating backoff when it
  // would push active calls over maxParallelTools.
  let concurrencyBackoff = 0;
  if (Number.isFinite(runtimeLimits.maxParallelTools) && state.activeCalls + 1 > runtimeLimits.maxParallelTools) {
    const over = (state.activeCalls + 1) - runtimeLimits.maxParallelTools;
    concurrencyBackoff = Math.min(over * CONCURRENCY_BACKOFF_MS, MAX_CONCURRENCY_BACKOFF_MS);
  }

  // Beyond the soft limit, SPACE repeat same-tool calls (queue-like cooldown)
  // instead of refusing — a still-useful tool (Minimax/OATHNET) stays available.
  const sameToolCooldown = sameToolCount >= SAME_TOOL_SOFT_LIMIT
    ? (sameToolCount - SAME_TOOL_SOFT_LIMIT + 1) * SAME_TOOL_COOLDOWN_MS
    : 0;
  const scheduledStartAt = Math.max(now, state.lastStartAt + MIN_START_GAP_MS) + sameToolCooldown + concurrencyBackoff;
  const waitMs = Math.max(0, scheduledStartAt - now);
  state.stage = nextStageForTool(state.stage, input.toolName);
  state.totalCalls += 1;
  state.activeCalls += 1;
  if (input.costTier !== "free") state.paidCalls += 1;
  state.toolCounts.set(input.toolName, sameToolCount + 1);
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

// ---- Tool-call admission policy ----------------------------------------------
// Encodes the intended same-tool / concurrency / rate-limit semantics as a pure,
// testable decision: raw same-tool COUNT never blocks a useful tool. The only
// "rate limit" is a real provider 429/quota. Duplicate and dead query families
// are suppressed (the TOOL stays available); concurrency QUEUES rather than kills.

export const QUERY_FAMILY_NO_YIELD_LIMIT = 3;

export interface ToolCallPolicyInput {
  toolName: string;
  rawCallCount: number;                 // how many times this tool ran this run
  providerReturned429: boolean;         // a REAL provider 429/quota response
  isDuplicateQuery: boolean;            // exact-equivalent query already run
  satisfiesPendingRequiredPivot: boolean;
  queryFamilyNoYieldCount: number;      // consecutive no-new-artifact runs for this family
  inFlight: number;
  maxConcurrency: number;
  cooldownUntil?: number;               // epoch ms; set ONLY on a real provider error
  now?: number;
}

export interface ToolCallPolicyDecision {
  allowed: boolean;
  action: "run" | "queue" | "suppress" | "cooldown";
  reason: string;
}

export function shouldAllowToolCall(input: ToolCallPolicyInput): ToolCallPolicyDecision {
  const now = input.now ?? 0;
  // The ONLY condition that may be called a rate limit/quota: a real provider 429.
  if (input.providerReturned429 || (input.cooldownUntil !== undefined && input.cooldownUntil > now)) {
    return {
      allowed: false,
      action: "cooldown",
      reason: `Provider returned 429/quota for ${input.toolName}; backing off until cooldown expires.`,
    };
  }
  // Suppress the duplicate QUERY — keep the TOOL available for new pivots.
  if (input.isDuplicateQuery) {
    return {
      allowed: false,
      action: "suppress",
      reason: `Suppressed duplicate query family; keeping ${input.toolName} available for new pivots.`,
    };
  }
  // Suppress a family that keeps yielding nothing — unless it still serves a
  // pending required pivot (then keep going).
  if (input.queryFamilyNoYieldCount >= QUERY_FAMILY_NO_YIELD_LIMIT && !input.satisfiesPendingRequiredPivot) {
    return {
      allowed: false,
      action: "suppress",
      reason: `Suppressed no-yield query family for ${input.toolName}; vary the query or switch pivots.`,
    };
  }
  // Concurrency: QUEUE, do not kill the tool.
  if (input.inFlight >= input.maxConcurrency) {
    return {
      allowed: true,
      action: "queue",
      reason: `Queued ${input.toolName} to avoid parallel overload (internal concurrency, not a provider limit).`,
    };
  }
  // rawCallCount NEVER blocks a useful tool.
  return {
    allowed: true,
    action: "run",
    reason: input.satisfiesPendingRequiredPivot
      ? `Continuing ${input.toolName} because it satisfies a pending required pivot.`
      : `${input.toolName} eligible.`,
  };
}

