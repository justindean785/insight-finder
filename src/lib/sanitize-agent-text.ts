/**
 * Shared sanitizer for raw agent/model output before it is shown to a user.
 *
 * The OSINT agent occasionally emits chain-of-thought blocks (`<think>…</think>`
 * and siblings) inline in its message text. Those are model reasoning, not
 * findings, and must never reach a user-facing surface. The chat renderer
 * already strips them when rendering message bodies, but the **Next Steps**
 * cards parse the same raw text through `extractRecommendedPivots`, which had no
 * sanitization — so reasoning leaked into card titles/details (see screenshots).
 *
 * This module is the single source of truth so both surfaces stay in sync.
 *
 * Integrity note: this only removes model reasoning markup. It never alters,
 * strengthens, or weakens any finding, confidence, provenance, or claim.
 */

// Reasoning/scratchpad tag names the agent or upstream models may emit.
const REASONING_TAGS = ["think", "thinking", "reasoning", "scratchpad", "analysis", "internal", "plan"];
const TAG_GROUP = REASONING_TAGS.join("|");

// Closed block: <think>…</think> (any whitespace/case in the tag).
const CLOSED_BLOCK_RE = new RegExp(`<\\s*(?:${TAG_GROUP})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*(?:${TAG_GROUP})\\s*>`, "gi");
// Trailing unclosed block streaming in: <think>… (to end of string).
const OPEN_BLOCK_RE = new RegExp(`<\\s*(?:${TAG_GROUP})\\b[^>]*>[\\s\\S]*$`, "i");
// Any stray reasoning tag fragment (orphan open/close) left behind.
const STRAY_TAG_RE = new RegExp(`<\\s*/?\\s*(?:${TAG_GROUP})\\b[^>]*>`, "gi");

/**
 * Remove agent chain-of-thought blocks so raw reasoning never reaches the UI.
 * Drops closed blocks, any trailing unclosed block still streaming, and any
 * orphan reasoning tags, then collapses the whitespace the removal leaves.
 */
