/**
 * message-sanitize.ts — defensive ModelMessage[] hardening.
 *
 * The orchestrator assembles a ModelMessage[] each cycle from persisted history
 * (convertToModelMessages) + an in-stream growth + char-budget elision
 * (capTotalToBudget). Several of those steps, or a prior run that died
 * mid-tool, can leave the array in a shape that the Vercel AI SDK's CLIENT-SIDE
 * Zod validation rejects BEFORE the request ever reaches the model:
 *
 *   - "Invalid prompt: The messages do not match the ModelMessage[] schema"
 *     (InvalidPromptError) — caused by a tool-result `output` that is a bare
 *     value / has no `{ type, value }` discriminator / is undefined, or a
 *     message whose `content` is null/undefined.
 *   - "Tool result is missing for tool call <id>" (MissingToolResultsError) —
 *     caused by an assistant tool-call with no matching tool-result (an
 *     ORPHANED pair, e.g. when an earlier cycle crashed after the call but
 *     before the result, or when trimming dropped one half of a pair).
 *
 * Once one malformed message is in history every subsequent cycle re-includes
 * it and re-fails identically → the run WEDGES until an analyst stops it.
 *
 * These helpers are PURE (no I/O, no SDK calls) so they can be unit-tested
 * against the real `modelMessageSchema`, and are applied immediately before
 * EVERY model call (the initial streamText prompt and every prepareStep).
 *
 * They are resilience-only: they never touch evidence ranking, confidence, or
 * any integrity logic — they only repair/drop structurally invalid messages so
 * the run degrades gracefully instead of wedging.
 */

import type { ModelMessage } from "npm:ai@6";

type AnyPart = { type?: string; toolCallId?: unknown; output?: unknown; text?: unknown; [k: string]: unknown };
type AnyMsg = { role?: string; content?: unknown; [k: string]: unknown };

const DROPPED_RESULT_PLACEHOLDER = "[result dropped to fit context]";

/**
 * Coerce any tool-result `output` into a schema-valid typed union
 * (`{ type, value }`). A bare value, a `{ value }` without `type`, or an
 * `undefined`/`null` output all fail the ModelMessage schema; this normalizes
 * every one of them. An already-valid discriminated output is passed through.
 */
export function normalizeToolOutput(output: unknown): { type: string; value: unknown } {
  if (
    output &&
    typeof output === "object" &&
    "type" in output &&
    typeof (output as { type?: unknown }).type === "string" &&
    "value" in output &&
    (output as { value?: unknown }).value !== undefined
  ) {
    return output as { type: string; value: unknown };
  }
  if (typeof output === "string") return { type: "text", value: output };
  if (output == null) return { type: "text", value: DROPPED_RESULT_PLACEHOLDER };
  // Objects/arrays/numbers/booleans without a valid discriminator → JSON.
  return { type: "json", value: output };
}

/**
 * Repair a ModelMessage[] so it always satisfies the AI SDK's ModelMessage
 * schema AND the tool-call/tool-result pairing invariant.
 *
 * Guarantees on the returned array:
 *   1. No message with null/undefined content and no empty-string content.
 *   2. No empty `content` arrays (such messages are dropped).
 *   3. Every tool-result `output` is a valid `{ type, value }` union.
 *   4. Every assistant tool-call has a matching tool-result (a minimal
 *      placeholder result is synthesized immediately after the assistant
 *      message if one is missing).
 *   5. No orphaned tool-result (a tool-result whose tool-call is absent is
 *      dropped).
 *
 * Pure: returns a new array; does not mutate the input.
 */
