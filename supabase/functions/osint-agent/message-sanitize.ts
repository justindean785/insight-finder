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
 *   - HTTP 400 `tool_use.input: Input should be an object` (Anthropic) — caused
 *     by an assistant tool-call whose `input` is not a JSON object. A tool call
 *     whose input never parsed is persisted as a UI part with `rawInput` (the
 *     raw text) and `convertToModelMessages` rebuilds it with that STRING as
 *     `input`. The SDK schema types `input` as unknown, so nothing client-side
 *     objects, and `@ai-sdk/anthropic` copies it verbatim into `tool_use.input`.
 *     Measured 2026-10-14: 11 consecutive Anthropic runs died on it.
 *
 * These helpers are PURE apart from TWO structured `console.warn`s
 * (`sanitize_positional_pair_repair`, `tool_input_object_repair`, each emitted
 * only when that repair actually happens) and one call-time env read (the
 * TOOL_INPUT_OBJECT_REPAIR_DISABLED kill switch) — no other I/O, no SDK calls
 * — so they can be unit-tested against
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

// ---- Tool-call input must be a JSON object (Anthropic 400, 2026-10-14) -------

/** Kill switch, read at CALL time: TOOL_INPUT_OBJECT_REPAIR_DISABLED=true restores pass-through. */
export function toolInputObjectRepairDisabled(): boolean {
  try {
    return (Deno.env.get("TOOL_INPUT_OBJECT_REPAIR_DISABLED") ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

type InputKind = "text" | "empty" | "array" | "other";

/**
 * Guarantee a tool-call `input` is a plain JSON object. An object passes through
 * BY REFERENCE. A string that parses to an object is recovered as that object.
 * Anything else becomes a small, value-free marker object — never the raw text:
 *   - unparsable / non-object text → `{ _unparsed_input_chars: <length> }`
 *   - undefined / null / blank text → `{}`
 *   - array / number / boolean      → `{ _non_object_input: "<kind>" }`
 * The paired tool-result (which already says the call failed) is not touched.
 */
export function coerceToolCallInput(
  input: unknown,
): { input: Record<string, unknown>; repaired: boolean; kind?: InputKind } {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return { input: input as Record<string, unknown>, repaired: false };
  }
  if (typeof input === "string") {
    const text = input.trim();
    if (text === "") return { input: {}, repaired: true, kind: "empty" };
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { input: parsed as Record<string, unknown>, repaired: true, kind: "text" };
      }
    } catch { /* not JSON — fall through to the marker */ }
    return { input: { _unparsed_input_chars: input.length }, repaired: true, kind: "text" };
  }
  if (input == null) return { input: {}, repaired: true, kind: "empty" };
  if (Array.isArray(input)) return { input: { _non_object_input: "array" }, repaired: true, kind: "array" };
  return { input: { _non_object_input: typeof input }, repaired: true, kind: "other" };
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
 *   6. Every assistant tool-call `input` is a plain JSON object (see
 *      coerceToolCallInput) — unless TOOL_INPUT_OBJECT_REPAIR_DISABLED=true.
 *
 * Pure: returns a new array; does not mutate the input.
 */
export function sanitizeModelMessages(input: ModelMessage[]): ModelMessage[] {
  const { out, overlapRepairs, messages, inputRepairs, inputRepairKinds } = sanitizeCore(
    input,
    !toolInputObjectRepairDisabled(),
  );
  // Durable signal for the Anthropic `tool_use.input` 400: counts and KINDS only,
  // never an input value or a tool argument.
  if (inputRepairs > 0) {
    console.warn(JSON.stringify({
      event: "tool_input_object_repair",
      repaired_calls: inputRepairs,
      kinds: inputRepairKinds,
      messages,
    }));
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

type CoreResult = {
  out: ModelMessage[];
  overlapRepairs: number;
  messages: number;
  inputRepairs: number;
  inputRepairKinds: Record<string, number>;
};

/**
 * The repair itself, with no logging. Shared by sanitizeModelMessages and the
 * /health self-tests. `repairToolInputs` is passed in (not read here) so the
 * self-test exercises the repair regardless of the kill switch.
 */
function sanitizeCore(input: ModelMessage[], repairToolInputs = true): CoreResult {
  if (!Array.isArray(input)) {
    return { out: [], overlapRepairs: 0, messages: 0, inputRepairs: 0, inputRepairKinds: {} };
  }
  let inputRepairs = 0;
  const inputRepairKinds: Record<string, number> = {};

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

      if (p.type === "tool-call" && repairToolInputs) {
        const r = coerceToolCallInput(p.input);
        if (r.repaired) {
          inputRepairs++;
          const k = r.kind ?? "other";
          inputRepairKinds[k] = (inputRepairKinds[k] ?? 0) + 1;
          parts.push({ ...p, input: r.input });
          continue;
        }
      }

      // tool-call / reasoning / file / image / etc. → keep as-is.
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

  return { out, overlapRepairs, messages: cleaned.length, inputRepairs, inputRepairKinds };
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

const INPUT_PROBE_RAW = '{"artifacts":[{"kind":"email","val';

/**
 * /health `checks.tool_input_object_repair`: run the DEPLOYED sanitizer on a
 * fixed synthetic history whose tool-calls carry every non-object input shape
 * (truncated JSON text, JSON-object text, null, an array) plus one valid object,
 * and check that every replayed input is a plain object, the valid one is
 * untouched, the JSON text is recovered, the truncated text becomes the
 * value-free marker, and the failure result is kept. Pure and silent (non-logging
 * core, repair forced ON so the CODE is proven even while the switch is off);
 * `enabled` reports the kill switch separately. `sanitize` is injectable only so
 * a test can prove the probe catches a sanitizer that does not repair.
 */
export function toolInputObjectRepairSelfTest(
  sanitize: (m: ModelMessage[]) => ModelMessage[] = (m) => sanitizeCore(m, true).out,
): { ok: boolean; enabled: boolean; detail: string } {
  const enabled = !toolInputObjectRepairDisabled();
  const sw = enabled ? "" : " — DISABLED by TOOL_INPUT_OBJECT_REPAIR_DISABLED (inputs replay as-is)";
  const valid = { handle: "probe" };
  const calls: Array<[string, unknown]> = [
    ["p-text", INPUT_PROBE_RAW],
    ["p-json", '{"handle":"probe"}'],
    ["p-null", null],
    ["p-array", [1]],
    ["p-valid", valid],
  ];
  const fixture = [
    { role: "user", content: "probe" },
    ...calls.flatMap(([id, input]) => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "health_probe", input }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName: "health_probe",
          output: { type: "error-text", value: "probe failed" },
        }],
      },
    ]),
    { role: "user", content: "continue" },
  ] as unknown as ModelMessage[];
  let msgs: AnyMsg[];
  try {
    msgs = sanitize(fixture) as unknown as AnyMsg[];
  } catch (e) {
    return { ok: false, enabled, detail: `tool-input self-test threw: ${String(e).slice(0, 120)}${sw}` };
  }
  const fail = (why: string) => ({ ok: false, enabled, detail: `tool-input repair BROKEN: ${why}${sw}` });
  const parts = msgs.flatMap((m) => (Array.isArray(m?.content) ? (m.content as AnyPart[]) : []));
  const inputOf = (id: string) => parts.find((p) => p?.type === "tool-call" && p.toolCallId === id)?.input;
  for (const [id] of calls) {
    const v = inputOf(id);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return fail(`${id} input is not an object`);
  }
  if (inputOf("p-valid") !== valid) return fail("a valid object input was rewritten");
  if ((inputOf("p-json") as { handle?: unknown }).handle !== "probe") return fail("JSON-object text not recovered");
  if ((inputOf("p-text") as { _unparsed_input_chars?: unknown })._unparsed_input_chars !== INPUT_PROBE_RAW.length) {
    return fail("truncated text did not become the value-free marker");
  }
  const errorKept = parts.some((p) =>
    p?.type === "tool-result" && p.toolCallId === "p-text" &&
    (p.output as { type?: unknown } | undefined)?.type === "error-text"
  );
  if (!errorKept) return fail("the failure result was dropped");
  return {
    ok: true,
    enabled,
    detail: `tool-call input=object (probe: text→marker, json→object, null/array→object, valid untouched)${sw}`,
  };
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

