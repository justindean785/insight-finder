/**
 * case-snapshot.ts — ONE view of the case, shared by every surface that reports on it.
 *
 * WHY THIS EXISTS. Production (2026-09-11) showed the workspace header at
 * "Interrupted · 46 tools · $0.120" while the Overview and Tools panels on the
 * same screen said 48 calls; after completion the header moved to "Complete ·
 * 48 tools · $0.393" and the Tools tab badge stayed at 46. Every one of those
 * numbers was read by a different component, from a different query, refreshed
 * by a different trigger. Nothing on screen could tell the analyst which to
 * believe.
 *
 * This module is the PURE half of the fix: given the case's sources it builds a
 * single snapshot, and every figure the header, tab badges, Overview, Tools and
 * Report print comes out of that one object. The stateful half — loading the
 * sources, freezing publication while they reconcile, and stamping a version —
 * lives in `CaseSnapshotProvider`.
 *
 * It invents no evidence semantics. Authority tallies come from `authority.ts`,
 * readiness from `confidence-dimensions.ts`, liveness from the same heartbeat
 * bar the server uses (`stale-thread.ts`). What it adds is that they are read
 * TOGETHER, so they can no longer be read out of step.
 */
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import type { AuthorityState } from "@/lib/authority";
import type { ConfidenceProfile } from "@/lib/confidence-dimensions";
import { hasRunMarker } from "@/lib/thread-status";
import { isRunHeartbeatAlive } from "@/lib/stale-thread";

/** The `threads` columns the snapshot reads. */
export interface CaseThreadRow {
  id: string;
  seed_value: string | null;
  seed_type: string | null;
  status: string | null;
  credits_used: number | null;
  cost_micro_usd: number | null;
  /** Written by stale-run recovery. */
  recovered_at: string | null;
  /** Written by stale-run recovery, the stream-error path, or an unmet completion contract. */
  recovery_reason: string | null;
  run_started_at: string | null;
  last_heartbeat_at: string | null;
  updated_at: string | null;
}

/** The columns to SELECT for a `CaseThreadRow` — kept beside the type so they cannot drift. */
export const CASE_THREAD_COLUMNS =
  "id,seed_value,seed_type,status,credits_used,cost_micro_usd,recovered_at,recovery_reason,run_started_at,last_heartbeat_at,updated_at";

/**
 * Where the run stands. FIVE states, each a different claim:
 *
 *   draft        — a thread nobody has run yet (invariant I-1: no run marker ⇒
 *                  not an investigation, neither running nor interrupted).
 *   running      — this tab is streaming it, or the backend heartbeat is fresh.
 *   completed    — `finished` with no recovery marker: the clean-finalize path.
 *   interrupted  — did not finish normally: recovered, stream error, completion
 *                  contract unmet, or `active` with a dead heartbeat.
 *   stopped      — an analyst pressed Stop. Not a success, not a failure, and not
 *                  an interruption the system caused — so not painted as any of them.
 *
 * `stopped` used to render as a green "Complete" because the server's terminal
 * writes are guarded on `status = 'active'` and never stamp a reason on a row
 * the analyst already stopped.
 */
export type CaseRunState = "draft" | "running" | "completed" | "interrupted" | "stopped";

export const RUN_STATE_LABEL: Record<CaseRunState, string> = {
  draft: "Draft",
  running: "Running",
  completed: "Complete",
  interrupted: "Interrupted",
  stopped: "Stopped",
};

export function isTerminalRunState(state: CaseRunState): boolean {
  return state === "completed" || state === "interrupted" || state === "stopped";
}

/**
 * Derive the run state from the thread row.
 *
 * Replaces the header's old `deriveWorkspaceStatus`, which inferred liveness from
 * "a tool row landed in the last 90 seconds". `tool_usage_log` is not in the
 * realtime publication, so on a long-lived header that window was computed from
 * rows frozen at mount — a run that was plainly alive rendered "Interrupted"
 * whenever the page was opened mid-run. The backend pulses `last_heartbeat_at`
 * for the life of a run; that, not tool rows, is the liveness signal, judged by
 * the same 75s bar the server recovers on.
 */
