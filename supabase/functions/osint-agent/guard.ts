/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 * Extracted from index.ts (lines 1656–1750).
 */

// ---- Per-investigation guard state ---------------------------------------------
// - artifactsSinceCorrelate: new artifacts recorded since last successful minimax_correlate
export const guard = {
  artifactsSinceCorrelate: 0,
};

// ---- Correlation auto-fire (audit F1, 2026-07-08) ------------------------------
// The 2026-07-08 pipeline audit found minimax_correlate NEVER fired in the main run
// (0 calls across 230 tool calls) — leaving 73/73 artifacts with cluster_id:null and
// no dedup / contradiction / same-name-collision detection. The counter above was
// maintained but never READ. This turns it into an active trigger: once enough new
// artifacts have accrued since the last successful correlate, the recorder surfaces a
// `correlate_hint` in its result so the orchestrator clusters + rescores BEFORE it
// drifts further into fan-out. Threshold sits above the system-prompt's soft "≥3"
// floor (so we don't burn a paid smart-tier call on every tiny increment) and below the
// audit's N=15 ceiling — a batch worth correlating without over-nudging.
export const CORRELATE_ARTIFACT_THRESHOLD = 8;

/** True once enough new artifacts have accrued since the last successful
 * minimax_correlate to justify a re-correlation pass. Pure — reads guard state. */
export function correlateDue(): boolean {
  return guard.artifactsSinceCorrelate >= CORRELATE_ARTIFACT_THRESHOLD;
}

/** Nudge surfaced in a record_artifacts result when a correlate pass is due. Returns
 * {} when not due, so it can be spread directly into the tool result (mirrors the
 * memory_hint pattern). */
export function correlateNudge(): Record<string, unknown> {
  if (!correlateDue()) return {};
  return {
    correlate_hint:
      `${guard.artifactsSinceCorrelate} new artifacts have accrued since the last correlation pass. ` +
      `Call minimax_correlate now (pass the seed + the artifacts gathered so far) to cluster, dedup, ` +
      `rescore confidence, and flag same-name collisions / contradictions BEFORE continuing to fan out.`,
  };
}

/**
 * Count tool calls and record_artifacts calls across a set of UI messages, by
 * inspecting message part types. The AI SDK encodes a call to the tool
 * registered as `record_artifacts` as a part of type `tool-record_artifacts`
 * (and the singular `tool-record_artifact`); generic tool parts are
 * `tool-<name>` or `dynamic-tool`. Pure + dependency-free so the zero-artifact
 * completion safety-net is unit-testable. */
export function countRecordArtifactCalls(
  messages: Array<{ parts?: Array<{ type?: string }> }>,
): { toolCalls: number; recordCalls: number } {
  let toolCalls = 0;
  let recordCalls = 0;
  for (const m of messages ?? []) {
    for (const p of (m?.parts ?? [])) {
      const t = p?.type ?? "";
      if (t.startsWith("tool-") || t === "dynamic-tool") toolCalls++;
      if (t === "tool-record_artifacts" || t === "tool-record_artifact") recordCalls++;
    }
  }
  return { toolCalls, recordCalls };
}

// ---- Routing guard: memory_recall rate limit -----------------------------------
// memory_recall: max 2 calls per 30s window across the run, and never
//                repeat the same normalized subject in a single reasoning
//                step (cleared whenever a new artifact lands).
export const routingGuard = {
  artifactsTotal: 0,
  memoryRecallTimestamps: [] as number[],
  memoryRecallSubjectsThisStep: new Set<string>(),
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
