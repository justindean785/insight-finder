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
 * These helpers are PURE apart from ONE structured `console.warn`
 * (`sanitize_positional_pair_repair`, emitted only when a repair actually
 * happens) — no other I/O, no SDK calls — so they can be unit-tested against
 * the real `modelMessageSchema`, and are applied immediately before EVERY
 * model call (the initial streamText prompt and every prepareStep).
 *
 * They are resilience-only: they never touch evidence ranking, confidence, or
 * any integrity logic — they only repair/drop structurally invalid messages so
 * the run degrades gracefully instead of wedging.
 */

import type { ModelMessage } from "npm:ai@6";

type AnyPart = { type?: string; toolCallId?: unknown; output?: unknown; text?: unknown; [k: string]: unknown };
type AnyMsg = { role?: string; content?: unknown; [k: string]: unknown };

const DROPPED_RESULT_PLACEHOLDER = "[result dropped to fit context]";

// ---- Tool-call INPUT shape (2026-10-14) --------------------------------------
// A third wedge, specific to Anthropic. When the model emits a tool call whose
// arguments are not valid JSON, the AI SDK records the UI tool part in state
// `output-error` with `rawInput` = the unparsed text, and convertToModelMessages
// (ai@6.0.304 index.mjs:9770) then emits an assistant `tool-call` whose `input`
// is that STRING. The SDK's ModelMessage schema types `input` as unknown, so
// nothing client-side objects; the OpenAI-compatible providers (GLM, MiniMax,
// DeepSeek) accept it; Anthropic rejects the whole request:
//   "messages.N.content.M.tool_use.input: Input should be an object [HTTP 400]"
// Measured 2026-10-14, thread 7b6123f3: ONE unparseable record_artifacts call in
// run 2, then ELEVEN consecutive continuation attempts that all died at step 0
// with that message — every "Retry" re-sent the same poisoned history.
//
// Repair, in this order, per assistant tool-call part:
//   1. `input` is a plain object → untouched.
//   2. `input` is a string that JSON.parses to a plain object → use the parsed
//      object (the model's text was valid JSON that the SDK could not parse in
//      its streamed form, or was wrapped). Counted as `repaired`.
//   3. anything else (unparseable text, array, number, null) → the call is
//      DROPPED and replaced by a short text part; its paired tool-result (which
//      only ever says the call failed) becomes an orphan and is dropped by the
//      existing rule. Never substituted with `{}`: that would misrepresent what
//      the tool was called with. Counted as `dropped`.
// Evidence is untouched: a dropped call was already logged as `failed` in
// tool_usage_log and persisted nothing (auto-persist never ran for it).
// Kill switch, read at CALL TIME by the caller: TOOL_CALL_INPUT_SHAPE_DISABLED=true
// restores the pass-through. /health proof key: checks.tool_call_input_shape.

export const TOOL_CALL_INPUT_SHAPE_DISABLED_ENV = "TOOL_CALL_INPUT_SHAPE_DISABLED";
const DROPPED_CALL_NOTE = "[a tool call whose arguments were not valid JSON was dropped from history]";

