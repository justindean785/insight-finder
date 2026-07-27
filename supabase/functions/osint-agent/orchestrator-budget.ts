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

// ---- Intermediate (non-finalize) step plan -------------------------------------
// DISABLED (2026-07-25) — this was the 07-21 completion regression.
//
// Forcing toolChoice:"required" on every non-finalize step was meant to stop the
// model from narrating "Now let me run X" and ending the loop with pivots pending.
// But AI SDK v6 also ends the loop naturally when the model writes its FINAL report
// as a text-only step — so forcing a tool call every step removed the ONLY natural
// way to conclude. The run then had to reach the forced-finalize state machine
// (wall-clock reserve / step-22 / tool-cap), which the majority of killed runs never
// reached in time, so ~75% churned tools until killed and were recovered into a stub.
// Measured cliff:
// self-completion 61%->25%, natural conclusion moved from ~7 tool calls to never.
//
// The last-known-good build 6d76133 ran with this OFF (implicit "auto") and produced
// 65-83% real reports. The premature-ending risk it guards against is now covered by
// the detached auto-persist backstop (#380 + person-tool coverage), which secures
// findings even if the model narrates without calling record_artifacts.
//
// Kill switch: set back to true to re-enable forcing.
export const FORCE_TOOL_CALL_UNTIL_FINALIZE = false;

/**
 * Phase-aware OPENING gate (P0-B, 2026-07-26). This is NOT a return to the 07-21
 * regression above — read the difference carefully before touching it.
 *
 *   FORCE_TOOL_CALL_UNTIL_FINALIZE forced a tool call on EVERY intermediate step,
 *   which removed the model's only natural way to end (a text-only final report)
 *   and cratered self-completion 61% -> 25%.
 *
 *   This gate forces a tool call on the OPENING step ONLY — while the run has
 *   admitted ZERO tool calls AND the analyst's latest message is a parseable seed
 *   (i.e. they asked for an investigation, not a question). The instant any tool
 *   is admitted the gate releases and every later step is "auto", so the natural
 *   text-only report exit is fully preserved.
 *
 * WHY: with everything on "auto", production observed a seed turn (`jdean785`)
 * where the model emitted the 10-character text "I'll start", no tool call, and
 * the SDK ended the loop on finishReason:"stop" at step 1. That was persisted as
 * the run's final message and the thread went COMPLETE — the analyst had to type
 * "go" to make the investigation actually happen. `stopWhen` cannot prevent this
 * (it only ADDS stop conditions; the SDK's natural stop is not vetoable), so the
 * opening step is the one place the loop must not be allowed to end on narration.
 *
 * Kill switch: set to false to restore pure "auto" on every intermediate step.
 */
export const REQUIRE_TOOL_CALL_IN_OPENING_PHASE = true;

export function orchestratorStepToolChoice(
  isFinalizeStep: boolean,
  opts?: { openingPhase?: boolean },
): "required" | "auto" {
  if (isFinalizeStep) return "auto";
  if (REQUIRE_TOOL_CALL_IN_OPENING_PHASE && opts?.openingPhase) return "required";
  if (!FORCE_TOOL_CALL_UNTIL_FINALIZE) return "auto";
  return "required";
}

export interface IntermediateStepPlan {
  activeTools: string[];
  toolChoice: "required" | "auto";
}

/**
 * ONE builder for EVERY non-finalize prepareStep branch. Both the normal branch and
 * the persistence-nudge branch must go through this, so `toolChoice` cannot silently
 * fall back to "auto" on one path while the other forces — which is exactly how the
 * nudge became a no-op. `intermediate_step_plan_test.ts` fails if any non-finalize
 * plan omits the required tool choice.
 */
