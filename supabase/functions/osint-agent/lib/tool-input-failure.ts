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
// KILL SWITCH, read at CALL TIME: TOOL_INPUT_FAILURE_LOG_DISABLED=true.
// /health proof key: checks.tool_input_failure_log.

export function toolInputFailureLogDisabled(): boolean {
  return (Deno.env.get("TOOL_INPUT_FAILURE_LOG_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export type ToolInputFailureReason = "invalid_input" | "unknown_tool" | "unparsable_input";

export type ToolInputFailure = {
  toolName: string;
  reason: ToolInputFailureReason;
  /** `field (code)` per zod issue — paths and codes only, never values. */
  invalidFields: string[];
  /** Key names the model put in its input object — never values. */
  sentKeys: string[];
};

const MAX_ISSUES = 6;
const MAX_KEYS = 12;
const SEG_RE = /[^A-Za-z0-9_.\[\]-]/g;

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

function describeIssue(issue: Record<string, unknown>): string {
  const path = Array.isArray(issue.path) ? issue.path.map((p) => tidy(p, 32)).filter(Boolean).join(".") : "";
  const code = tidy(issue.code ?? "invalid", 32);
  // An unrecognised-key issue names the fields the model INVENTED — field names, not values.
  if (code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    return `unrecognized: ${issue.keys.slice(0, 6).map((k) => tidy(k, 32)).join("|")} (${code})`;
  }
  return `${path || "(input)"} (${code})`;
}

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
      const reason: ToolInputFailureReason = /NoSuchTool/i.test(errName)
        ? "unknown_tool"
        : issues.length > 0 || /InvalidToolInput/i.test(errName)
        ? "invalid_input"
        : "unparsable_input";
      const input = c.input && typeof c.input === "object" && !Array.isArray(c.input)
        ? (c.input as Record<string, unknown>)
        : null;
      out.push({
        toolName: tidy(c.toolName, 64) || "(unknown)",
        reason,
        invalidFields: issues.slice(0, MAX_ISSUES).map(describeIssue),
        sentKeys: input ? Object.keys(input).slice(0, MAX_KEYS).map((k) => tidy(k, 32)) : [],
      });
    } catch { /* a malformed call part must never break the step */ }
  }
  return out;
}

/** The `error_msg` for the row. Must classify as `failed` (see tool-outcome.ts): no skip/empty words. */
export function inputFailureMessage(f: ToolInputFailure): string {
  if (f.reason === "unknown_tool") return `tool does not exist: ${f.toolName}`;
  if (f.reason === "unparsable_input") return `input could not be parsed for ${f.toolName}`;
  return `input rejected by schema: ${f.invalidFields.join(", ") || "(unspecified)"}`;
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
        error: { name: "AI_InvalidToolInputError", cause: { name: "AI_TypeValidationError", cause: { name: "ZodError", issues: [{ code: "invalid_type", path: ["handle"], message: "Required" }] } } } },
      { type: "tool-call", toolName: "fine_tool", input: { handle: "a" } },
    ],
    { userId: "u", threadId: "t", stepNumber: 1 },
  );
  const row = rows[0] as { error_msg?: string; outcome?: string; input_json?: Record<string, unknown> } | undefined;
  const wrong: string[] = [];
  if (rows.length !== 1) wrong.push(`expected 1 row, got ${rows.length}`);
  if (row?.outcome !== "failed") wrong.push("row is not outcome=failed");
  if (!row?.error_msg?.includes("handle (invalid_type)")) wrong.push("field path/code missing");
  if (JSON.stringify(row).includes("SECRET-VALUE")) wrong.push("an input VALUE leaked into the row");
  if (row && "input" in (row.input_json ?? {})) wrong.push("row carries an `input` (would count toward dead-target memory)");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: "SDK-rejected tool calls are logged as failed with field paths + sent key names only (no values, no input)" };
}