export function deriveRunState(input: {
  thread: Pick<CaseThreadRow, "status" | "recovered_at" | "recovery_reason" | "run_started_at" | "last_heartbeat_at"> | null;
  /** This tab's own stream is open. The only signal allowed to override a terminal row:
   *  persistence can write `finished` while the final report is still flushing. */
  chatRunning: boolean;
  nowMs: number;
}): CaseRunState {
  if (input.chatRunning) return "running";
  const t = input.thread;
  if (!t) return "draft";
  const status = (t.status ?? "active").toLowerCase();
  const recovered = Boolean(t.recovered_at) || Boolean(t.recovery_reason);

  if (status === "stopped") return recovered ? "interrupted" : "stopped";
  if (status === "active") {
    // I-1 — a blank thread is born `active` from the column default.
    if (!hasRunMarker(t)) return "draft";
    return isRunHeartbeatAlive(t.last_heartbeat_at, input.nowMs) ? "running" : "interrupted";
  }
  // `finished`, legacy `completed`, and any other terminal value the backend may
  // write (status is an OPEN string — see thread-status.ts). A recovery marker,
  // or a status that names a failure, means it did not finish normally.
  if (recovered || /fail|error|abort/.test(status)) return "interrupted";
  return "completed";
}

// ── Evidence count ───────────────────────────────────────────────────────────

/**
 * The header's "N evidence" reads the chain-verified `evidence_log` total, NOT the
 * artifact count — they legitimately differ (one artifact can carry several
 * evidence rows, and the artifact list is deduped). Falls back to the artifact
 * count only while the integrity probe is still loading.
 */
export function pickEvidenceCount(
  integrity: { total: number } | null,
  artifactFallback: number,
): number {
  return integrity ? integrity.total : artifactFallback;
}

/**
 * The header's evidence summary, as a string the analyst can actually interpret.
 *
 * Production 2026-08-06: the header read "2 evidence" while the Evidence tab badge
 * on the same page read 50. Both were correct — one reads `evidence_log`, the other
 * `artifacts` — and nothing said so. The chain total is normally the LARGER number;
 * the INVERTED direction means artifacts were written with no chain-of-custody entry
 * and is surfaced explicitly. `hint` is set whenever the two counts differ, in either
 * direction, so the tooltip is never absent while there is something to explain.
 */
export function describeEvidence(
  integrity: { total: number } | null,
  artifactCount: number,
): { text: string; unledgered: number; hint: string | undefined } {
  if (!integrity) return { text: `${artifactCount} evidence`, unledgered: 0, hint: undefined };
  const unledgered = Math.max(0, artifactCount - integrity.total);
  if (unledgered === 0) {
    // Always explain the scope: "evidence" here is chain-of-custody entries across every run of the
    // case, not the artifact count the Evidence tab (deduped) or a report ("N artifacts", raw) shows.
    const hint = integrity.total > artifactCount
      ? `${integrity.total} chain-verified evidence rows across ${artifactCount} deduped artifact${artifactCount === 1 ? "" : "s"} — one artifact can carry more than one evidence-log entry.`
      : `${integrity.total} chain-verified evidence-log entries across all runs of this case. This counts custody entries, not the artifacts listed in the Evidence tab.`;
    return { text: `${integrity.total} evidence`, unledgered: 0, hint };
  }
  return {
    text: `${artifactCount} recorded · ${integrity.total} chain-verified`,
    unledgered,
    hint: `${unledgered} recorded artifact${unledgered === 1 ? " has" : "s have"} no chain-of-custody entry`,
  };
}

