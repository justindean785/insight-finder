/**
 * run-cockpit.ts — the run, assembled from state the workspace already holds.
 *
 * READ-ONLY AND DERIVED. This is not a second run-state machine: the state is
 * the snapshot's own `run.state`, the stop explanation is `classifyRecovery`,
 * the stage is `humanizeStage` over the last recorded stage. Nothing here is
 * computed from chat prose, and nothing is guessed. A field the workspace
 * cannot prove reads `null`, and the panel says "not recorded" for it.
 *
 * Two things that look tempting and are deliberately absent:
 *  - a progress percentage. There is no known denominator (the run decides its
 *    own length), so any percent would be invented;
 *  - a "plan". The model's "I'll run three cycles" is narration, not a
 *    persisted plan, and printing it as one would present AI inference as
 *    execution state.
 *
 * The acting role comes from the tool name (`toolAgentRole`), which is a
 * display mapping, not a recorded actor. It is returned with `roleInferred`
 * so the panel can say so.
 */
import type { CaseRunState, CaseToolFigures } from "@/lib/case-snapshot";
import { classifyRecovery } from "@/lib/run-recovery";
import { humanizeStage, toolActionLabel, toolAgentRole } from "@/lib/tool-display";
import { fmtWallClock } from "@/lib/duration";

export interface RunCockpitInput {
  run: {
    state: CaseRunState;
    label: string;
    terminal: boolean;
    recoveryReason: string | null;
    recoveredAt: string | null;
    startedAt: string | null;
    heartbeatAt: string | null;
  };
  tools: Pick<CaseToolFigures, "total" | "failed" | "lastStage" | "lastAt" | "events" | "available">;
  spendText: string;
  /** The case sheet's "Needs your call" total — the Evidence tab badge's number.
   *  null until review verdicts have been read (no honest number before then). */
  pendingDecisions: number | null;
  nowMs: number;
}

export interface RunCockpit {
  state: CaseRunState;
  stateLabel: string;
  live: boolean;
  /** Wall-clock since the run started; null when the start was never recorded. */
  elapsed: string | null;
  /** "running" counts to now; a finished run counts to its last heartbeat. */
  elapsedBasis: "to now" | "to last heartbeat" | null;
  stage: string | null;
  lastAction: {
    action: string;
    role: string;
    roleInferred: true;
    status: string;
    at: string;
  } | null;
  calls: number | null;
  failed: number | null;
  spend: string;
  pendingDecisions: number | null;
  /** Why the run is not running. null while it is running or still a draft. */
  stop: { title: string; message: string; detail: string | null; tone: "warning" | "neutral" | "done" } | null;
}

function elapsedMs(startIso: string | null, endMs: number | null): number | null {
  if (!startIso || endMs === null) return null;
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || endMs < start) return null;
  return endMs - start;
}

export function buildRunCockpit(input: RunCockpitInput): RunCockpit {
  const { run, tools } = input;
  const live = run.state === "running";

  let endMs: number | null = null;
  let elapsedBasis: RunCockpit["elapsedBasis"] = null;
  if (live) {
    endMs = input.nowMs;
    elapsedBasis = "to now";
  } else if (run.terminal && run.heartbeatAt) {
    const hb = Date.parse(run.heartbeatAt);
    if (Number.isFinite(hb)) {
      endMs = hb;
      elapsedBasis = "to last heartbeat";
    }
  }
  const ms = elapsedMs(run.startedAt, endMs);
  const elapsed = ms === null ? null : fmtWallClock(ms) === "—" ? "0s" : fmtWallClock(ms);

  // The newest event by timestamp, never by array position: the ledger's order
  // is the server's, and a re-read can interleave.
  let last: (typeof tools.events)[number] | null = null;
  for (const e of tools.available ? tools.events : []) {
    if (!last || Date.parse(e.at) > Date.parse(last.at)) last = e;
  }

  let stop: RunCockpit["stop"] = null;
  if (run.state === "completed") {
    stop = {
      title: "Finished",
      message: "The run ended normally. The detailed stop reason is recorded server-side and is not shown in this view.",
      detail: null,
      tone: "done",
    };
  } else if (run.state === "interrupted" || run.state === "stopped") {
    const c = classifyRecovery({ runState: run.state, recoveryReason: run.recoveryReason, recoveredAt: run.recoveredAt });
    if (c) stop = { title: c.title, message: c.message, detail: c.detail, tone: c.tone };
  }

  return {
    state: run.state,
    stateLabel: run.label,
    live,
    elapsed: elapsed && elapsedBasis ? elapsed : null,
    elapsedBasis: elapsed ? elapsedBasis : null,
    stage: tools.available && tools.lastStage ? humanizeStage(tools.lastStage) : null,
    lastAction: last
      ? { action: toolActionLabel(last.toolName), role: toolAgentRole(last.toolName), roleInferred: true, status: last.status, at: last.at }
      : null,
    calls: tools.available ? tools.total : null,
    failed: tools.available ? tools.failed : null,
    spend: input.spendText,
    pendingDecisions: input.pendingDecisions,
    stop,
  };
}
