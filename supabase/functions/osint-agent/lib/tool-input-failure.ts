// lib/tool-input-failure.ts — a tool call the SDK rejected BEFORE `execute` ran is still a
// failed tool call, and it must leave a row.
//
// Measured on a live case (2026-10-06, 26 model tool calls): 3 were rejected by the AI SDK's
// input-schema validation — `socialfetch_lookup` sent `{query, platform}` (the schema wants
// `handle`), and `serus_darkweb_scan` / `memory_save` sent wrong field names. The SDK turns
// those into an `invalid` tool call plus a `tool-error` part and NEVER calls `execute`, so the
// cache wrapper's `logUsage` (which lives inside `execute`) never ran: no `tool_usage_log` row.
// The Activity tab then read "23 tools · Failed 0 of 23" while the invocation had made 26 calls,
// and an agent that keeps sending the wrong field name was invisible to every health surface.
//
// What this records, deliberately minimal and value-free:
//   • the tool name the model asked for
//   • the zod issues as `field (code)` — field PATHS and issue CODES only
//   • the KEY NAMES the model sent (e.g. `query`, `platform`) — never their values
// The SDK's own error message embeds the input VALUE ("Value: {…}"), i.e. the analyst's
// selector, so it is never stored. And no `input` is written to `input_json`: dead-target
// memory keys on `input_json.input`, and a malformed call says nothing about whether a TARGET
// is reachable, so it must not count against one.
//
// DIAGNOSTICS (value-free): a rejected call used to read "input rejected by schema: (unspecified)"
// for BOTH a schema rejection with no usable issue AND model output that was not valid JSON at all
// (AI_InvalidToolInputError > AI_JSONParseError > SyntaxError carries no zod issues), so the two
// were indistinguishable. Now:
//   • `invalid_json` is its own reason (the JSON text never parsed — truncation / garbling, not a schema fault);
//   • an `invalid_type` issue also reports `expected`/`received` as TYPE NAMES from a fixed allowlist
//     (`strict (invalid_type) [expected boolean, received string]`); every other issue code stays code-only,
//     because their `received`/`expected` fields can be VALUES (invalid_enum_value / invalid_literal);
//   • `error_chain` lists the error CLASS names (identifier characters only) so an unexplained rejection still says what kind;
//   • `sent_types` maps each sent key to its `typeof` token, `input_kind` names the shape of the whole input, and
//     `input_chars` is the length of a raw-text input — sizes and type names, never content.
//
// KILL SWITCH, read at CALL TIME: TOOL_INPUT_FAILURE_LOG_DISABLED=true.
// /health proof key: checks.tool_input_failure_log.