// ---- Anthropic-bound prompt repair (E2b, 2026-10-15) ---------------------------
//
// GLM (the deepseek slot, OpenAI-compatible) and Anthropic accept DIFFERENT request
// shapes. History written while GLM drove a thread is valid for GLM and can be invalid
// for Anthropic, which validates the whole conversation on every request:
//
//   a. a whitespace-only text block -> "text content blocks must contain non-whitespace text";
//   b. a reasoning part from another provider carries no Anthropic signature, so
//      @ai-sdk/anthropic DROPS it (a warning, not an error); an assistant message whose
//      only content was that reasoning goes out EMPTY -> "all messages must have non-empty
//      content";
//   c. a tool_use id that occurs twice (the positional overlap repair above can produce
//      one: the same id answered in two places) -> "tool_use ids must be unique";
//   d. a tool_result that is not in the message immediately after its tool_use (a stray
//      result for an EARLIER call, or a tool message that lands after a user turn) ->
//      "unexpected tool_use_id found in tool_result blocks" / "tool_use ids were found
//      without tool_result blocks immediately after".
//
// These rules are applied ONLY to a prompt about to be sent to Anthropic (wired as model
// middleware: lib/orchestrator-fallback.ts -> anthropicBoundModel), at the provider-prompt
// level, so not one byte of a GLM / MiniMax / Gemini request changes. They only remove or
// rename what Anthropic would reject; a valid prompt comes back as the same array.
// Kill switch ANTHROPIC_PROMPT_REPAIR_DISABLED=true, read at call time.

