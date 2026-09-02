/**
 * guard.ts — Per-investigation guard state for rate-limiting reasoning tools,
 * routing guards, and Stage-2 fan-out triage gating.
 * Extracted from index.ts (lines 1656–1750).
 */
import { UNKNOWN_TOOL_SINK } from "./unknown-tool-guard.ts";

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
  /** Has the correlate hint been surfaced during THIS correlate cycle? The hint is
   *  a directive, not a running commentary: once delivered it stays quiet until a
   *  correlate pass resets the cycle, so it cannot ride on every subsequent tool
   *  result and inflate the carried context. */
  correlateHintDelivered: false,
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

/**
 * Count AUTO-PERSISTED artifacts toward the correlate trigger.
 *
 * THE BUG THIS CLOSES. `bumpArtifacts` was reachable only from the
 * `record_artifacts` family and attachment intake. Auto-persist — the backstop that
 * writes rows when the model does not record any — never touched the counter. On a
 * run where the model calls `record_artifacts` zero times (measured in production:
 * thread c65e555b, 34 auto-persisted artifacts, `record_artifact_calls: 0`)
 * `artifactsSinceCorrelate` stayed at 0 for the whole investigation. `correlateDue()`
 * was never true, `correlateNudge()` returned `{}` on every call, and the orchestrator
 * was never told to correlate. The run reached the finalize window with the counter
 * still reading zero and the late correlate attempt was skipped by the window guard.
 *
 * That is why this reads as "correlate never runs, the finalize window eats it". The
 * window guard is real, but it is the SECOND event. The first is that the trigger
 * could not see the artifacts that already existed.
 *
 * WHY AUTO-PERSISTED ROWS COUNT THE SAME. They are real persisted artifacts on the
 * thread and are precisely the population a correlation pass exists to cluster, dedup
 * and rescore. A trigger that ignores them is measuring the model's bookkeeping habits
 * rather than the investigation's progress.
 *
 * Pure apart from the counter it increments; adds no DB read (`inserted` and `rows`
 * are already computed by the caller). Returns the number counted so the caller can
 * log it. Does NOT decide whether correlate runs — `correlateDue` still owns the
 * threshold, and nothing here touches the finalize window or the completion contract.
 */
export function bumpAutoPersistedArtifacts(
  res: { inserted?: number; rows?: Array<Record<string, unknown>> } | null | undefined,
): number {
  const inserted = typeof res?.inserted === "number" && Number.isFinite(res.inserted)
    ? Math.max(0, Math.trunc(res.inserted))
    : 0;
  if (inserted <= 0) return 0;
  const kinds = Array.isArray(res?.rows)
    ? res.rows.map((r) => String((r as { kind?: unknown })?.kind ?? "unknown"))
    : [];
  bumpArtifacts(inserted, kinds);
  return inserted;
}

/** Nudge surfaced in a record_artifacts result when a correlate pass is due. Returns
 * {} when not due, so it can be spread directly into the tool result (mirrors the
 * memory_hint pattern). */
/**
 * Reset the correlate cycle — counter AND the once-per-cycle hint latch.
 *
 * Both callers previously assigned `artifactsSinceCorrelate = 0` directly (run
 * start in index.ts, and minimax_correlate's own success path). With a latch in
 * play those two must move together: resetting the counter without clearing the
 * latch would silence the hint for the rest of the run after the first pass.
 */
export function resetCorrelateCycle() {
  guard.artifactsSinceCorrelate = 0;
  guard.correlateHintDelivered = false;
}

/**
 * Take the correlate hint for delivery on a tool result the model will actually
 * READ during fan-out — at most once per correlate cycle.
 *
 * WHY THIS EXISTS. `correlateNudge()` is surfaced only inside a `record_artifacts`
 * result. Measured on build 3d5130e (thread 15ebf7d4): the model called
 * `record_artifacts` exactly ONCE, as call 22 of 23, immediately before
 * `memory_save` ended the run. By then 25 artifacts had persisted and the pass was
 * genuinely due — so the hint fired correctly and arrived with no fan-out left to
 * influence and no step left to act in. A correct trigger delivered through a
 * channel the model opens only at the end is not a trigger.
 *
 * So the hint also rides the ordinary tool results the model reads mid-run. The
 * latch keeps it a single directive per cycle rather than a banner on every
 * payload.
 *
 * Returns `{}` when not due or already delivered, so it spreads inertly.
 */
export function takeCorrelateHint(): Record<string, unknown> {
  if (guard.correlateHintDelivered) return {};
  const nudge = correlateNudge();
  if (Object.keys(nudge).length === 0) return {};
  guard.correlateHintDelivered = true;
  return nudge;
}

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

/**
 * Count the DISTINCT tool calls and record_artifacts calls a run has accumulated,
 * across the AI-SDK *model-message* history (`ModelMessage[]`) the orchestrator loop
 * sees in `prepareStep`. A tool invocation there is a `content` part of type
 * `tool-call` with a `toolName` + `toolCallId` — distinct from the UI-message shape
 * (`tool-<name>` parts) that `countRecordArtifactCalls` above reads.
 *
 * Guarantees (so the first-pass persistence nudge can't be tripped by phantoms):
 *  - CUMULATIVE PER REQUEST: it counts over the whole message array passed in, i.e.
 *    this request's conversation so far. It reads only its argument — no shared state
 *    — so counts are request-scoped by construction and never bleed across requests.
 *  - NO DOUBLE COUNTING: each call is keyed by `toolCallId`, so a call echoed across
 *    messages (or paired with its later tool-result) is counted exactly once. (A
 *    tool-RESULT part is never counted — only the `tool-call`.)
 *  - REPAIRED / NON-EXECUTED CALLS EXCLUDED: a hallucinated tool name redirected to
 *    the `UNKNOWN_TOOL_SINK` by the unknown-tool guard never ran, so it is not fan-out
 *    and does not count toward the threshold.
 * Pure + dependency-light so the nudge is unit-testable. */
export function countModelMessageToolCalls(
  messages: Array<{ content?: unknown }>,
): { toolCalls: number; recordCalls: number } {
  const seen = new Set<string>();
  let toolCalls = 0;
  let recordCalls = 0;
  let synthetic = 0;
  for (const m of messages ?? []) {
    const content = (m as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolName?: string; toolCallId?: string };
      if (p?.type !== "tool-call") continue;
      // Repaired hallucinations never execute — not real fan-out, skip them.
      if (p.toolName === UNKNOWN_TOOL_SINK) continue;
      // Dedupe by toolCallId; fall back to a per-part synthetic key when absent so a
      // missing id degrades to count-once rather than crashing the Set.
      const key = p.toolCallId ?? `__noid_${synthetic++}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toolCalls++;
      if (p.toolName === "record_artifacts" || p.toolName === "record_artifact") recordCalls++;
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
    // A guard gate returns BEFORE the tool contacts its provider, so no request
    // was issued and nothing can have been billed. This marker is what releases
    // the reserved paid-call slot (runtime-policy.ts:isPreProviderGate) — without
    // it a guard-blocked expensive tool silently spends one of the run's paid
    // slots on work that never happened.
    provider_attempted: false,
    reason: "skipped: guard not met",
    tool,
    detail: reason,
    guard_state: state,
  };
}
