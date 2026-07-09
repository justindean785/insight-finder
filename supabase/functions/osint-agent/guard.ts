/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 * Extracted from index.ts (lines 1656–1750).
 */

// ---- Per-investigation guard state ---------------------------------------------
// - artifactsSinceCorrelate: new artifacts recorded since last successful minimax_correlate
// - lastCorrelateOutcome: outcome of the MOST RECENT minimax_correlate call this run —
//   "ok" | "failed" | null (never called). Set by cache.ts's tool wrapper from the
//   FINAL result actually returned to the model (so a timeout-stub result counts as
//   "failed" even though the tool's own execute() never saw the timeout — it raced
//   against the per-tool cap and lost). Read by C-2 (lib/memory_consolidate.ts via the
//   memory_save tool) so a correlation failure downgrades any cross-selector claim to
//   "unresolved" instead of letting it save as a confident merged identity (audit
//   e29aa8c9: correlate timed out at 12,143ms, and the very next memory_save wrote a
//   98-confidence merge across two different people).
export const guard = {
  artifactsSinceCorrelate: 0,
  lastCorrelateOutcome: null as "ok" | "failed" | null,
};

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