export function toolInputFailureLogDisabled(): boolean {
  return (Deno.env.get("TOOL_INPUT_FAILURE_LOG_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export type ToolInputFailureReason = "invalid_input" | "unknown_tool" | "unparsable_input" | "invalid_json";

export type ToolInputFailure = {
  toolName: string;
  reason: ToolInputFailureReason;
  /** `field (code)` per zod issue — paths and codes only, never values. */
  invalidFields: string[];
  /** Key names the model put in its input object — never values. */
  sentKeys: string[];
  /** Error CLASS names down the cause chain (e.g. AI_InvalidToolInputError > AI_JSONParseError) — never messages. */
  errorChain: string[];
  /** Type token per sent key (`string`, `number`, `boolean`, `object`, `array`, `null`, `undefined`) — never the value. */
  sentTypes: Record<string, string>;
  /** Shape of the whole input: an object, an array, raw text, or nothing. */
  inputKind: "object" | "array" | "text" | "empty" | "other";
  /** Length of a raw-text input, when it is text. A size, not content. */
  inputChars: number | null;
};

const MAX_ISSUES = 6;
const MAX_KEYS = 12;
const MAX_CHAIN = 5;
/** zod's parsed-type names — the ONLY values an `invalid_type` expected/received token may take. */
const ZOD_TYPE_NAMES = new Set([
  "string", "number", "integer", "float", "nan", "boolean", "bigint", "date", "symbol", "function",
  "undefined", "null", "array", "object", "map", "set", "promise", "void", "never", "unknown",
]);
const SEG_RE = /[^A-Za-z0-9_.[\]-]/g;

/** A short, log-safe token: identifier characters only, bounded. */
const tidy = (v: unknown, max = 48): string => String(v ?? "").replace(SEG_RE, "?").slice(0, max);

type AnyErr = { name?: unknown; issues?: unknown; cause?: unknown } & Record<string, unknown>;

/** Walk the `cause` chain (InvalidToolInputError → TypeValidationError → ZodError) for `issues`. */
function findIssues(err: unknown): Array<Record<string, unknown>> {
  let e = err as AnyErr | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    if (Array.isArray(e.issues)) return e.issues.filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
    e = e.cause as AnyErr | undefined;
  }
  return [];
}

/** A zod type NAME, or null. Anything not on the allowlist — in particular a VALUE — yields null. */
const typeToken = (v: unknown): string | null => (typeof v === "string" && ZOD_TYPE_NAMES.has(v) ? v : null);

function describeIssue(issue: Record<string, unknown>): string {
  const path = Array.isArray(issue.path) ? issue.path.map((p) => tidy(p, 32)).filter(Boolean).join(".") : "";
  const code = tidy(issue.code ?? "invalid", 32);
  // An unrecognised-key issue names the fields the model INVENTED — field names, not values.
  if (code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    return `unrecognized: ${issue.keys.slice(0, 6).map((k) => tidy(k, 32)).join("|")} (${code})`;
  }
  const base = `${path || "(input)"} (${code})`;
  // Only `invalid_type` has type NAMES in expected/received. For invalid_enum_value / invalid_literal the same
  // fields hold VALUES, so no other code is ever annotated.
  if (code === "invalid_type") {
    const expected = typeToken(issue.expected);
    const received = typeToken(issue.received);
    if (expected && received) return `${base} [expected ${expected}, received ${received}]`;
    if (expected) return `${base} [expected ${expected}]`;
  }
  return base;
}

/** Class names down the cause chain, bounded, identifier characters only. Never `message`. */
function errorChain(err: unknown): string[] {
  const out: string[] = [];
  let e = err as AnyErr | undefined;
  for (let depth = 0; e && typeof e === "object" && depth < MAX_CHAIN; depth++) {
    const name = tidy(e.name, 40);
    if (name) out.push(name);
    e = e.cause as AnyErr | undefined;
  }
  return out;
}

const tokenOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : v === undefined ? "undefined" : typeof v === "object" ? "object" : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? typeof v : "other";

/**
 * The invalid tool calls in one step's `toolCalls`. A valid call (`invalid` absent/false) is
 * never returned, so a clean step yields []. Pure, never throws, and reads no value from the
 * model's input beyond its key names.
 */
export function collectToolInputFailures(toolCalls: unknown): ToolInputFailure[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: ToolInputFailure[] = [];
  for (const call of toolCalls) {
    try {
      const c = call as { invalid?: unknown; toolName?: unknown; input?: unknown; error?: unknown } | null;
      if (!c || c.invalid !== true) continue;
      const errName = String((c.error as { name?: unknown } | undefined)?.name ?? "");
      const issues = findIssues(c.error);
      const chain = errorChain(c.error);
      // Model output that never parsed as JSON has NO zod issues; it is not a schema fault.
      const jsonParseFailure = issues.length === 0 && chain.some((n) => /JSONParse/i.test(n));
      const reason: ToolInputFailureReason = /NoSuchTool/i.test(errName)
        ? "unknown_tool"
        : jsonParseFailure
        ? "invalid_json"
        : issues.length > 0 || /InvalidToolInput/i.test(errName)
        ? "invalid_input"
        : "unparsable_input";
      const input = c.input && typeof c.input === "object" && !Array.isArray(c.input)
        ? (c.input as Record<string, unknown>)
        : null;
      const sentTypes: Record<string, string> = {};
      if (input) for (const k of Object.keys(input).slice(0, MAX_KEYS)) sentTypes[tidy(k, 32)] = tokenOf(input[k]);
      const inputKind: ToolInputFailure["inputKind"] = input
        ? "object"
        : Array.isArray(c.input)
        ? "array"
        : typeof c.input === "string"
        ? (c.input.length === 0 ? "empty" : "text")
        : c.input == null
        ? "empty"
        : "other";
      out.push({
        toolName: tidy(c.toolName, 64) || "(unknown)",
        reason,
        invalidFields: issues.slice(0, MAX_ISSUES).map(describeIssue),
        sentKeys: input ? Object.keys(input).slice(0, MAX_KEYS).map((k) => tidy(k, 32)) : [],
        errorChain: chain,
        sentTypes,
        inputKind,
        inputChars: typeof c.input === "string" ? c.input.length : null,
      });
    } catch { /* a malformed call part must never break the step */ }
  }
  return out;
}

/** The `error_msg` for the row. Must classify as `failed` (see tool-outcome.ts): no skip/empty words. */
export function inputFailureMessage(f: ToolInputFailure): string {
  if (f.reason === "unknown_tool") return `tool does not exist: ${f.toolName}`;
  if (f.reason === "unparsable_input") return `input could not be parsed for ${f.toolName}`;
  if (f.reason === "invalid_json") return `input was not valid JSON for ${f.toolName}: the tool-call text did not parse`;
  if (f.invalidFields.length > 0) return `input rejected by schema: ${f.invalidFields.join(", ")}`;
  // A rejection with no field-level issue: say what kind of error it was instead of "(unspecified)".
  return `input rejected, no field-level issue reported${f.errorChain.length ? ` (${f.errorChain.join(" > ")})` : ""}`;
}

/** A `tool_usage_log` row for one rejected call. Free, instant, and carries NO `input`. */
export function buildInputFailureRow(
  f: ToolInputFailure,
  ctx: { userId: string; threadId: string; stepNumber?: number },
): Record<string, unknown> {
  return {
    user_id: ctx.userId,
    thread_id: ctx.threadId,
    tool_name: f.toolName,
    cost_micro_usd: 0,
    charged_micro_usd: 0,
    cached: false,
    ok: false,
    outcome: "failed",
    duration_ms: 0,
    error_msg: inputFailureMessage(f),
    status_code: null,
    input_json: {
      runtime: {
        rejection_source: "sdk_input_validation",
        rejection_reason: f.reason,
        ...(ctx.stepNumber !== undefined ? { step: ctx.stepNumber } : {}),
        invalid_fields: f.invalidFields,
        sent_keys: f.sentKeys,
        sent_types: f.sentTypes,
        input_kind: f.inputKind,
        ...(f.inputChars !== null ? { input_chars: f.inputChars } : {}),
        error_chain: f.errorChain,
      },
    },
  };
}

/** Rows for a whole step; [] when the switch is thrown or nothing was rejected. */
export function inputFailureRowsForStep(
  toolCalls: unknown,
  ctx: { userId: string; threadId: string; stepNumber?: number },
): Array<Record<string, unknown>> {
  if (toolInputFailureLogDisabled()) return [];
  return collectToolInputFailures(toolCalls).map((f) => buildInputFailureRow(f, ctx));
}

/** `/health` → `checks.tool_input_failure_log`. Presence of the key proves this build is deployed. */
export function toolInputFailureSelfTest(): { ok: boolean; detail: string } {
  if (toolInputFailureLogDisabled()) return { ok: true, detail: "LEGACY via TOOL_INPUT_FAILURE_LOG_DISABLED" };
  const rows = inputFailureRowsForStep(
    [
      { type: "tool-call", toolName: "demo_tool", input: { query: "SECRET-VALUE", platform: "x" }, invalid: true,
        error: { name: "AI_InvalidToolInputError", cause: { name: "AI_TypeValidationError", cause: { name: "ZodError", issues: [{ code: "invalid_type", path: ["handle"], expected: "string", received: "undefined", message: "Required" }, { code: "invalid_enum_value", path: ["mode"], received: "SECRET-ENUM", options: ["a", "b"], message: "Invalid enum value" }] } } } },
      { type: "tool-call", toolName: "fine_tool", input: { handle: "a" } },
      // model output that never parsed as JSON: its input is the RAW TEXT, which must never be stored
      { type: "tool-call", toolName: "demo_tool", input: "{not json SECRET-RAW", invalid: true,
        error: { name: "AI_InvalidToolInputError", cause: { name: "AI_JSONParseError", text: "{not json SECRET-RAW", cause: { name: "SyntaxError" } } } },
    ],
    { userId: "u", threadId: "t", stepNumber: 1 },
  );
  const row = rows[0] as { error_msg?: string; outcome?: string; input_json?: Record<string, unknown> } | undefined;
  const jsonRow = rows[1] as { error_msg?: string; input_json?: { runtime?: Record<string, unknown> } } | undefined;
  const wrong: string[] = [];
  if (rows.length !== 2) wrong.push(`expected 2 rows, got ${rows.length}`);
  if (row?.outcome !== "failed") wrong.push("row is not outcome=failed");
  if (!row?.error_msg?.includes("handle (invalid_type) [expected string, received undefined]")) wrong.push("field path/code/type tokens missing");
  if (!row?.error_msg?.includes("mode (invalid_enum_value)")) wrong.push("enum issue not reported by code");
  if (JSON.stringify(rows).includes("SECRET")) wrong.push("an input VALUE leaked into a row");
  if (row && "input" in (row.input_json ?? {})) wrong.push("row carries an `input` (would count toward dead-target memory)");
  if (jsonRow?.input_json?.runtime?.rejection_reason !== "invalid_json") wrong.push("a JSON parse failure is not reported as invalid_json");
  if (jsonRow?.error_msg?.includes("rejected by schema")) wrong.push("a JSON parse failure is still blamed on the schema");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: "SDK-rejected tool calls are logged as failed with field paths, type names, error classes + sent key names only (no values, no input); invalid JSON is told apart from a schema rejection" };
}