export function toolCallInputShapeDisabled(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  return (env(TOOL_CALL_INPUT_SHAPE_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export type ToolCallInputShape =
  | { action: "keep"; input: Record<string, unknown> }
  | { action: "repair"; input: Record<string, unknown> }
  | { action: "drop" };

/** Decide what to do with one tool-call `input`. Pure. */
export function normalizeToolCallInput(input: unknown): ToolCallInputShape {
  if (isPlainObject(input)) return { action: "keep", input };
  if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("{")) {
      try {
        const parsed = JSON.parse(t);
        if (isPlainObject(parsed)) return { action: "repair", input: parsed };
      } catch {
        // fall through: unparseable
      }
    }
  }
  return { action: "drop" };
}

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
  // ⚠️ Do NOT re-add a retrieval promise here. This marker used to end "full
  // result persisted, retrieve via memory_recall"; `memory_recall` reads only
  // `agent_memory` and no tool in the registry reads `tool_call_cache`, so it
  // named a route the model cannot take. The selectors below ARE the durable
  // carry-over — say that instead of promising a retrieval that never worked.
  const marker =
    `[${name} result summarized to fit context — ${raw.length} chars original; ` +
    `the selectors below are preserved in full]`;
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
export function sanitizeModelMessages(
  input: ModelMessage[],
  opts: { inputShape?: boolean } = {},
): ModelMessage[] {
  const inputShape = opts.inputShape ?? !toolCallInputShapeDisabled();
  const { out, overlapRepairs, messages, inputRepaired, inputDropped } = sanitizeCore(input, inputShape);
  if (inputRepaired > 0 || inputDropped > 0) {
    // Counts only — never the input text (it can carry case values).
    console.warn(JSON.stringify({ event: "sanitize_tool_call_input_shape", repaired: inputRepaired, dropped: inputDropped }));
  }
  // Durable signal: counts the overlap repairs this build makes in production.
  // Only emitted when a repair actually happened — a quiet log means no
  // overlap. (Proof of deploy is /health checks.message_sanitize, not this.)
  if (overlapRepairs > 0) {
    console.warn(JSON.stringify({
      event: "sanitize_positional_pair_repair",
      repaired_calls: overlapRepairs,
      messages,
    }));
  }
  return out;
}

/** The repair itself, with no logging. Shared by sanitizeModelMessages and the /health self-test. */
function sanitizeCore(
  input: ModelMessage[],
  inputShape = true,
): { out: ModelMessage[]; overlapRepairs: number; messages: number; inputRepaired: number; inputDropped: number } {
  if (!Array.isArray(input)) return { out: [], overlapRepairs: 0, messages: 0, inputRepaired: 0, inputDropped: 0 };

  // Pass 0 — tool-call INPUT shape (see the header block above). Decides, per
  // assistant tool-call, whether it is kept, repaired or dropped, BEFORE pass 1
  // collects ids: a dropped call must not count as a real call, so that its
  // paired result is treated as the orphan it now is.
  let inputRepaired = 0;
  let inputDropped = 0;
  const droppedCalls = new Set<AnyPart>();
  const repairedInputs = new Map<AnyPart, Record<string, unknown>>();
  if (inputShape) {
    for (const raw of input) {
      const m = raw as AnyMsg;
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const p of m.content as AnyPart[]) {
        if (p?.type !== "tool-call") continue;
        const shape = normalizeToolCallInput(p.input);
        if (shape.action === "repair") { repairedInputs.set(p, shape.input); inputRepaired++; }
        else if (shape.action === "drop") { droppedCalls.add(p); inputDropped++; }
      }
    }
  }

  // Pass 1 — collect every toolCallId that has a real assistant tool-call.
  const callIds = new Set<string>();
  for (const raw of input) {
    const m = raw as AnyMsg;
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as AnyPart[]) {
        if (p?.type === "tool-call" && typeof p.toolCallId === "string" && !droppedCalls.has(p)) callIds.add(p.toolCallId);
      }
    }
  }

  // Pass 2 — repair/drop each message. Pairing is settled in pass 3, which
  // resolves per POSITION. A global "already resolved" set here is exactly what
  // let a duplicate tool-call id go unpaired (see pass 3), so there isn't one.
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
        parts.push({ ...p, output: normalizeToolOutput(p.output) });
        continue;
      }

      if (p.type === "text") {
        // Empty text parts are useless and can leave a message content-less.
        if (typeof p.text !== "string" || p.text.length === 0) continue;
        parts.push(p);
        continue;
      }

      if (p.type === "tool-call") {
        if (droppedCalls.has(p)) {
          // Dropped for an unrepairable input: leave a note so the transcript
          // still says a call was made, and so the message is never empty.
          parts.push({ type: "text", text: DROPPED_CALL_NOTE });
          continue;
        }
        const fixed = repairedInputs.get(p);
        parts.push(fixed ? { ...p, input: fixed } : p);
        continue;
      }

      // reasoning / file / image / etc. → keep as-is.
      parts.push(p);
    }

    if (parts.length === 0) continue; // never emit an empty-content message
    cleaned.push({ ...m, content: parts } as ModelMessage);
  }

  // Pass 3 — enforce pairing POSITIONALLY: for every assistant message that
  // issues a tool-call not answered by the tool message(s) DIRECTLY following
  // it, synthesize a minimal placeholder tool-result there, so no assistant
  // tool-call is ever left dangling (which would trip MissingToolResultsError).
  //
  // ⚠️ Resolve per POSITION, never by id globally. The AI SDK validates that
  // each assistant tool-call is answered in the messages that FOLLOW it — not
  // merely that the id appears somewhere in the array. A tool-call id can occur
  // in TWO assistant messages when two runs overlap on one thread (measured at
  // 12.2% of invocations; production thread bfa55610 on 2026-09-12 died twice in
  // 85 ms on the same id). A global `resolved` set was satisfied by whichever
  // occurrence carried the real result and synthesized nothing for the other,
  // so the earlier duplicate went out unpaired and the run died before any
  // provider call. Keying on position cannot make that mistake.
  // Every id answered ANYWHERE — used only to classify a repair for the log
  // below, never to decide pairing. Deciding pairing from this is the defect.
  const resolvedAnywhere = new Set<string>();
  for (const msg of cleaned) {
    const m = msg as AnyMsg;
    if (m?.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content as AnyPart[]) {
      if (p?.type === "tool-result" && typeof p.toolCallId === "string") resolvedAnywhere.add(p.toolCallId);
    }
  }
  let overlapRepairs = 0;

  const out: ModelMessage[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const msg = cleaned[i];
    out.push(msg);
    const m = msg as AnyMsg;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

    // The adjacent tool block — every consecutive `tool` message immediately
    // after this assistant message. Those, and only those, can pair its calls.
    const answeredHere = new Set<string>();
    for (let j = i + 1; j < cleaned.length; j++) {
      const next = cleaned[j] as AnyMsg;
      if (next?.role !== "tool" || !Array.isArray(next.content)) break;
      for (const p of next.content as AnyPart[]) {
        if (p?.type === "tool-result" && typeof p.toolCallId === "string") answeredHere.add(p.toolCallId);
      }
    }

    const missing: AnyPart[] = [];
    // Guards a duplicate id WITHIN one assistant message: one call needs one
    // result, and emitting two placeholders for it would be invalid in itself.
    const synthesized = new Set<string>();
    for (const p of m.content as AnyPart[]) {
      if (p?.type !== "tool-call" || typeof p.toolCallId !== "string") continue;
      if (answeredHere.has(p.toolCallId) || synthesized.has(p.toolCallId)) continue;
      synthesized.add(p.toolCallId);
      // An id answered SOMEWHERE ELSE in the array but not here is the overlap
      // wedge: the old global set treated that as resolved and left this call
      // unpaired. Count it so the rate is measurable in production.
      if (resolvedAnywhere.has(p.toolCallId)) overlapRepairs++;
      missing.push({
        type: "tool-result",
        toolCallId: p.toolCallId,
        toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
        output: { type: "text", value: DROPPED_RESULT_PLACEHOLDER },
      });
    }
    if (missing.length > 0) {
      out.push({ role: "tool", content: missing } as unknown as ModelMessage);
    }
  }

  return { out, overlapRepairs, messages: cleaned.length, inputRepaired, inputDropped };
}