/** Kill switch, read at CALL time: ANTHROPIC_PROMPT_REPAIR_DISABLED=true restores pass-through. */
export function anthropicPromptRepairDisabled(): boolean {
  try {
    return (Deno.env.get("ANTHROPIC_PROMPT_REPAIR_DISABLED") ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

const RESULT_UNAVAILABLE_PLACEHOLDER = "[tool result unavailable in this history]";

export interface AnthropicPromptRepairCounts {
  whitespace_text: number;
  foreign_reasoning: number;
  empty_message: number;
  duplicate_tool_id: number;
  invalid_tool_id: number;
  relocated_result: number;
  synthesized_result: number;
  stray_result: number;
}

/** A reasoning part Anthropic can replay: it carries an Anthropic signature or redacted data. */
function hasAnthropicReasoningMetadata(p: AnyPart): boolean {
  const po = p.providerOptions as Record<string, unknown> | undefined;
  const a = (po?.anthropic ?? null) as Record<string, unknown> | null;
  return !!a && (typeof a.signature === "string" || typeof a.redactedData === "string");
}

const ANTHROPIC_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Repair a provider-level prompt (LanguageModelV3Prompt, or a ModelMessage[]: the two
 * share every field read here) so Anthropic accepts it. Pure; the caller logs. Returns the
 * SAME array reference when nothing needed repair.
 *
 * Guarantees for user / assistant / tool messages in the returned prompt:
 *   - no whitespace-only text part (a);
 *   - no reasoning part without Anthropic metadata, and no message left empty (b);
 *   - every tool-call id is unique across the prompt and matches ^[a-zA-Z0-9_-]+$ (c);
 *   - every assistant message with tool calls is followed IMMEDIATELY by one tool message
 *     answering each of its calls in call order: the adjacent result if there is one, else
 *     the first unclaimed result with that id elsewhere (moved), else a value-free
 *     placeholder; a tool-result that no call claims is dropped (d).
 * System messages, file parts and tool-call inputs are never touched.
 */
export function repairAnthropicPrompt<T>(
  prompt: T[],
): { prompt: T[]; repairs: AnthropicPromptRepairCounts; changed: boolean } {
  const counts: AnthropicPromptRepairCounts = {
    whitespace_text: 0, foreign_reasoning: 0, empty_message: 0, duplicate_tool_id: 0,
    invalid_tool_id: 0, relocated_result: 0, synthesized_result: 0, stray_result: 0,
  };
  if (!Array.isArray(prompt)) return { prompt, repairs: counts, changed: false };

  // Pass 1: part-level cleanup (a, b) and empty-message removal.
  const cleaned: AnyMsg[] = [];
  for (const m of prompt as unknown as AnyMsg[]) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant" && m.role !== "tool")) {
      cleaned.push(m);
      continue;
    }
    if (!Array.isArray(m.content)) {
      if (typeof m.content === "string" && m.content.trim() === "" && m.role !== "tool") {
        counts.empty_message++;
        continue;
      }
      cleaned.push(m);
      continue;
    }
    let partsChanged = false;
    const parts: AnyPart[] = [];
    for (const p of m.content as AnyPart[]) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim() === "") {
        counts.whitespace_text++;
        partsChanged = true;
        continue;
      }
      if (m.role === "assistant" && p?.type === "reasoning" && !hasAnthropicReasoningMetadata(p)) {
        counts.foreign_reasoning++;
        partsChanged = true;
        continue;
      }
      parts.push(p);
    }
    if (parts.length === 0) {
      counts.empty_message++;
      continue;
    }
    cleaned.push(partsChanged ? { ...m, content: parts } : m);
  }

  // Pass 2: positional pairing (d) and id uniqueness (c) in ONE walk, so a renamed call
  // and its result can never disagree. Results are pooled by id first; each assistant then
  // claims, per call and in order, its adjacent result, else the first unclaimed one.
  type Pooled = { part: AnyPart; msgIndex: number; claimed: boolean };
  const pool = new Map<string, Pooled[]>();
  let totalResults = 0;
  cleaned.forEach((m, idx) => {
    if (m?.role !== "tool" || !Array.isArray(m.content)) return;
    for (const p of m.content as AnyPart[]) {
      if (p?.type !== "tool-result" || typeof p.toolCallId !== "string") continue;
      const list = pool.get(p.toolCallId) ?? [];
      list.push({ part: p, msgIndex: idx, claimed: false });
      pool.set(p.toolCallId, list);
      totalResults++;
    }
  });

  const usedIds = new Set<string>();
  const uniqueId = (raw: string): string => {
    let base = raw;
    if (!ANTHROPIC_TOOL_ID.test(base)) {
      counts.invalid_tool_id++;
      base = base.replace(/[^a-zA-Z0-9_-]/g, "_") || "toolu_unnamed";
    }
    let id = base;
    if (usedIds.has(id)) {
      counts.duplicate_tool_id++;
      let n = 2;
      while (usedIds.has(`${base}_dup${n}`)) n++;
      id = `${base}_dup${n}`;
    }
    usedIds.add(id);
    return id;
  };

  const out: AnyMsg[] = [];
  let claimedTotal = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i];
    if (m?.role === "tool" && Array.isArray(m.content)) {
      // Results are re-emitted by the assistant that claims them; anything else stays put.
      const others = (m.content as AnyPart[]).filter((p) => p?.type !== "tool-result");
      if (others.length > 0) out.push({ ...m, content: others });
      continue;
    }
    if (m?.role !== "assistant" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const calls = (m.content as AnyPart[]).filter((p) => p?.type === "tool-call" && !p.providerExecuted);
    if (calls.length === 0) {
      out.push(m);
      continue;
    }
    let adjEnd = i + 1;
    while (adjEnd < cleaned.length && cleaned[adjEnd]?.role === "tool") adjEnd++;
    const isAdjacent = (idx: number) => idx > i && idx < adjEnd;

    const renamed = new Map<AnyPart, string>();
    const results: AnyPart[] = [];
    for (const call of calls) {
      const originalId = typeof call.toolCallId === "string" ? call.toolCallId : "";
      const id = uniqueId(originalId);
      renamed.set(call, id);
      const candidates = pool.get(originalId) ?? [];
      let hit = candidates.find((c) => !c.claimed && isAdjacent(c.msgIndex));
      if (!hit) {
        hit = candidates.find((c) => !c.claimed);
        if (hit) counts.relocated_result++;
      }
      if (hit) {
        hit.claimed = true;
        claimedTotal++;
        results.push(id === originalId ? hit.part : { ...hit.part, toolCallId: id });
      } else {
        counts.synthesized_result++;
        results.push({
          type: "tool-result",
          toolCallId: id,
          toolName: typeof call.toolName === "string" ? call.toolName : "unknown",
          output: { type: "text", value: RESULT_UNAVAILABLE_PLACEHOLDER },
        });
      }
    }
    const anyRename = calls.some((c) => renamed.get(c) !== c.toolCallId);
    out.push(
      anyRename
        ? {
          ...m,
          content: (m.content as AnyPart[]).map((p) =>
            renamed.has(p) && renamed.get(p) !== p.toolCallId ? { ...p, toolCallId: renamed.get(p) } : p
          ),
        }
        : m,
    );
    out.push({ role: "tool", content: results });
  }
  counts.stray_result = totalResults - claimedTotal;

  const changed = Object.values(counts).some((n) => n > 0);
  // Nothing needed repair: hand back the caller's array untouched (pass 2 rebuilds tool
  // messages even when every result was already adjacent).
  if (!changed) return { prompt, repairs: counts, changed: false };
  return { prompt: out as unknown as T[], repairs: counts, changed: true };
}

/** Repair plus one value-free log line (counts only) when anything changed. */
export function sanitizeAnthropicPrompt<T>(prompt: T[]): T[] {
  if (anthropicPromptRepairDisabled()) return prompt;
  const r = repairAnthropicPrompt(prompt);
  if (r.changed) {
    console.warn(JSON.stringify({ event: "anthropic_prompt_repair", ...r.repairs, messages: r.prompt.length }));
  }
  return r.prompt;
}
