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