const PAIRING_PROBE_ID = "health-probe-overlap";

/**
 * The overlap shape that wedged production, as a fixed synthetic probe: one
 * tool-call id issued twice, the first copy never answered and followed by a
 * user turn, the second answered late. The AI SDK rejects this raw array with
 * MissingToolResultsError at the first user turn. (Two back-to-back assistant
 * copies with no user turn between them would NOT reproduce it: the SDK only
 * checks for unanswered calls at user/system turns and at the end.) A fresh
 * array on every call; no case data.
 */
export function pairingProbeFixture(): ModelMessage[] {
  const call = { type: "tool-call", toolCallId: PAIRING_PROBE_ID, toolName: "health_probe", input: {} };
  return [
    { role: "user", content: "probe" },
    { role: "assistant", content: [{ ...call }] },
    { role: "user", content: "continue" },
    { role: "assistant", content: [{ ...call }] },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: PAIRING_PROBE_ID,
        toolName: "health_probe",
        output: { type: "json", value: { genuine: true } },
      }],
    },
    { role: "user", content: "continue" },
  ] as unknown as ModelMessage[];
}

/**
 * /health `checks.message_sanitize`: run the DEPLOYED sanitizer on
 * pairingProbeFixture() and check the result the way it has to hold in
 * production. Walking in order, no tool-call may still be unanswered at a user
 * turn or at the end (the AI SDK's MissingToolResults rule); every call must be
 * answered by the tool block directly after it (what OpenAI-compatible
 * providers require); and the genuine result must be kept. Pure and silent: it
 * uses the non-logging core, so frequent health probes never emit
 * sanitize_positional_pair_repair. `sanitize` is injectable only so a test can
 * prove the probe catches the old global-id pairing.
 */
