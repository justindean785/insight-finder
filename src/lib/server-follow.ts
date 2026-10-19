import type { ToolEvent } from "@/hooks/useThreadToolActivity";

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
