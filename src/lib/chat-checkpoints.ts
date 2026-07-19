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

// Failed-run sentinel (mirrors ChatWindow.tsx FAIL_PREFIX). A failed run's
// assistant message is NOT a final report — its checkpoints are the surviving
// partial evidence and must stay visible.
const FAIL_PREFIX = "__STATUS__:failed:";

function isFailSentinel(m: MessageLike): boolean {
  if (m?.role !== "assistant" || !Array.isArray(m.parts)) return false;
  const firstText = m.parts.find((p) => p?.type === "text");
  return typeof firstText?.text === "string" && firstText.text.startsWith(FAIL_PREFIX);
}

/** True for a real (final) assistant report: an assistant message that is NOT a
 *  checkpoint, NOT a failed-run sentinel, and carries at least one non-empty
 *  text or tool part. */
function isFinalAssistantReport(m: MessageLike): boolean {
  if (m?.role !== "assistant" || !Array.isArray(m.parts) || isCheckpointMessage(m) || isFailSentinel(m)) return false;
  return m.parts.some(
    (p) =>
      (p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) ||
      (typeof p?.type === "string" && p.type.startsWith("tool-")),
  );
}

/**
 * Drop incremental checkpoint messages that are superseded by their run's final
 * report. Order and identity of every other message are preserved.
 *
 * A checkpoint is hidden ONLY when a final assistant report appears later in the
 * SAME turn — i.e. after it and before the next user message. This is deliberate:
 * - A checkpoint whose run was killed (no final report before the next user
 *   message) is KEPT — it is the only surviving evidence of that run.
 * - A LATER turn's ordinary assistant reply (unrelated to finalization) must NOT
 *   hide an earlier turn's checkpoints. (This was the bug in the first cut: it
 *   treated any later non-checkpoint assistant message as "the final report".)
 * - A failed-run sentinel is not a report (see isFinalAssistantReport), so a
 *   failed run's checkpoints survive too.
 */
export function dedupeCheckpoints<T extends MessageLike>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const hide: boolean[] = new Array(messages.length).fill(false);
  for (let i = 0; i < messages.length; i++) {
    if (!isCheckpointMessage(messages[i])) continue;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j]?.role === "user") break; // next turn started → not superseded
      if (isFinalAssistantReport(messages[j])) { hide[i] = true; break; }
    }
  }
  return messages.filter((_, i) => !hide[i]);
}
