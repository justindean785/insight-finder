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
