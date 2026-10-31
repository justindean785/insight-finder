import type { ToolEvent } from "@/hooks/useThreadToolActivity";
import { isTerminalRunState, type CaseRunState } from "@/lib/case-snapshot";

/**
 * "Following the server": the run is alive on the server (fresh heartbeat) but
 * this browser is not receiving its live stream.
 *
 * That happens two ways, and the transcript looked frozen in both:
 * - the stream DROPPED mid-run (a phone suspends the page, an idle connection
 *   is cut during a long silent model step). The server is deliberately not
 *   bound to the request, so it carries on; `onError` only toasts and waits.
 * - the case was OPENED mid-run, on a reload or another device, so there was
 *   never a stream to hold.
 *
 * The run's assistant message is saved only when the run ends (step-by-step
 * saving was rolled back in #366), so its narration cannot be shown before
 * then. Its tool calls are saved as they happen (`tool_usage_log`, already in
 * the case snapshot), and those are what the transcript can keep showing.
 */
export function shouldFollowServer({ clientStreaming, serverRunActive }: {
  clientStreaming: boolean;
  serverRunActive: boolean;
}): boolean {
  return serverRunActive && !clientStreaming;
}

/** Ledger and browser clocks differ slightly; never drop this run's first call. */
const START_SKEW_MS = 5_000;

/**
 * This run's calls only, oldest first. A case can hold several runs, and their
 * calls must not be presented as this one's. With no recorded start there is no
 * honest cut, so nothing is shown rather than a mix.
 */
export function currentRunEvents(events: readonly ToolEvent[], runStartedAt: string | null): ToolEvent[] {
  if (!runStartedAt) return [];
  const start = Date.parse(runStartedAt);
  if (!Number.isFinite(start)) return [];
  return events
    .filter((e) => Date.parse(e.at) >= start - START_SKEW_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * While following, the last assistant message is treated as this run's reply
 * still in progress on the server: not "Interrupted", and its tool cards are
 * left to the server-follow panel. That is only right when it IS this run's.
 * A second tab that already had the case open keeps the PREVIOUS run's final
 * reply as its last message when a new run starts elsewhere (`messages` is not
 * in the realtime publication), and it must keep rendering as the finished
 * reply it is. A reply saved before the run's recorded start is not this run's;
 * one with no saved time is this tab's own local copy and is.
 */
export function isCurrentRunMessage(createdAt: string | undefined, runStartedAt: string | null): boolean {
  if (!createdAt || !runStartedAt) return true;
  const at = Date.parse(createdAt);
  const start = Date.parse(runStartedAt);
  if (!Number.isFinite(at) || !Number.isFinite(start)) return true;
  return at >= start - START_SKEW_MS;
}

/**
 * A stream that outlived the run it was streaming.
 *
 * The case snapshot reports "running" for as long as this tab's stream is open,
 * so a half-open stream that never ends (a CPU-killed isolate, a socket that
 * silently died) pins the case to Running even after the poll or a return to
 * the tab has read a finished row. The realtime watchdog only hears a realtime
 * UPDATE, which is the signal that is also dead in that case. The row's own
 * reading (`run.rowState`) is terminal, and it describes THIS run (its recorded
 * start is at or after this stream's start): the stream is dead and must be
 * stopped so the saved report can load.
 *
 * The start comparison is the safety case: when a new run starts, the row can
 * still show the previous run's finish until the next re-read, and a healthy
 * fresh stream must never be killed for it.
 */
export function shouldForceStreamEnd({ clientStreaming, rowState, rowStartedAt, streamStartedAtMs }: {
  clientStreaming: boolean;
  rowState: CaseRunState;
  rowStartedAt: string | null;
  streamStartedAtMs: number | null;
}): boolean {
  if (!clientStreaming || !isTerminalRunState(rowState)) return false;
  if (!rowStartedAt || streamStartedAtMs === null) return false;
  const start = Date.parse(rowStartedAt);
  if (!Number.isFinite(start)) return false;
  return start >= streamStartedAtMs - START_SKEW_MS;
}

/**
 * The watchdog's 8-second fallback after a normal `finished` update: was the stream
 * that is STILL loading the one that update was about? A terminal update for run A
 * arms the timer; if the analyst starts run B inside those 8 seconds (the Next panel
 * makes this a one-click, eight-second affair), the timer fires while B's fresh
 * stream is loading and `stop()` kills it — a clean close, no error, no toast — and
 * the tab drops to "Live view disconnected" at second one of a healthy run.
 * Measured on production 2026-10-31: run A finished 12:53:01.7, run B started
 * 12:53:09.9, and B's tab showed the follow panel from its first seconds.
 *
 * Only a stream that was already open when the timer was armed may be ended by it.
 */
export function shouldEndStreamAfterGrace({ clientStreaming, streamStartedAtMs, armedAtMs, rowUpdatedAt }: {
  clientStreaming: boolean;
  streamStartedAtMs: number | null;
  /** When this tab heard the terminal update. */
  armedAtMs: number;
  /** The row's own `updated_at`, when the payload carries it: a throttled or backgrounded tab can hear
   *  the update seconds late, and a stream opened in that gap is still not the one the update was about. */
  rowUpdatedAt?: string | null;
}): boolean {
  if (!clientStreaming) return false;
  if (streamStartedAtMs === null) return false;
  // Server and browser clocks differ; allow the same skew the run-start comparisons use.
  const rowMs = rowUpdatedAt ? Date.parse(rowUpdatedAt) : NaN;
  const bound = Number.isFinite(rowMs) ? Math.min(armedAtMs, rowMs + START_SKEW_MS) : armedAtMs;
  return streamStartedAtMs <= bound;
}

/**
 * What the follow panel is looking at. A stream that ENDED CLEANLY (no error, no
 * abort) while the row still reads running is the server's finalize window — the
 * tool loop is over and the server is salvaging/persisting the report (measured
 * 2026-10-31: 72s salvage + 75s persist after the stream closed). That is not a
 * disconnect and must not be called one. A stream that errored, or a tab that never
 * had one (reload, second tab), IS following a run it cannot hear.
 */
export type FollowMode = "disconnected" | "finalizing";
export function followMode({ streamEndedCleanly }: { streamEndedCleanly: boolean }): FollowMode {
  return streamEndedCleanly ? "finalizing" : "disconnected";
}
