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

// User turns can contain pasted breach JSON / raw dumps. The older tool-result
// elision below does not touch `role:"user"`, so one latest paste can still push
// the orchestrator prompt past 500k chars and burn CPU before the agent can close.
// Keep enough of the paste for selectors/context, but never resend the whole blob.
export const USER_TEXT_CHAR_BUDGET = 12_000;

// Max orchestrator steps per run (was stepCountIs(50)). A low ceiling plus the
// wall-clock deadline below collapse the p95 tool-time tail. Named so a test can
// pin it and so index.ts and any planner share one source of truth.
// Speed pass: 30 → 22. With the Gemini-primary path (parallel tool calls) 22
// steps comfortably reaches saturation on real runs; the extra 8 were being
// spent on redundant fan-out and dragging p95 wall-clock.
export const MAX_ORCHESTRATOR_STEPS = 22;

// Premature-stop fix for the "stops mid-investigation" bug. When true, every
// NON-finalize orchestrator step is forced to emit a tool call (toolChoice
// "required"), so the AI SDK loop can never terminate on a text-only step —
// the failure mode where the model narrates its next action ("Now let me run
// minimax_correlate…") without emitting the call, ending the run with planned
// NEXT STEPS still pending. The controlled finalize branch (auto tool choice)
// still produces the closing report, and the 22-step / 4-min budget still bounds
// the run. A single kill-switch so the behavior can be toggled without a code
// dive if a provider ever rejects tool_choice:"required".
export const FORCE_TOOL_CALL_UNTIL_FINALIZE = true;

/**
 * The AI SDK `toolChoice` for an orchestrator step. Pure so the premature-stop
 * fix is unit-testable without the streamText closure.
 *  - Finalize step  → "auto": it writes the closing report, which is a text-only
 *    step; forcing a tool call there would block the report.
 *  - Non-finalize   → "required" (when the kill-switch is on): the model MUST emit
 *    a tool call, so the loop can't terminate on a narration-only step (the
 *    "stops mid-investigation" bug). With the switch off, falls back to "auto".
 */
export function orchestratorStepToolChoice(isFinalizeStep: boolean): "required" | "auto" {
  if (isFinalizeStep || !FORCE_TOOL_CALL_UNTIL_FINALIZE) return "auto";
  return "required";
}

export interface IntermediateStepPlan {
  activeTools: string[];
  toolChoice: "required" | "auto";
}

/**
 * The prepareStep plan for a NON-finalize step. BOTH non-finalize branches — the
 * persistence nudge and the normal intermediate step — must build their plan
 * here so `toolChoice` can never be omitted at a call site.
 *
 * This exists because omitting it is not a cosmetic slip: a non-finalize return
 * without `toolChoice` silently defaults to "auto", which is the narration-only
 * stop bug. The first version of this fix set `toolChoice` on the normal branch
 * but missed the persistence-nudge branch — i.e. the one path whose entire job is
 * to force `record_artifacts` was the one that could still let the model narrate
 * "let me record the artifacts…" and end the run with zero evidence persisted.
 * Centralizing makes that class of miss structurally impossible.
 */
export function buildIntermediateStepPlan(input: {
  /** persistence nudge fired: restrict the step to recording the evidence */
  nudgePersistence: boolean;
  /** the tools the step would otherwise be allowed to use */
  normalActiveTools: readonly string[];
}): IntermediateStepPlan {
  return {
    activeTools: input.nudgePersistence ? ["record_artifacts"] : [...input.normalActiveTools],
    toolChoice: orchestratorStepToolChoice(false),
  };
}

// Hard ceiling on GENUINE (live, non-cached, non-skipped) tool executions per run.
// Live logs showed a single investigation balloon to 230 tool calls / 747s of
// tool-time (43× socialfetch_web_read, 38× minimax_web_search) — unbounded run size
// is the dominant "why is it slow". Once a run hits this, the wrapper stops starting
// new lookups and the orchestrator finalizes with the evidence in hand (see
// orchestrator-finalize.ts). Recording/evidence tools (ALWAYS_ALLOW) are exempt so
// the closing record_artifacts + report still run. Beta hotfix 2026-07-15: a live
// username run hit the old 60-call cap, crossed 4 minutes, then the edge runtime was
// CPU-killed before onFinish, leaving status=active and 0 assistant messages. Clamp
// to 36 so pathological fan-out is forced into record/report while there is still
// enough CPU budget left to persist completion.
export const MAX_TOOL_CALLS_PER_RUN = 36;

// Hard wall-clock deadline for a single run (ms). A StopCondition trips once elapsed
// time exceeds this, ending the run CLEANLY (onFinish persists the partial assistant
// + artifacts and marks the thread finished) instead of grinding to the step cap. A
// catastrophic-tail backstop (audit observed a 17.6-min max), not a routine limiter.
// Speed pass: 6 min → 4 min. Backstop only — with the step cap + parallel tool
// calls, healthy runs finish well under this; the 6-min tail was chasing dead
// providers.
export const ORCHESTRATOR_WALL_CLOCK_MS = 4 * 60_000;

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

function capText(text: string, max: number, label: string): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[${label} truncated ${text.length - max} chars to keep this investigation within CPU budget]`;
}

/**
 * Bound raw user text payloads before they are sent back through the orchestrator.
 * Tool results have their own reference elision; this covers pasted JSON/log dumps.
 */
export function capUserTextToBudget(
  msgs: ModelMessage[],
  maxChars: number = USER_TEXT_CHAR_BUDGET,
): ModelMessage[] {
  return msgs.map((m) => {
    if (m.role !== "user") return m;
    if (typeof m.content === "string") {
      return { ...m, content: capText(m.content, maxChars, "user input") } as ModelMessage;
    }
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: (m.content as TrimPart[]).map((part: TrimPart) => {
        if (part?.type === "text" && typeof part.text === "string") {
          return { ...part, text: capText(part.text, maxChars, "user input") };
        }
        return part;
      }) as unknown as typeof m.content,
    } as ModelMessage;
  });
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
  msgs = capUserTextToBudget(msgs);
  // O(n), not O(n^2): serialize each message's length ONCE and keep a running
  // total, folding in the delta as each message is elided below — instead of
  // re-summing the whole array every iteration (and again every prepareStep
  // step). Behavior is identical to a full re-serialization each pass (PR #193).
  const lengths = msgs.map((m) => JSON.stringify(m).length);
  let total = lengths.reduce((n, l) => n + l, 0);
  if (total <= budget) return msgs;
  const out: ModelMessage[] = msgs.map((m) => ({ ...m }));
  const cutoff = Math.max(0, out.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    if (total <= budget) break;
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
    // Reprice only the message we just elided and fold the delta into the
    // running total (subtract its old serialized length, add the new one).
    const newLen = JSON.stringify(m).length;
    total += newLen - lengths[i];
    lengths[i] = newLen;
  }
  return out;
}
