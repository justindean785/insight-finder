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
// normalizes it.
const SEP = "[｜|]";
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
