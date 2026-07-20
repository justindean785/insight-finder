/**
 * dsml-tool-call-guard.ts — recover tool calls DeepSeek emits as raw DSML markup
 * instead of structured tool_calls.
 *
 * WHY: DeepSeek V4/V4-Pro (this project's currently-pinned orchestrator) has a
 * documented, widely-reported quirk — under certain conditions (observed: several
 * parallel tool calls requested in one turn) it emits its tool-call intent as
 * plain assistant TEXT using an internal markup grammar:
 *
 *   <｜DSML｜tool_calls><｜DSML｜invoke name="http_fingerprint">
 *     <｜DSML｜parameter name="url" string="true">https://example.com</｜DSML｜parameter>
 *   </｜DSML｜invoke>...</｜DSML｜tool_calls>
 *
 * instead of the standard OpenAI-compatible `tool_calls` JSON field the AI SDK's
 * openai-compatible adapter parses natively. When this happens, the AI SDK sees
 * ZERO structured tool calls for the step — the raw markup is just streamed to the
 * client as ordinary text, so the analyst sees literal `<｜DSML｜...>` tokens in
 * the chat, and the model's actual intended tool calls never execute at all
 * (confirmed live: thread on seed "loadq.com", 4 well-formed intended calls —
 * http_fingerprint, serus_darkweb_scan, jina_reader_scrape, minimax_web_search —
 * rendered as raw markup, none executed).
 *
 * This is a known, reported DeepSeek issue (see e.g. deepseek-ai/DeepSeek-V4-Pro
 * HF discussion #209, CherryHQ/cherry-studio#14714) — not a code defect in this
 * project's design, and not something DeepSeek's own client-side SDKs reliably
 * parse either. The recommended mitigation (per the community) is to detect and
 * manually parse the markup client-side.
 *
 * RECOVERY, not just detection: the parsed calls are genuinely well-formed and
 * were fully intended by the model — discarding them and merely re-prompting
 * would waste a full model round-trip (the exact CPU-budget problem fixed
 * elsewhere tonight). Instead, index.ts executes the recovered calls directly
 * through the SAME wrapped tool pipeline (wrapToolsWithCache) used for normal
 * calls, so caching, circuit-breaking, tool_usage_log, and the per-call
 * auto-persist hook all apply identically — no lost work, no wasted retry.
 *
 * PURE / no I/O here: parsing only. Execution and message cleanup are the
 * caller's responsibility (index.ts), matching the codebase's existing
 * pure-guard-plus-wired-caller pattern (unknown-tool-guard.ts, orchestrator-finalize.ts).
 */

// DeepSeek's special-token separator is the FULLWIDTH VERTICAL LINE (U+FF5C, ｜),
// matching its other reserved tokens (e.g. <｜begin▁of▁sentence｜>). Accept a
// plain ASCII "|" too, defensively, in case a specific serving/gateway layer
// normalizes it. The "+" quantifier handles both single-separator (｜DSML｜)
// and double-separator (｜｜DSML｜｜) variants observed in different model versions.
const SEP = "[｜|]+";
const TOOL_CALLS_BLOCK_RE = new RegExp(`<${SEP}DSML${SEP}tool_calls>([\\s\\S]*?)<\\/${SEP}DSML${SEP}tool_calls>`, "i");
const INVOKE_RE = new RegExp(`<${SEP}DSML${SEP}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${SEP}DSML${SEP}invoke>`, "gi");
const PARAMETER_RE = new RegExp(`<${SEP}DSML${SEP}parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${SEP}DSML${SEP}parameter>`, "gi");
// Cheap presence check, tolerant of a missing/unterminated outer <tool_calls>
// wrapper — an unterminated block (truncated mid-stream) still has ≥1 <invoke>.
const ANY_DSML_RE = new RegExp(`<${SEP}DSML${SEP}(tool_calls|invoke|parameter)`, "i");

export type RecoveredDsmlCall = { name: string; args: Record<string, string> };

/** Cheap true/false check — safe to call on every step's text unconditionally. */
export function hasDsmlToolCallMarkup(text: string | null | undefined): boolean {
  if (!text) return false;
  return ANY_DSML_RE.test(text);
}

/**
 * Parse every `<｜DSML｜invoke>` block found in `text` into a structured call.
 * Prefers the content inside a `<｜DSML｜tool_calls>` wrapper if present, but
 * falls back to scanning the whole text for `<invoke>` blocks directly — a
 * truncated/malformed outer wrapper must not lose otherwise-parseable calls.
 * Never throws; a block that fails to parse is skipped, not fatal to the rest.
 */