/** Case spend, formatted for a dense header. */
export function formatUsd(micro: number | null | undefined): string {
  const usd = Number(micro ?? 0) / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ── The snapshot ─────────────────────────────────────────────────────────────

export interface CaseIntegrity {
  ok: boolean;
  total: number;
  firstBreak: number | null;
}

export interface CaseToolFigures {
  /** Every persisted call — the one tool number every surface prints. */
  total: number;
  failed: number;
  degraded: number;
  skipped: number;
  gated: number;
  /** Genuine successes only (Health's "Succeeded"); a clean no-record is `noRecord`. */
  ok: number;
  /** Ran fine, target has no data (Health's "No record"). */
  noRecord: number;
  /** Stage of the most recent call that recorded one — "last stage with tool activity". */
  lastStage: string | null;
  lastAt: string | null;
  /** The rows behind `total`, so a list and its count are always the same version. */
  events: ToolEvent[];
  /** False when the ledger could not be read. `total` is then NOT a count of zero. */
  available: boolean;
}

export interface CaseSnapshotCore {
  threadId: string;
  /** Every source has answered at least once. Until then no figure is authoritative. */
  hydrated: boolean;
  run: {
    state: CaseRunState;
    /** The thread row's own reading, with this tab's open stream NOT allowed to
     *  override it. `state` is what the case shows; this is what the row says. A
     *  half-open stream keeps `state` at "running" for the life of the page, and
     *  the transcript needs the row's view to notice the run it is streaming has
     *  ended (see `shouldForceStreamEnd`). */
    rowState: CaseRunState;
    label: string;
    terminal: boolean;
    recoveryReason: string | null;
    recoveredAt: string | null;
    startedAt: string | null;
    heartbeatAt: string | null;
  };
  seed: { value: string | null; type: string | null };
  evidence: {
    /** Deduped artifact rows — the Evidence tab's count. */
    artifacts: number;
    /** `evidence_log` total, once the integrity probe has answered. */
    ledger: number | null;
    text: string;
    hint: string | undefined;
    unledgered: number;
    available: boolean;
  };
  tools: CaseToolFigures;
  authority: Record<AuthorityState, number>;
  /** Of `authority.verified`, how many carry the analyst's own confirm/key verdict. A
   *  verified count that is all analyst clicks reads very differently from one the
   *  evidence earned, and the header must be able to say which it is. */
  verifiedByAnalyst: number;
  spend: {
    /** `threads.cost_micro_usd`: model + tool spend, persisted in checkpoints during a run. */
    microUsd: number | null;
    text: string;
  };
  readiness: {
    pct: number;
    reportReady: boolean;
    profile: ConfidenceProfile;
  } | null;
  integrity: CaseIntegrity | null;
  /** The artifact rows behind `evidence.artifacts` — same version as every count. */
  items: Artifact[];
  updatedAt: string | null;
}

export interface CaseSnapshotInput {
  threadId: string;
  /** Auth has resolved. A snapshot built before it is never hydrated. */
  accountReady: boolean;
  thread: CaseThreadRow | null;
  threadLoaded: boolean;
  artifacts: { items: Artifact[]; loading: boolean; error: boolean };
  tools: {
    events: ToolEvent[];
    persistedTotal: number;
    failed: number;
    degraded: number;
    skipped: number;
    gated: number;
    ok: number;
    /** Optional so older callers compile; absent reads as 0. */
    noRecord?: number;
    loading: boolean;
    error: boolean;
    loadedAt: number | null;
  };
  authority: Record<AuthorityState, number>;
  /** Optional so older callers compile; absent reads as 0. */
  verifiedByAnalyst?: number;
  integrity: CaseIntegrity | null;
  readiness: ConfidenceProfile | null;
  chatRunning: boolean;
  nowMs: number;
}

export function buildCaseSnapshot(input: CaseSnapshotInput): CaseSnapshotCore {
  const state = deriveRunState({ thread: input.thread, chatRunning: input.chatRunning, nowMs: input.nowMs });
  const rowState = input.chatRunning ? deriveRunState({ thread: input.thread, chatRunning: false, nowMs: input.nowMs }) : state;
  const artifactCount = input.artifacts.items.length;
  const ev = describeEvidence(input.integrity, artifactCount);

  let lastStage: string | null = null;
  let lastAt: string | null = null;
  for (let i = input.tools.events.length - 1; i >= 0; i--) {
    const e = input.tools.events[i];
    if (!lastAt) lastAt = e.at;
    if (e.stage) { lastStage = e.stage; break; }
  }

  const readinessDim = input.readiness?.dimensions.find((d) => d.key === "readiness");

  return {
    threadId: input.threadId,
    hydrated:
      input.accountReady &&
      input.threadLoaded &&
      !input.artifacts.loading &&
      !input.tools.loading,
    run: {
      state,
      rowState,
      label: RUN_STATE_LABEL[state],
      terminal: isTerminalRunState(state),
      recoveryReason: input.thread?.recovery_reason ?? null,
      recoveredAt: input.thread?.recovered_at ?? null,
      startedAt: input.thread?.run_started_at ?? null,
      heartbeatAt: input.thread?.last_heartbeat_at ?? null,
    },
    seed: { value: input.thread?.seed_value ?? null, type: input.thread?.seed_type ?? null },
    evidence: {
      artifacts: artifactCount,
      ledger: input.integrity ? input.integrity.total : null,
      text: ev.text,
      hint: ev.hint,
      unledgered: ev.unledgered,
      available: !input.artifacts.error || artifactCount > 0,
    },
    tools: {
      total: input.tools.persistedTotal,
      failed: input.tools.failed,
      degraded: input.tools.degraded,
      skipped: input.tools.skipped,
      gated: input.tools.gated,
      ok: input.tools.ok,
      noRecord: input.tools.noRecord ?? 0,
      lastStage,
      lastAt,
      events: input.tools.events,
      available: !input.tools.error || input.tools.loadedAt !== null,
    },
    authority: input.authority,
    verifiedByAnalyst: input.verifiedByAnalyst ?? 0,
    spend: {
      microUsd: input.thread ? Number(input.thread.cost_micro_usd ?? 0) : null,
      text: input.thread ? formatUsd(input.thread.cost_micro_usd) : "—",
    },
    readiness: input.readiness && readinessDim
      ? { pct: readinessDim.value, reportReady: input.readiness.reportReady, profile: input.readiness }
      : null,
    integrity: input.integrity,
    items: input.artifacts.items,
    updatedAt: input.thread?.updated_at ?? null,
  };
}

// ── Change detection ────────────────────────────────────────────────────────

export type CaseChangeField = "status" | "tools" | "evidence" | "verified" | "spend";

export interface CaseChange {
  field: CaseChangeField;
  from: string;
  to: string;
}

const FIELD_LABEL: Record<CaseChangeField, string> = {
  status: "Status",
  tools: "Tools",
  evidence: "Artifacts",
  verified: "Verified",
  spend: "Spend",
};

/**
 * What changed between two published versions, in the terms the header shows.
 * Only hydrated snapshots are compared: the first load is a hydration, not an
 * update, and announcing it would tell the analyst every value "changed".
 */
export function diffCaseSnapshots(prev: CaseSnapshotCore | null, next: CaseSnapshotCore): CaseChange[] {
  if (!prev || !prev.hydrated || !next.hydrated || prev.threadId !== next.threadId) return [];
  const out: CaseChange[] = [];
  if (prev.run.state !== next.run.state) out.push({ field: "status", from: prev.run.label, to: next.run.label });
  if (prev.tools.total !== next.tools.total) out.push({ field: "tools", from: String(prev.tools.total), to: String(next.tools.total) });
  if (prev.evidence.artifacts !== next.evidence.artifacts) {
    out.push({ field: "evidence", from: String(prev.evidence.artifacts), to: String(next.evidence.artifacts) });
  }
  if (prev.authority.verified !== next.authority.verified) {
    out.push({ field: "verified", from: String(prev.authority.verified), to: String(next.authority.verified) });
  }
  if (prev.spend.text !== next.spend.text) out.push({ field: "spend", from: prev.spend.text, to: next.spend.text });
  return out;
}

/** "Status Interrupted → Complete · Tools 46 → 48 · Spend $0.120 → $0.393" */
export function describeCaseChanges(changes: CaseChange[]): string {
  return changes.map((c) => `${FIELD_LABEL[c.field]} ${c.from} → ${c.to}`).join(" · ");
}

/**
 * Whether a change is worth a screen-reader announcement.
 *
 * A status transition always is. During a live run the counts move every few
 * seconds, and announcing each one would bury the analyst in chatter — so
 * count/spend changes are announced only when the run is NOT live, which is the
 * reconciliation case the announcement exists for (a finished case whose
 * numbers moved under the analyst).
 */
export function shouldAnnounceChanges(changes: CaseChange[], next: CaseSnapshotCore): boolean {
  if (changes.length === 0) return false;
  if (changes.some((c) => c.field === "status")) return true;
  return next.run.state !== "running";
}