export function positionalPairingSelfTest(
  sanitize: (m: ModelMessage[]) => ModelMessage[] = (m) => sanitizeCore(m).out,
): { ok: boolean; detail: string } {
  let msgs: AnyMsg[];
  try {
    msgs = sanitize(pairingProbeFixture()) as unknown as AnyMsg[];
  } catch (e) {
    return { ok: false, detail: `pairing self-test threw: ${String(e).slice(0, 120)}` };
  }
  const fail = (why: string) => ({ ok: false, detail: `pairing BROKEN: ${why}` });
  const partsOf = (m: AnyMsg | undefined): AnyPart[] => (Array.isArray(m?.content) ? (m.content as AnyPart[]) : []);
  const idOf = (p: AnyPart, type: string) =>
    p?.type === type && typeof p.toolCallId === "string" ? p.toolCallId : null;

  // 1. The SDK's rule: nothing pending at a user/system turn or at the end.
  const pending = new Set<string>();
  for (const m of msgs) {
    if (m?.role === "assistant") {
      for (const p of partsOf(m)) { const id = idOf(p, "tool-call"); if (id) pending.add(id); }
    } else if (m?.role === "tool") {
      for (const p of partsOf(m)) { const id = idOf(p, "tool-result"); if (id) pending.delete(id); }
    } else if ((m?.role === "user" || m?.role === "system") && pending.size > 0) {
      return fail("a tool-call is unanswered at a user turn (MissingToolResults)");
    }
  }
  if (pending.size > 0) return fail("a tool-call is unanswered at the end");

  // 2. Every call is answered by the tool block directly after it.
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role !== "assistant") continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < msgs.length && msgs[j]?.role === "tool"; j++) {
      for (const p of partsOf(msgs[j])) { const id = idOf(p, "tool-result"); if (id) answered.add(id); }
    }
    for (const p of partsOf(msgs[i])) {
      const id = idOf(p, "tool-call");
      if (id && !answered.has(id)) return fail("a tool-call is not answered in place");
    }
  }

  // 3. The genuine result survives; it is not replaced by a placeholder.
  const genuine = msgs.flatMap(partsOf).some((p) =>
    idOf(p, "tool-result") === PAIRING_PROBE_ID &&
    (p.output as { value?: { genuine?: unknown } } | undefined)?.value?.genuine === true
  );
  if (!genuine) return fail("the genuine tool result was dropped");

  return { ok: true, detail: "pairing=positional (overlap probe: every call answered in place, genuine result kept)" };
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

/**
 * /health → checks.tool_call_input_shape. Pure, no I/O, no SDK: a JSON-string
 * input is repaired into an object, an unparseable one is dropped together
 * with its result, and a plain object is untouched. Its PRESENCE proves the
 * build; ok:false means the repair drifted.
 */
export function toolCallInputShapeSelfTest(disabled = false): { ok: boolean; detail: string } {
  if (disabled) return { ok: true, detail: `LEGACY via ${TOOL_CALL_INPUT_SHAPE_DISABLED_ENV} — a string tool_use.input is sent as-is (Anthropic 400s on it)` };
  const fixture = [
    { role: "user", content: "seed" },
    { role: "assistant", content: [
      { type: "tool-call", toolCallId: "ok", toolName: "a", input: { x: 1 } },
      { type: "tool-call", toolCallId: "str", toolName: "b", input: "{\"y\": 2}" },
      { type: "tool-call", toolCallId: "bad", toolName: "c", input: "{not json" },
    ] },
    { role: "tool", content: [
      { type: "tool-result", toolCallId: "ok", toolName: "a", output: { type: "text", value: "r" } },
      { type: "tool-result", toolCallId: "str", toolName: "b", output: { type: "text", value: "r" } },
      { type: "tool-result", toolCallId: "bad", toolName: "c", output: { type: "text", value: "input was not valid JSON" } },
    ] },
  ] as unknown as ModelMessage[];
  const { out, inputRepaired, inputDropped } = sanitizeCore(fixture, true);
  const calls: AnyPart[] = [];
  const results: AnyPart[] = [];
  for (const m of out as AnyMsg[]) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as AnyPart[]) {
      if (p.type === "tool-call") calls.push(p);
      if (p.type === "tool-result") results.push(p);
    }
  }
  const everyInputIsObject = calls.every((c) => isPlainObject(c.input));
  const strRepaired = calls.some((c) => c.toolCallId === "str" && isPlainObject(c.input) && (c.input as Record<string, unknown>).y === 2);
  const badGone = !calls.some((c) => c.toolCallId === "bad") && !results.some((r) => r.toolCallId === "bad");
  const ok = everyInputIsObject && strRepaired && badGone && inputRepaired === 1 && inputDropped === 1 && results.length === 2;
  return {
    ok,
    detail: ok
      ? "a JSON-string tool_use.input is repaired to an object; an unparseable one is dropped with its result; no string input reaches the provider"
      : `drift: everyObject=${everyInputIsObject} strRepaired=${strRepaired} badGone=${badGone} repaired=${inputRepaired} dropped=${inputDropped} results=${results.length}`,
  };
}
