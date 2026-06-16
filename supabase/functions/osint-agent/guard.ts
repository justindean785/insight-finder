/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 */

// ---- Concurrency-safe state storage --------------------------------------------
// These singletons were previously module-globals, which corrupted state when
// two scans overlapped on a warm isolate. We now key by threadId.

export interface ThreadGuard {
  artifactsSinceCorrelate: number;
  artifactsSincePlan: number;
  planCalledInRound: boolean;
}

const guardMap = new Map<string, ThreadGuard>();

export function getGuard(threadId: string): ThreadGuard {
  let g = guardMap.get(threadId);
  if (!g) {
    g = { artifactsSinceCorrelate: 0, artifactsSincePlan: 0, planCalledInRound: false };
    guardMap.set(threadId, g);
  }
  return g;
}

export function clearThreadState(threadId: string) {
  guardMap.delete(threadId);
  routingGuardMap.delete(threadId);
  triageStateMap.delete(threadId);
}

// ---- Routing guard: memory_recall rate limit + high-cost tool dedup ------------
export const HIGH_COST_TOOLS = new Set<string>(["oathnet_lookup", "leakcheck_lookup"]);

export interface ThreadRoutingGuard {
  artifactsTotal: number;
  memoryRecallTimestamps: number[];
  memoryRecallSubjectsThisStep: Set<string>;
  highCostLastArtifactCount: Map<string, number>;
}

const routingGuardMap = new Map<string, ThreadRoutingGuard>();

export function getRoutingGuard(threadId: string): ThreadRoutingGuard {
  let rg = routingGuardMap.get(threadId);
  if (!rg) {
    rg = {
      artifactsTotal: 0,
      memoryRecallTimestamps: [],
      memoryRecallSubjectsThisStep: new Set<string>(),
      highCostLastArtifactCount: new Map<string, number>(),
    };
    routingGuardMap.set(threadId, rg);
  }
  return rg;
}

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

const triageStateMap = new Map<string, TriageState>();

export function getTriageState(threadId: string): TriageState {
  let ts = triageStateMap.get(threadId);
  if (!ts) {
    ts = {
      ran: false,
      seed: null,
      seedType: null,
      seedDomain: null,
      cleared: new Set<string>(),
      reasons: [],
      skipped: [],
      identitySignals: { name: false, username: false },
    };
    triageStateMap.set(threadId, ts);
  }
  return ts;
}

// ---- Helper functions ----------------------------------------------------------

export function bumpArtifacts(threadId: string, n: number, kinds?: string[]) {
  if (n <= 0) return;
  const g = getGuard(threadId);
  const rg = getRoutingGuard(threadId);
  const ts = getTriageState(threadId);

  g.artifactsSinceCorrelate += n;
  g.artifactsSincePlan += n;
  g.planCalledInRound = false;
  rg.artifactsTotal += n;
  // New evidence = new reasoning step; clear per-step dedup for memory_recall.
  rg.memoryRecallSubjectsThisStep.clear();
  if (kinds) {
    if (kinds.includes("name")) ts.identitySignals.name = true;
    if (kinds.includes("username")) ts.identitySignals.username = true;
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
export function gateStage2(threadId: string, name: string): null | ReturnType<typeof skipStub> {
  const ts = getTriageState(threadId);
  // If triage never ran, do NOT gate — the seed was likely a domain/ip/phone/url
  // and the two-stage rule only applies to email/username seeds.
  if (!ts.ran) return null;
  if (!ts.cleared.has(name)) {
    const reasons = ts.skipped.find((s) => s.tool === name)?.reason
      ?? "Stage 1 produced no qualifying signal (no breach, no real gravatar, low emailrep, consumer domain).";
    return skipStub(name, `gated by triage_seed → ${reasons}`, {
      triage_ran: true,
      seed: ts.seed,
      seed_domain: ts.seedDomain,
      identity_signals: ts.identitySignals,
      cleared: [...ts.cleared],
    });
  }
  return null;
}