export function stripReasoningMarkup(text: string): string {
  if (!text) return "";
  return text
    .replace(CLOSED_BLOCK_RE, "")
    .replace(OPEN_BLOCK_RE, "")
    .replace(STRAY_TAG_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Tool-call markup (Phase C1) -------------------------------------------
// MiniMax sometimes writes raw tool-call syntax as literal TEXT into its
// assistant message — `<function_calls><invoke name="exify">…</invoke>`,
// stray `</invoke>` fragments while streaming, and "# Not a real tool"
// self-correction headings after it notices a hallucinated tool. None of that is
// a finding; it must never reach the chat timeline. (Structured, real tool calls
// arrive as separate `tool-*` parts and are unaffected — this only touches the
// text body.) antml:-prefixed variants are handled too.
// The distinctive Anthropic-style tool-call container tags the model leaks. We
// deliberately do NOT strip generic child tags like <parameter> on their own —
// they're removed as part of a block below, and a lone <parameter> can appear in
// legitimate prose about APIs. Tag name is bounded by (?![\w-]) so a real word
// like `<invoke-endpoint>` in report text is never mistaken for a tool call.
const TOOLCALL_TAGS = "invoke|function_calls|function_results";
// Whole <function_calls>…</function_calls> block (carries nested invoke/parameter).
const FN_CALLS_BLOCK_RE = /<\s*(?:antml:)?function_calls(?![\w-])[^>]*>[\s\S]*?<\s*\/\s*(?:antml:)?function_calls\s*>/gi;
// Standalone <invoke …>…</invoke> block (with its nested <parameter> children).
const INVOKE_BLOCK_RE = /<\s*(?:antml:)?invoke(?![\w-])[^>]*>[\s\S]*?<\s*\/\s*(?:antml:)?invoke\s*>/gi;
// Trailing UNCLOSED invoke/function_calls block still streaming in. Bounded to the
// next BLANK LINE (or end) — non-greedy — so it can't swallow a real finding that
// follows an example tool-call snippet in the same message.
const TOOLCALL_OPEN_RE = /<\s*(?:antml:)?(?:invoke|function_calls)(?![\w-])[^>]*>[\s\S]*?(?=\n[ \t]*\n|$)/i;
// Any stray tool-call container tag fragment (orphan open/close) left behind.
const TOOLCALL_STRAY_RE = new RegExp(`<\\s*/?\\s*(?:antml:)?(?:${TOOLCALL_TAGS})(?![\\w-])[^>]*>`, "gi");
// "# Not a real tool" self-correction HEADINGS the model emits after noticing a
// hallucinated tool. Anchored to a markdown heading (leading #) so a legitimate
// prose line that merely contains the phrase is never stripped.
const NOT_A_REAL_TOOL_RE = /^[ \t]{0,3}#{1,6}[ \t]+[^\n]*\bnot a real tool\b[^\n]*$/gim;
// Provider-namespaced tool-call containers leaked as literal text — e.g. MiniMax's
//   Now writing the final report: <minimax:tool_call>{…}</minimax:tool_call>
// (and stray/unclosed variants mid-stream). Same class as the <function_calls>/
// <invoke> leaks above, just a different vendor's syntax. Matches `<ns:tool_call>`
// where ns is a provider prefix (minimax, deepseek, …); the (?![\w-]) bound stops
// unrelated tags like `<x:tool_callback>` from ever matching. Structured/real tool
// calls arrive as separate `tool-*` parts and are untouched — this only cleans text.
const NS_TOOLCALL_BLOCK_RE = /<\s*[a-z][\w-]*:tool_call(?![\w-])[^>]*>[\s\S]*?<\s*\/\s*[a-z][\w-]*:tool_call\s*>/gi;
// Trailing UNCLOSED <ns:tool_call>… still streaming, bounded to the next blank line
// or end so it can't swallow a real finding that follows in the same message.
const NS_TOOLCALL_OPEN_RE = /<\s*[a-z][\w-]*:tool_call(?![\w-])[^>]*>[\s\S]*?(?=\n[ \t]*\n|$)/gi;
// Any stray namespaced tool_call tag fragment (orphan open/close) left behind.
const NS_TOOLCALL_STRAY_RE = /<\s*\/?\s*[a-z][\w-]*:tool_call(?![\w-])[^>]*>/gi;

/**
 * Remove raw tool-call markup the model leaked into its text body so it never
 * renders in the chat timeline. Order matters: drop full function_calls blocks
 * (which wrap invoke/parameter), then standalone invoke blocks, then any trailing
 * unclosed block, then stray tags and self-correction lines, then tidy whitespace.
 * Integrity note: purely a display cleanup — never alters a finding or claim.
 */
export function stripToolCallMarkup(text: string): string {
  if (!text) return "";
  return text
    .replace(FN_CALLS_BLOCK_RE, "")
    .replace(INVOKE_BLOCK_RE, "")
    .replace(NS_TOOLCALL_BLOCK_RE, "")
    .replace(TOOLCALL_OPEN_RE, "")
    .replace(NS_TOOLCALL_OPEN_RE, "")
    .replace(TOOLCALL_STRAY_RE, "")
    .replace(NS_TOOLCALL_STRAY_RE, "")
    .replace(NOT_A_REAL_TOOL_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Full sanitize for assistant TEXT shown in the chat timeline: strip reasoning
 * blocks AND leaked tool-call markup. Single entry point so the render path and
 * the copy-to-clipboard path stay in sync.
 */
export function sanitizeChatText(text: string): string {
  return stripToolCallMarkup(stripReasoningMarkup(text));
}

/**
 * Strip any residual angle-bracket tag fragments from a single short field
 * (a card title, detail, or reason). Defense-in-depth for the case where a
 * block boundary fell mid-line and a lone `<think>`/`</think>` survives, or the
 * agent emits other inline markup. Operates on one display field, not prose.
 */
export function stripInlineTags(field: string): string {
  if (!field) return "";
  return stripReasoningMarkup(field)
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Heuristic: does this candidate line look like leaked first-person reasoning
 * rather than a real recommendation? Used to drop reasoning lines that slipped
 * past block stripping (e.g. an unterminated think block split across parsing).
 */
const REASONING_LEAD_RE = /^(?:let me\b|let's\b|i'?ll\b|i should\b|i'?m going to\b|i need to\b|i'?ve\b|first,? i\b|now i\b|okay,? (?:so|let)|wait,)/i;

export function looksLikeReasoning(line: string): boolean {
  if (!line) return false;
  if (/<\s*\/?\s*(?:think|thinking|reasoning|scratchpad|analysis|internal)\b/i.test(line)) return true;
  return REASONING_LEAD_RE.test(line.trim());
}