export function sanitizeModelMessages(input: ModelMessage[]): ModelMessage[] {
  if (!Array.isArray(input)) return [];

  // Pass 1 — collect every toolCallId that has a real assistant tool-call.
  const callIds = new Set<string>();
  for (const raw of input) {
    const m = raw as AnyMsg;
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as AnyPart[]) {
        if (p?.type === "tool-call" && typeof p.toolCallId === "string") callIds.add(p.toolCallId);
      }
    }
  }

  // Pass 2 — repair/drop each message and remember which tool-call ids already
  // have a tool-result so we don't synthesize duplicates.
  const resolved = new Set<string>();
  const cleaned: ModelMessage[] = [];
  for (const raw of input) {
    const m = raw as AnyMsg;
    if (!m || typeof m !== "object" || typeof m.role !== "string") continue;

    // String content: keep non-empty, drop empty/whitespace-only.
    if (typeof m.content === "string") {
      if (m.content.trim() === "") continue;
      cleaned.push(m as ModelMessage);
      continue;
    }

    // Non-array, non-string content (null/undefined/object) is invalid → drop.
    if (!Array.isArray(m.content)) continue;

    const parts: AnyPart[] = [];
    for (const p of m.content as AnyPart[]) {
      if (p == null || typeof p !== "object" || typeof p.type !== "string") continue;

      if (p.type === "tool-result") {
        // Drop a tool-result with no matching assistant tool-call (orphan).
        if (typeof p.toolCallId !== "string" || !callIds.has(p.toolCallId)) continue;
        resolved.add(p.toolCallId);
        parts.push({ ...p, output: normalizeToolOutput(p.output) });
        continue;
      }

      if (p.type === "text") {
        // Empty text parts are useless and can leave a message content-less.
        if (typeof p.text !== "string" || p.text.length === 0) continue;
        parts.push(p);
        continue;
      }

      // tool-call / reasoning / file / image / etc. → keep as-is.
      parts.push(p);
    }

    if (parts.length === 0) continue; // never emit an empty-content message
    cleaned.push({ ...m, content: parts } as ModelMessage);
  }

  // Pass 3 — enforce pairing: for every assistant message that issues a
  // tool-call whose result never appeared, synthesize a minimal placeholder
  // tool-result immediately after it, so the assistant tool-call is never left
  // dangling (which would trip MissingToolResultsError).
  const out: ModelMessage[] = [];
  for (const msg of cleaned) {
    out.push(msg);
    const m = msg as AnyMsg;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const missing: AnyPart[] = [];
    for (const p of m.content as AnyPart[]) {
      if (p?.type === "tool-call" && typeof p.toolCallId === "string" && !resolved.has(p.toolCallId)) {
        resolved.add(p.toolCallId);
        missing.push({
          type: "tool-result",
          toolCallId: p.toolCallId,
          toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
          output: { type: "text", value: DROPPED_RESULT_PLACEHOLDER },
        });
      }
    }
    if (missing.length > 0) {
      out.push({ role: "tool", content: missing } as unknown as ModelMessage);
    }
  }

  return out;
}

/**
 * Bound the size of individual tool-result outputs so a few enormous results
 * can't keep the prompt riding at the schema/length ceiling (the observed
 * ~250k-char plateau). Truncates any tool-result whose serialized `value`
 * exceeds `maxChars`, appending a "[truncated …]" marker, while preserving the
 * output's `{ type, value }` discriminator (so it stays schema-valid).
 *
 * Pure: returns a new array; does not mutate the input. Apply AFTER
 * sanitizeModelMessages (it assumes outputs are already normalized).
 */
export function capToolResultOutputs(input: ModelMessage[], maxChars: number): ModelMessage[] {
  if (!Array.isArray(input)) return [];
  const truncate = (value: unknown): { changed: boolean; value: unknown } => {
    if (typeof value === "string") {
      if (value.length <= maxChars) return { changed: false, value };
      return { changed: true, value: value.slice(0, maxChars) + `\n…[truncated ${value.length - maxChars} chars]` };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return { changed: false, value };
    }
    if (serialized == null || serialized.length <= maxChars) return { changed: false, value };
    return { changed: true, value: serialized.slice(0, maxChars) + `\n…[truncated ${serialized.length - maxChars} chars]` };
  };
  return input.map((raw) => {
    const m = raw as AnyMsg;
    if ((m.role !== "tool" && m.role !== "assistant") || !Array.isArray(m.content)) return raw;
    let any = false;
    const content = (m.content as AnyPart[]).map((p) => {
      if (p?.type !== "tool-result" || p.output == null || typeof p.output !== "object") return p;
      const out = p.output as { type?: unknown; value?: unknown };
      if (!("value" in out)) return p;
      const r = truncate(out.value);
      if (!r.changed) return p;
      any = true;
      // Truncating an object/array into a string would break a non-text/json
      // discriminator, so coerce to a `text` output when we stringify.
      const nextType = typeof out.value === "string" || out.type === "json" || out.type === "text"
        ? out.type
        : "text";
      return { ...p, output: { ...out, type: nextType, value: r.value } };
    });
    return any ? ({ ...m, content } as ModelMessage) : raw;
  });
}
