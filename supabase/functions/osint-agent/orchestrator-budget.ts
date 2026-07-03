/**
 * orchestrator-budget.ts — rolling context + step budget for the orchestrator loop.
 *
 * These are PURE, integrity-neutral resilience helpers (no I/O, no SDK calls) so
 * they can be unit-tested against real ModelMessage[] shapes and reused by both of
 * index.ts's trimmers (the initial-prompt build and every `prepareStep`).
 *
 * WHY: the orchestrator re-sends the whole transcript every step, so a deep fan-out
 * pushes the prompt to 250k+ chars / 90+ messages (observed live: 37k→257k chars as
 * a run grows 1→97 messages). That slows MiniMax's preflight/request enough to fall
 * over. We keep the system prompt + the last N messages VERBATIM and replace the
 * tool-result PAYLOADS of older messages with a short reference+summary.
 *
 * SAFE TO ELIDE BY REFERENCE: every tool result is already persisted independently
 * of the transcript — tools call record_artifacts → the `artifacts` table, and a
 * finished run is cached in `investigation_cache` (see index.ts persistFinalMessages).
 * The model can pull any of it back on demand via memory_recall. So we forward a
 * pointer (tool name + original size), never a duplicate of the bytes.
 *
 * These helpers touch NO evidence ranking, confidence, or attribution logic — they
 * only bound prompt size so a deep run degrades gracefully instead of timing out.
 */

import type { ModelMessage } from "npm:ai@6";

// ---- Named budget constants -------------------------------------------------
// Total serialized-char ceiling for the message array handed to the orchestrator.
// Sized to sit well under MiniMax's ~600k-char (~150k-token) hard window with room
// for the ~35k-char system prompt + a streamed completion, while still holding ~10
// full recent turns. Lower ⇒ faster preflight; too low starves the model of recent
// context. 220k balances both (audit observed prompts reaching 250–538k).
export const TOTAL_PROMPT_CHAR_BUDGET = 220_000;

// Keep this many most-recent messages VERBATIM (full tool-result payloads); older
// messages have their tool-result outputs replaced by a reference+summary. N=10 ≈
// the last ~5 tool-call/result turn pairs, enough for the model to keep reasoning
// about its latest pivots while everything older is available by reference.
export const RECENT_WINDOW = 10;

// Max orchestrator steps per run (was stepCountIs(50)). A low ceiling plus the
// wall-clock deadline below collapse the p95 tool-time tail. Named so a test can
// pin it and so index.ts and any planner share one source of truth.
export const MAX_ORCHESTRATOR_STEPS = 30;

// Hard wall-clock deadline for a single run (ms). A StopCondition trips once elapsed
// time exceeds this, ending the run CLEANLY (onFinish persists the partial assistant
// + artifacts and marks the thread finished) instead of grinding to the step cap. A
// catastrophic-tail backstop (audit observed a 17.6-min max), not a routine limiter.
export const ORCHESTRATOR_WALL_CLOCK_MS = 6 * 60_000;

/**
 * True once `budgetMs` has elapsed since `startedAt` (both epoch ms). Extracted as a
 * pure function so the deadline StopCondition is unit-testable without a real clock.
 */
export function deadlineReached(now: number, startedAt: number, budgetMs: number): boolean {
  return now - startedAt > budgetMs;
}

type TrimPart = {
  type?: string;
  output?: unknown;
  text?: unknown;
  toolName?: unknown;
  [k: string]: unknown;
};

/** Approx serialized size of a ModelMessage[] — the metric the char budget bounds. */
export function approxMsgChars(msgs: ModelMessage[]): number {
  return msgs.reduce((n, m) => n + JSON.stringify(m).length, 0);
}

/**
 * Build the reference+summary that replaces an elided tool-result payload. The full
 * result lives in the artifact store, so we forward a pointer (tool name + original
 * size) instead of the bytes — keeping the model aware the data exists and is
 * retrievable, without re-sending it every step.
 */
export function elidedToolResultRef(toolName: unknown, originalValue: unknown): string {
  const name = typeof toolName === "string" && toolName ? toolName : "tool";
  let size = 0;
  try {
    size = typeof originalValue === "string" ? originalValue.length : JSON.stringify(originalValue).length;
  } catch {
    size = 0;
  }
  return `[older ${name} result elided to fit context budget — ${size} chars; ` +
    `full result persisted in the artifact store, retrieve via memory_recall]`;
}

/**
 * Bound the total serialized size of a ModelMessage[] by eliding the tool-result
 * OUTPUTS of the oldest messages (outside the keepRecent window) first, replacing
 * each with elidedToolResultRef(). NEVER drops a message (so every tool-call keeps
 * its matching tool-result and we can't trip MissingToolResults) and never touches
 * the last `keepRecent` messages. Returns a new array; does not mutate the input.
 */
export function capTotalToBudget(
  msgs: ModelMessage[],
  budget: number,
  keepRecent: number,
): ModelMessage[] {
  if (approxMsgChars(msgs) <= budget) return msgs;
  const out: ModelMessage[] = msgs.map((m) => ({ ...m }));
  const cutoff = Math.max(0, out.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    if (approxMsgChars(out) <= budget) break;
    const m = out[i];
    if ((m.role !== "tool" && m.role !== "assistant") || !Array.isArray(m.content)) continue;
    m.content = (m.content as TrimPart[]).map((part: TrimPart) => {
      if (part?.type === "tool-result" && part.output != null && JSON.stringify(part.output).length > 80) {
        // Preserve the tool-result output's discriminator. The AI SDK validates each
        // output against a typed union ({ type:'json'|'text'|…, value }); a bare
        // { value } (no `type`) fails the ModelMessage[] schema and aborts the whole
        // run. Spread the original output (keeps `type`) and only swap `value` for a
        // reference+summary pointing at the persisted artifact.
        const originalValue = part.output && typeof part.output === "object" && "value" in part.output
          ? (part.output as { value: unknown }).value
          : part.output;
        const ref = elidedToolResultRef(part.toolName, originalValue);
        const nextOutput = part.output && typeof part.output === "object" && "value" in part.output
          ? { ...(part.output as Record<string, unknown>), value: ref }
          : ref;
        return { ...part, output: nextOutput };
      }
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 200) {
        return { ...part, text: part.text.slice(0, 200) + " …[elided]" };
      }
      return part;
    }) as unknown as typeof m.content;
  }
  return out;
}