export function parseDsmlToolCalls(text: string | null | undefined): RecoveredDsmlCall[] {
  if (!text) return [];
  const wrapped = TOOL_CALLS_BLOCK_RE.exec(text);
  const scope = wrapped ? wrapped[1] : text;
  const out: RecoveredDsmlCall[] = [];
  let invokeMatch: RegExpExecArray | null;
  INVOKE_RE.lastIndex = 0;
  while ((invokeMatch = INVOKE_RE.exec(scope)) !== null) {
    const name = invokeMatch[1]?.trim();
    if (!name) continue;
    const body = invokeMatch[2] ?? "";
    const args: Record<string, string> = {};
    let paramMatch: RegExpExecArray | null;
    PARAMETER_RE.lastIndex = 0;
    while ((paramMatch = PARAMETER_RE.exec(body)) !== null) {
      const paramName = paramMatch[1]?.trim();
      if (!paramName) continue;
      // Values are plain text content (already HTML-decoded by the model /
      // transport); unescape the handful of entities a model might still emit.
      const raw = (paramMatch[2] ?? "").trim();
      args[paramName] = raw
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    out.push({ name, args });
  }
  return out;
}

/** Strip DSML tool-call markup from persisted text, replacing it with a short,
 *  honest note — so historical chat views never show raw internal tokens. Safe
 *  no-op when no markup is present. */
export function stripDsmlToolCallMarkup(text: string): string {
  if (!hasDsmlToolCallMarkup(text)) return text;
  const withoutWrapped = text.replace(TOOL_CALLS_BLOCK_RE, "");
  // Also remove any stray invoke/parameter blocks outside a (missing/truncated)
  // wrapper, then any leftover bare closing/opening tags.
  return withoutWrapped
    .replace(INVOKE_RE, "")
    .replace(new RegExp(`<\\/?${SEP}DSML${SEP}[a-z_]*[^>]*>`, "gi"), "")
    .trim();
}

// Cap on how many recovered calls a single step will execute — defense against
// a corrupted/adversarial block claiming an implausible number of invokes.
export const MAX_DSML_RECOVERED_CALLS_PER_STEP = 8;

/**
 * Every DSML parameter value is parsed as a plain string (its `string="true"`/
 * `"false"` attribute is currently ignored by the parser). Zod schemas that
 * declare a non-string field (e.g. `num_results: z.number()`) will reject the
 * literal string "10" even though the model clearly intended the number 10.
 *
 * Security-review fix: the caller (index.ts) validates recovered args against
 * the target tool's REAL inputSchema before executing — never bypassed — so
 * this coercion cannot itself let anything invalid through; it only gives a
 * second, schema-checked chance to values that are legitimately typed but
 * arrived as markup text. Only whole-value JSON parses are attempted (a value
 * that parses to a number/boolean/array/object) — free-text values (URLs,
 * search terms) that aren't valid JSON pass through unchanged.
 */
export function coerceDsmlArgsForValidation(args: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    try {
      const parsed = JSON.parse(value);
      out[key] = (typeof parsed === "number" || typeof parsed === "boolean" || parsed === null || typeof parsed === "object")
        ? parsed
        : value;
    } catch {
      out[key] = value;
    }
  }
  return out;
}

type DsmlToolLike = {
  execute?: unknown;
  inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown } };
};

export type DsmlExecutionDecision =
  | { call: RecoveredDsmlCall; action: "execute"; validatedArgs: unknown }
  | { call: RecoveredDsmlCall; action: "reject"; reason: "not permitted in current phase" | "unknown tool" | "schema validation failed" };

/**
 * Pure decision function for recovered DSML calls — separated from execution
 * (index.ts) so the three safety guards are independently unit-testable
 * without a live tool pipeline:
 *   1. Phase allowlist — call.name must be in `permittedNames` (the tool set
 *      actually permitted for the step that just ran; during a finalize
 *      phase this is the phase's restricted set, e.g. only record_artifacts /
 *      finalize_no_findings — NOT the full registry).
 *   2. Registry check — call.name must exist in `tools` with a real execute.
 *   3. Schema validation — args must validate against the tool's REAL
 *      inputSchema, either as-parsed or after coerceDsmlArgsForValidation;
 *      a call that fails both is rejected, never executed (fail closed).
 * Never throws. Order matches the safety rationale: least-trusted check
 * (is this call even allowed right now) first.
 */
export function resolveDsmlExecutionPlan(
  calls: RecoveredDsmlCall[],
  permittedNames: ReadonlySet<string>,
  tools: Record<string, DsmlToolLike>,
): DsmlExecutionDecision[] {
  return calls.map((call) => {
    if (!permittedNames.has(call.name)) {
      return { call, action: "reject", reason: "not permitted in current phase" };
    }
    const tool = tools[call.name];
    if (!tool || typeof tool.execute !== "function") {
      return { call, action: "reject", reason: "unknown tool" };
    }
    if (!tool.inputSchema?.safeParse) {
      return { call, action: "execute", validatedArgs: call.args };
    }
    const direct = tool.inputSchema.safeParse(call.args);
    if (direct.success) return { call, action: "execute", validatedArgs: direct.data };
    const coerced = tool.inputSchema.safeParse(coerceDsmlArgsForValidation(call.args));
    if (coerced.success) return { call, action: "execute", validatedArgs: coerced.data };
    return { call, action: "reject", reason: "schema validation failed" };
  });
}
