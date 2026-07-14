/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 * Extracted from index.ts (lines 1656–1750).
 *
 * Finding #8: this state used to be a set of mutable MODULE-LEVEL singletons
 * (`export const guard/routingGuard/triageState = {...}`), reset by the request
 * handler at the top of each call. On a warm Deno edge isolate serving
 * concurrent/interleaved requests, that reset (and every subsequent read/write)
 * raced across requests — one investigation's seed, triage decisions, or
 * correlate-nudge counter could bleed into another's. `createRequestState()`
 * below returns a FRESH, request-scoped object; the request handler creates one
 * per call and threads it explicitly through ToolContext / the cache wrapper —
 * nothing here is module-level mutable state anymore.
 */

// ---- Per-investigation guard state (now request-scoped — see RequestState) -----
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
export interface GuardState {
  artifactsSinceCorrelate: number;
  lastCorrelateOutcome: "ok" | "failed" | null;
}

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
 * minimax_correlate to justify a re-correlation pass. Pure — reads the given
 * request-scoped guard state. */
export function correlateDue(g: GuardState): boolean {
  return g.artifactsSinceCorrelate >= CORRELATE_ARTIFACT_THRESHOLD;
}

/** Nudge surfaced in a record_artifacts result when a correlate pass is due. Returns
 * {} when not due, so it can be spread directly into the tool result (mirrors the
 * memory_hint pattern). */
export function correlateNudge(g: GuardState): Record<string, unknown> {
  if (!correlateDue(g)) return {};
  return {
    correlate_hint:
      `${g.artifactsSinceCorrelate} new artifacts have accrued since the last correlation pass. ` +
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
export interface RoutingGuardState {
  artifactsTotal: number;
  memoryRecallTimestamps: number[];
  memoryRecallSubjectsThisStep: Set<string>;
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

/** Fresh, request-scoped state bundle. The request handler creates ONE of these
 *  per request (Deno.serve callback) and threads it explicitly through
 *  ToolContext / the cache wrapper — never stored at module scope, so
 *  concurrent/interleaved requests on a warm isolate can never observe or
 *  mutate each other's guard/routing/triage state (finding #8). */
export interface RequestState {
  guard: GuardState;
  routingGuard: RoutingGuardState;
  triageState: TriageState;
}

export function createRequestState(): RequestState {
  return {
    guard: { artifactsSinceCorrelate: 0, lastCorrelateOutcome: null },
    routingGuard: { artifactsTotal: 0, memoryRecallTimestamps: [], memoryRecallSubjectsThisStep: new Set<string>() },
    triageState: {
      ran: false,
      seed: null,
      seedType: null,
      seedDomain: null,
      cleared: new Set<string>(),
      reasons: [],
      skipped: [],
      identitySignals: { name: false, username: false },
    },
  };
}

// ---- Helper functions ----------------------------------------------------------

export function bumpArtifacts(state: RequestState, n: number, kinds?: string[]) {
  if (n <= 0) return;
  state.guard.artifactsSinceCorrelate += n;
  state.routingGuard.artifactsTotal += n;
  // New evidence = new reasoning step; clear per-step dedup for memory_recall.
  state.routingGuard.memoryRecallSubjectsThisStep.clear();
  if (kinds) {
    if (kinds.includes("name")) state.triageState.identitySignals.name = true;
    if (kinds.includes("username")) state.triageState.identitySignals.username = true;
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