export function buildIntermediateStepPlan(input: {
  nudgePersistence: boolean;
  normalActiveTools: readonly string[];
  /** True only while the run has admitted zero tool calls AND the analyst asked
   *  for an investigation — see REQUIRE_TOOL_CALL_IN_OPENING_PHASE. */
  openingPhase?: boolean;
}): IntermediateStepPlan {
  return {
    activeTools: input.nudgePersistence ? ["record_artifacts"] : [...input.normalActiveTools],
    // The persistence nudge narrows activeTools to record_artifacts alone, whose
    // schema requires >= 1 artifact. Forcing a tool choice there would pressure the
    // model to fabricate an artifact or fail validation (the #384 P1 review defect),
    // so the opening gate never applies on a nudge step.
    toolChoice: orchestratorStepToolChoice(false, {
      openingPhase: input.openingPhase && !input.nudgePersistence,
    }),
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

/**
 * Atomically RESERVE a tool-call slot at admission — BEFORE `execute()` runs — so a
 * batch of tool calls dispatched in parallel by one model step (Promise.all fan-out)
 * cannot collectively overshoot the cap.
 *
 * WHY it must reserve, not count completions: the old gate read `toolCallBudget.genuine`
 * and incremented it only AFTER the live call fully completed — separated from the check
 * by several awaits. Under a parallel batch, every call read the same pre-increment
 * `genuine` before any of them incremented it, so the run overshot the cap (a live run
 * fanned out to 74 calls). This function does the read-check-increment with NO await in
 * between, so it is indivisible on JS's single thread even though the calling wrapper is
 * async — a batch contends for one authoritative counter.
 *
 * Recording/finalize tools (ALWAYS_ALLOW) are EXEMPT: they never consume a slot and are
 * always admitted, so the closing record_artifacts is never starved. Sets `capped` the
 * moment the cap is reached so the finalize trigger can key off RESERVATION (not
 * completed calls) — a run whose budget is spent on reserved-but-failed calls must still
 * be forced to finalize. A reserved slot is never released (a failed/slow call still
 * consumed a step's worth of the runtime), which is the intended, budget-protecting
 * behaviour.
 *
 * @returns true = admitted (slot reserved), false = rejected (cap reached).
 */
export function reserveToolCall(
  budget: { reserved: number; capped: boolean },
  isRecordingTool: boolean,
  cap: number = MAX_TOOL_CALLS_PER_RUN,
): boolean {
  if (isRecordingTool) return true;
  if (budget.reserved >= cap) {
    budget.capped = true;
    return false;
  }
  budget.reserved++;
  if (budget.reserved >= cap) budget.capped = true;
  return true;
}

/**
 * The finalize trigger's tool-budget cap signal. TRUE once the budget is exhausted by
 * RESERVATION (admission) — via the `capped` latch reserveToolCall flips, or the raw
 * reserved count — OR, as a backstop, by completed (`genuine`) calls.
 *
 * Keying force-finalize off THIS (not `genuine` alone) is the correction to the #377
 * decoupling: admission caps on `reserved`, so a run that spent its budget on
 * reserved-but-rejected calls has `genuine < cap` yet must still be forced to finalize
 * instead of looping forever on rejected admissions. Admission and finalization now
 * share one authoritative counter.
 */
export function isToolBudgetExhausted(
  budget: { genuine: number; reserved: number; capped: boolean },
  cap: number = MAX_TOOL_CALLS_PER_RUN,
): boolean {
  return budget.capped || budget.reserved >= cap || budget.genuine >= cap;
}

// Hard wall-clock deadline for a single run (ms). A StopCondition trips once elapsed
// time exceeds this, ending the run CLEANLY (onFinish persists the partial assistant
// + artifacts and marks the thread finished) instead of grinding to the step cap.
//
// HONEST NOTE: with the budget now AT the measured platform ceiling, this clean-stop
// StopCondition (index.ts deadlineReached) is not expected to trigger during normal
// operation. In observed production telemetry, invocations do not survive beyond the
// platform's effective lifetime (~180s measured by heartbeat), so elapsed rarely crosses
// the budget before the isolate is gone — an empirical observation, not a guarantee. It
// stays as a vestigial safety net; the reachable exits are model self-conclusion, the
// forced-finalize window at 90s (shouldForceFinalize), and the step/tool caps.
//
// MUST NOT EXCEED THE PLATFORM'S OWN ISOLATE LIFETIME. This is not a free "backstop"
// dial: `shouldForceFinalize` opens the finalize window at
// (ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS), so setting it ABOVE what the
// runtime actually grants pushes the finalize window past the point where the isolate
// is already dead — the run never gets to write its report at all.
//
// SET TO THE MEASURED 180s CEILING. Resolved 2026-07-25 against live prod, measuring
// ONE run generation as `last_heartbeat_at - run_started_at` (the heartbeat span, NOT
// thread age and NOT summed tool durations), separated by outcome and resume-state and
// with the max rows inspected individually (SQL saved in docs/ops/kill-window-measurement.sql):
//   * HARD CEILING 180s — recovered/killed runs: p99 178s, max 180.0s, ZERO runs >=200s.
//     Verified on the max rows: a killed run heartbeats 180s then dies, even when the
//     thread is later recovered (thread age 1157s, heartbeat span still 180s); a
//     7-generation thread aged 1708s still measured 165s for its latest run — thread age
//     does NOT leak in. The platform terminates the isolate at ~180s; nothing survives it.
//     NOT our own artifact: under the PRIOR 240s budget — where deadlineReached could not
//     truncate the heartbeat at 180s — the max was STILL exactly 180.0s and 0/58 runs
//     exceeded 180.5s (cross-era split by the 180s deploy time; query in the SQL). So the
//     180s is the platform's, not our StopCondition's. Caveat: the heartbeat pulses every
//     ~15s, so "180s" is measured to within one interval — the true ceiling is in
//     [180, 195); we calibrate to the lower bound (the safe direction: finalize opens
//     earlier, never later).
//   * Killed runs die across 30-180s: p50 ~108-113s, plurality in the 90-135s window,
//     ~30% survive to 135-180s. Resumed and non-resumed kills share the SAME distribution
//     (p50 113 vs 115), so resumption is not inflating the ceiling. So "~90-135s" is the
//     MODAL DEATH window, NOT a second ceiling — the two figures once carried here and in
//     orchestrator-finalize.ts were the MAX vs the MODE of ONE distribution, not a
//     contradiction. (The ~90-135s-as-ceiling reading, which had justified an even
//     earlier 65s closeout, is retracted by this production sample.)
// The 240s value briefly set on this branch (0c23856) is refuted: it opened forced
// finalize at 240-90=150s — PAST the 108.5s median death, so it never fired for the
// majority of killed runs — and its 240s clean-stop sits past the 180s ceiling, so it
// never fired at all. Restoring 180s puts forced-finalize at 180-90=90s: below the
// 108.5s median death (it catches the later half of kills) and above the 60s median
// completion of healthy runs (it rarely hijacks a run that would self-conclude — which,
// with FORCE_TOOL_CALL_UNTIL_FINALIZE=false, is now the common path).
//
// Depth note: this trades tail depth for a report actually existing — synthesis is
// forced at ~90s of tool work rather than never. If forced-finalize at 90s ever proves
// too aggressive for healthy runs, NARROW FINALIZE_RESERVE_MS (never inflate this budget
// past the 180s ceiling); telemetry says do NOT push the open time past ~108s.
export const ORCHESTRATOR_WALL_CLOCK_MS = 3 * 60_000;

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
