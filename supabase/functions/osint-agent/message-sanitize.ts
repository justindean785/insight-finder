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

// ---- Selector-preserving tool-result summarization (issue #238) ----------------
// The orchestrator pivots off identifiers it reads in raw tool-result text — the
// system prompt explicitly tells it to extract emails/usernames/phones/domains/
// IPs/wallets/handles from raw output and "feed each as a new pivot," and
// recording is only a precondition of the final REPORT, not of a pivot. So a raw
// result is NOT redundant with the recorded artifacts: blindly truncating or
// eliding it can drop a secondary selector the model hadn't pivoted on yet,
// silently narrowing discovery while artifact count stays unchanged.
//
// So when we compact an OLDER result (one the model has already had several steps
// to read at full size — never the recent window), we preserve every pivot-able
// selector verbatim and drop only the raw envelope (HTML, API metadata, verbose
// JSON). The full result stays retrievable via memory_recall.

// Global scanners for the exact selector classes system-prompt.ts pivots on.
// Order matters only for display grouping; dedup is by value across all classes.
const SELECTOR_SCANNERS: ReadonlyArray<RegExp> = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,               // email
  /\bhttps?:\/\/[^\s"'<>)\]]+/g,                                        // url
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,                                       // ipv4
  /\b0x[a-fA-F0-9]{40}\b/g,                                             // eth wallet
  /\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})\b/g,        // btc wallet
  /(?<![\w.])@[A-Za-z0-9_]{2,30}\b/g,                                   // social handle
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi,       // bare domain
  /\+?\d[\d\s().-]{6,17}\d/g,                                           // phone-ish
];

const MAX_PRESERVED_SELECTORS = 60;

/**
 * Extract every pivot-able selector from a blob of tool-result text, de-duplicated
 * and capped. Pure; used by summarizeToolResultValue and unit-tested directly.
 */
export function extractPivotSelectors(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of SELECTOR_SCANNERS) {
    for (const m of text.matchAll(re)) {
      const v = (m[0] ?? "").trim().replace(/[).,;]+$/, "");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      found.push(v);
      if (found.length >= MAX_PRESERVED_SELECTORS) return found;
    }
  }
  return found;
}

/**
 * Compact an OLDER tool-result value while preserving pivot fuel. If the
 * serialized value is already within `maxChars`, it is returned unchanged (same
 * contract as a plain truncate — small results are untouched). Otherwise returns
 * a summary STRING: a marker (naming the tool + original size + memory_recall
 * pointer), the full list of extracted selectors (never dropped to fit — the head
 * snippet is what shrinks), and a head snippet filling the remaining room.
 *
 * NEVER larger than the original. Caller wraps the returned value back into the
 * tool-result's `{ type, value }` shape, so pairing/schema are unaffected.
 */
export function summarizeToolResultValue(
  val: unknown,
  maxChars: number,
  toolName?: unknown,
): unknown {
  let raw: string;
  if (typeof val === "string") {
    raw = val;
  } else {
    try { raw = JSON.stringify(val); } catch { raw = String(val); }
  }
  if (raw.length <= maxChars) return val;

  const name = typeof toolName === "string" && toolName ? toolName : "tool";
  const selectors = extractPivotSelectors(raw);
  const selectorBlock = selectors.length
    ? `pivot selectors preserved: ${selectors.join(", ")}`
    : "no pivot selectors detected";
  const marker =
    `[older ${name} result summarized to fit context — ${raw.length} chars original; ` +
    `full result persisted, retrieve via memory_recall]`;
  const fixed = `${marker}\n${selectorBlock}`;
  const room = maxChars - fixed.length - 12; // 12 ≈ "\n--- head ---\n"
  if (room > 40) {
    const head = raw.slice(0, room).replace(/\s+\S*$/, "");
    const summary = `${fixed}\n--- head ---\n${head}`;
    return summary.length < raw.length ? summary : fixed;
  }
  // Selector list alone (fixed) fills the budget — keep it; never drop selectors
  // to satisfy the cap (capTotalToBudget is the structural backstop). Still
  // guaranteed smaller than the original raw payload that overflowed the cap.
  return fixed.length < raw.length ? fixed : raw.slice(0, maxChars);
}

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
