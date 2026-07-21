/**
 * report-shape.ts — pure text-shape checks shared with the edge function's
 * orchestrator-finalize.ts (hasReportShape / stripReasoning). Kept as a
 * separate frontend copy (not a cross-runtime import — one is Deno, the
 * other is bundled by Vite) but MUST stay behaviorally identical; mirror any
 * future change to supabase/functions/osint-agent/orchestrator-finalize.ts here.
 */

const REASONING_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const REASONING_DANGLING_RE = /<think\b[^>]*>[\s\S]*$/i;

export function stripReasoning(text: string): string {
  return (text ?? "").replace(REASONING_BLOCK_RE, "").replace(REASONING_DANGLING_RE, "").trim();
}

/**
 * Frontend-only (NOT part of the orchestrator-finalize.ts mirror): strip
 * reasoning from each assistant text part BEFORE joining. The backend salvage
 * path appends the salvaged report as a NEW text part after a truncated turn's
 * parts; joining first lets an unclosed <think> in an earlier part swallow the
 * salvaged report via REASONING_DANGLING_RE (eats to end-of-string), which
 * blanked the report-shape gate and hid the Next steps panel.
 */
export function stripReasoningPerPart(texts: string[]): string {
  return texts.map((t) => stripReasoning(t)).filter(Boolean).join("\n");
}

// Positive signal that a closing REPORT (not just inter-step narration or a
// "Run interrupted" recovery stub) was written. Real reports carry a
// report/findings heading, a markdown findings table, or repeated tier
// labels ([Confirmed]/[Verify]/…). Any one qualifies.
const REPORT_HEADING_RE = /^\s{0,3}#{1,4}\s+.*\b(report|findings|summary|assessment|conclusion)\b/im;
const TABLE_SEPARATOR_RE = /\|\s*:?-{2,}/;
const TIER_LABEL_RE = /\[(confirmed(?:\s+owner)?|verify|likely|possible(?:\s+owner)?|weak|unverified|low)\]/gi;

export function hasReportShape(text: string): boolean {
  const t = text ?? "";
  if (REPORT_HEADING_RE.test(t)) return true;
  if (TABLE_SEPARATOR_RE.test(t)) return true;
  return (t.match(TIER_LABEL_RE) ?? []).length >= 2;
}

/**
 * AI SDK creates one text part per model step. Show one closing prose block,
 * not the concatenation of every intermediate "let me..." plan. Prefer the
 * final report-shaped part; while a run is still progressing, show its latest
 * non-empty status part.
 */
export function selectClosingAssistantProse(texts: string[]): string {
  const clean = (texts ?? []).map((text) => stripReasoning(text)).filter(Boolean);
  if (clean.length === 0) return "";
  const reports = clean.filter(hasReportShape);
  return reports.at(-1) ?? clean.at(-1) ?? "";
}
