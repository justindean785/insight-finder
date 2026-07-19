/**
 * chat-checkpoints.ts — render-time handling of incremental progress checkpoints.
 *
 * The edge function inserts assistant "progress checkpoint" messages mid-run
 * (each carries a part with `_incremental: true`). They exist so findings show
 * in chat even if the run is CPU-killed before the final report. Once the final
 * report — a NON-incremental assistant message — has landed, the checkpoints are
 * redundant with it, so we HIDE them at render to avoid rendering the same rows
 * twice.
 *
 * Pure + render-only: this never mutates the message store, subscription, or
 * persistence — it mirrors how failed tool parts are kept in state but hidden at
 * render. Filtering at the render boundary keeps state intact (checkpoints stay
 * available if a later render needs them, e.g. a new run in progress).
 */

type PartLike = { type?: string; text?: string; _incremental?: unknown; [k: string]: unknown };
type MessageLike = { role?: string; parts?: PartLike[] };

/** True when a message is an incremental progress checkpoint. */
export function isCheckpointMessage(m: MessageLike | null | undefined): boolean {
  return !!m && Array.isArray(m.parts) && m.parts.some((p) => p?._incremental === true);
}

/** True for a real (final) assistant report: an assistant message that is NOT a
 *  checkpoint and carries at least one non-empty text or tool part. */
function isFinalAssistantReport(m: MessageLike): boolean {
  if (m?.role !== "assistant" || !Array.isArray(m.parts) || isCheckpointMessage(m)) return false;
  return m.parts.some(
    (p) =>
      (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
      (typeof p?.type === "string" && p.type.startsWith("tool-")),
  );
}

/**
 * Drop incremental checkpoint messages that are superseded by a later final
 * assistant report. Order and identity of every other message are preserved.
 *
 * - No final report yet (run in progress, or killed and not yet recovered):
 *   checkpoints are KEPT so the analyst still sees progress.
 * - A checkpoint AFTER the last final report (a fresh run started in the same
 *   thread) is KEPT — it belongs to the new, not-yet-finished run.
 */
export function dedupeCheckpoints<T extends MessageLike>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let lastReportIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isFinalAssistantReport(messages[i])) lastReportIdx = i;
  }
  if (lastReportIdx === -1) return messages; // no final report yet → keep checkpoints
  return messages.filter((m, i) => !isCheckpointMessage(m) || i > lastReportIdx);
}
