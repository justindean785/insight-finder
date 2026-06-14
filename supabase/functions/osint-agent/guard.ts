/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 * Extracted from index.ts (lines 1656–1750).
 */

// ---- Per-investigation guard state ---------------------------------------------
// - artifactsSinceCorrelate: new artifacts recorded since last successful minimax_correlate
// - artifactsSincePlan:      new artifacts recorded since last successful minimax_plan_pivots
// - planCalledInRound:       true after plan_pivots runs; reset when ANY new artifact is recorded
//                            (a fresh artifact = a new round opportunity)
// - nullRoundReplans:        consecutive plan calls that produced zero new artifacts;
//                            allows up to 2 null-round re-plans before hard-blocking
export const guard = {
  artifactsSinceCorrelate: 0,
  artifactsSincePlan: 0,
  planCalledInRound: false,
  nullRoundReplans: 0,
};

// ---- Routing guard: memory_recall rate limit + high-cost tool dedup ------------
// memory_recall: max 2 calls per 30s window across the run, and never
//                repeat the same normalized subject in a single reasoning
//                step (cleared whenever a new artifact lands).
// high-cost tools (oathnet_lookup, leakcheck_lookup): one call per seed
//                unless ≥5 new artifacts have appeared since the last call
//                (proxy for "new corroborating evidence").
export const HIGH_COST_TOOLS = new Set<string>(["oathnet_lookup", "leakcheck_lookup"]);

export const routingGuard = {
  artifactsTotal: 0,
  memoryRecallTimestamps: [] as number[],
  memoryRecallSubjectsThisStep: new Set<string>(),
  highCostLastArtifactCount: new Map<string, number>(),
};

// ---- Two-stage fan-out triage state (email/username seeds) ---------------------
export const CONSUMER_DOMAINS = new Set<string>([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me",
  "aol.com", "gmx.com", "gmx.de", "mail.com", "zoho.com", "yandex.com",
  "fastmail.com", "tutanota.com", "tuta.io",
]);

export const STAGE2_TOOLS = new Set<string>([
  "intelbase_email_lookup",
  "oathnet_lookup",
  "github_code_search",
  "google_dorks",
  "minimax_web_search",
  "urlscan_search",
]);

export interface TriageState {
  ran: boolean;
  seed: string | null;
  seedType: "email" | "username" | null;
  seedDomain: string | null;
  cleared: Set<string>;      // stage 2 tools allowed
  reasons: string[];         // why stage 2 was gated open
  skipped: Array<{ tool: string; reason: string }>;
  identitySignals: { name: boolean; username: boolean };
}

export const triageState: TriageState = {
  ran: false,
  seed: null,
  seedType: null,
  seedDomain: null,
  cleared: new Set<string>(),
  reasons: [],
  skipped: [],
  identitySignals: { name: false, username: false },
};

// ---- Helper functions ----------------------------------------------------------

export function bumpArtifacts(n: number, kinds?: string[]) {
  if (n <= 0) return;
  guard.artifactsSinceCorrelate += n;
  guard.artifactsSincePlan += n;
  guard.planCalledInRound = false;
  guard.nullRoundReplans = 0;
  routingGuard.artifactsTotal += n;
  // New evidence = new reasoning step; clear per-step dedup for memory_recall.
  routingGuard.memoryRecallSubjectsThisStep.clear();
  if (kinds) {
    if (kinds.includes("name")) triageState.identitySignals.name = true;
    if (kinds.includes("username")) triageState.identitySignals.username = true;
  }
}

export function skipStub(tool: string, reason: string, state: Record<string, unknown>) {
  return {
    ok: false,
    skipped: true,
    reason: "skipped: guard not met",
    tool,
    detail: reason,
    guard_state: state,
  };
}

// Returns null when the Stage 2 tool is allowed to run, or a skip-stub when it must be blocked.
export function gateStage2(name: string): null | ReturnType<typeof skipStub> {
  // If triage never ran, do NOT gate — the seed was likely a domain/ip/phone/url
  // and the two-stage rule only applies to email/username seeds.
  if (!triageState.ran) return null;
  if (!triageState.cleared.has(name)) {
    const reasons = triageState.skipped.find((s) => s.tool === name)?.reason
      ?? "Stage 1 produced no qualifying signal (no breach, no real gravatar, low emailrep, consumer domain).";
    return skipStub(name, `gated by triage_seed → ${reasons}`, {
      triage_ran: true,
      seed: triageState.seed,
      seed_domain: triageState.seedDomain,
      identity_signals: triageState.identitySignals,
      cleared: [...triageState.cleared],
    });
  }
  return null;
}
