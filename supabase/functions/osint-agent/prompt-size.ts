/**
 * prompt-size.ts — honest accounting of what actually reaches the orchestrator.
 *
 * PURE (no I/O, no SDK calls) so it can be unit-tested and reused by both the
 * initial-prompt build and every `prepareStep`.
 *
 * WHY THIS EXISTS: `index.ts`'s `approxPromptChars` is
 *   (SYSTEM_PROMPT_FULL.length + FINDING_LABELS.length) + JSON.stringify(messages).length
 * and that is the number logged as `approx prompt chars` and persisted as
 * `orchestrator_invocations.initial_context_chars`. It OMITS, silently:
 *   • buildWorkflowAddendum(seedType) + the playbook it renders   (~4.6k chars)
 *   • visionIntakeSummary                                        (0 unless attachments)
 *   • analystDecisionsBlock                                      (0 → ~30k chars)
 *   • the per-step directives appended in prepareStep            (~0.8–2k chars)
 *   • every tool's serialized input schema                       (large, see below)
 * So a context target set against it is measured with a ruler that does not count
 * several of the terms it is supposed to bound. Production telemetry reporting
 * ~175k average initial context is therefore a FLOOR, not the figure.
 *
 * ⚠️ `approxPromptChars` itself is deliberately NOT changed by this module. It is an
 * input to provider routing (the MiniMax pre-pivot at MINIMAX_CHAR_BUDGET and the
 * DeepSeek safety budget), so inflating it would re-route runs that route fine today.
 * This module MEASURES; it never decides.
 *
 * WHAT IS DELIBERATELY NOT ESTIMATED: the serialized JSON Schema the SDK derives
 * from each tool's Zod `inputSchema`. zod@3 exposes no JSON-Schema export, and the
 * conversion happens inside the AI SDK, so any number produced here would be a guess.
 * Tool DESCRIPTIONS are counted exactly (they are plain strings); the schema bodies
 * are named in `unmeasured` instead of being invented. Read `total_measured` as
 * "everything we can count exactly", never as the whole prompt.
 */

/** Char counts for the prompt terms that can be measured exactly. */
export interface PromptTermInput {
  /** SYSTEM_PROMPT_FULL — the static role/workflow/safety block. */
  systemStatic: number;
  /** FINDING_LABELS — the label contract appended to the system prompt. */
  findingLabels: number;
  /** buildWorkflowAddendum(seedType) + rendered playbook. */
  workflowAddendum: number;
  /** Attachment/vision intake summary; 0 when the run has no attachments. */
  visionIntake: number;
  /** renderAnalystDecisionsBlock(...) — grows with the analyst's verdicts. */
  analystDecisions: number;
  /** Per-step directive appended in prepareStep (compact / nudge / finalize). */
  stepDirective: number;
  /** Serialized ModelMessage[] actually handed to the model this step. */
  messages: number;
  /** Number of tool definitions exposed to the model this step. */
  toolCount: number;
  /** Sum of tool `description` string lengths — exact. */
  toolDescriptions: number;
}

export interface PromptSizeReport {
  /** Sum of every exactly-measured char term. NOT the whole prompt — see `unmeasured`. */
  total_measured: number;
  /** The system-side subtotal (everything but `messages`). */
  system_total: number;
  terms: PromptTermInput;
  /** Named terms that are real but not counted here, so the total is never misread. */
  unmeasured: string[];
}

/** Terms that exist in the wire prompt but are not countable from here. */
export const UNMEASURED_TERMS: readonly string[] = [
  "tool_input_schemas_serialized",
] as const;

function nonNegative(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Normalize and total the measurable prompt terms. Every field is coerced through
 * `nonNegative` so a caller passing `undefined` for a term that does not apply this
 * step (no attachments, no directive) degrades to 0 rather than NaN-ing the total —
 * a NaN here would silently destroy the very instrument this module exists to fix.
 */
export function measurePromptTerms(input: Partial<PromptTermInput>): PromptSizeReport {
  const terms: PromptTermInput = {
    systemStatic: nonNegative(input.systemStatic),
    findingLabels: nonNegative(input.findingLabels),
    workflowAddendum: nonNegative(input.workflowAddendum),
    visionIntake: nonNegative(input.visionIntake),
    analystDecisions: nonNegative(input.analystDecisions),
    stepDirective: nonNegative(input.stepDirective),
    messages: nonNegative(input.messages),
    toolCount: nonNegative(input.toolCount),
    toolDescriptions: nonNegative(input.toolDescriptions),
  };
  // toolCount is a COUNT, not a char term — it must never be summed into the total.
  const system_total =
    terms.systemStatic +
    terms.findingLabels +
    terms.workflowAddendum +
    terms.visionIntake +
    terms.analystDecisions +
    terms.stepDirective +
    terms.toolDescriptions;
  return {
    total_measured: system_total + terms.messages,
    system_total,
    terms,
    unmeasured: [...UNMEASURED_TERMS],
  };
}

/**
 * Exact char count of the tool descriptions the model is shown, plus the tool count.
 * Tolerates any registry shape: a non-string description contributes 0 rather than
 * throwing, because this runs on the hot path of every step.
 */
export function measureToolDescriptions(
  tools: Record<string, unknown> | null | undefined,
): { toolCount: number; toolDescriptions: number } {
  if (!tools || typeof tools !== "object") return { toolCount: 0, toolDescriptions: 0 };
  const names = Object.keys(tools);
  let chars = 0;
  for (const name of names) {
    const def = (tools as Record<string, { description?: unknown }>)[name];
    const d = def?.description;
    if (typeof d === "string") chars += d.length;
  }
  return { toolCount: names.length, toolDescriptions: chars };
}

/**
 * The structured log line. Emitted as one JSON object so it can be grepped out of
 * edge logs and aggregated without a schema migration — the live database is
 * Lovable-owned and `supabase/migrations/` is not the mechanism that changes it,
 * so a new telemetry COLUMN is a separate, gated piece of work.
 */
export function promptSizeEvent(
  event: string,
  threadId: string,
  report: PromptSizeReport,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event,
    thread_id: threadId,
    total_measured_chars: report.total_measured,
    system_chars: report.system_total,
    message_chars: report.terms.messages,
    unmeasured: report.unmeasured,
    ...report.terms,
    ...extra,
  });
}
