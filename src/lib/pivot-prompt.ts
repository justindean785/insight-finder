/**
 * Recognise a pivot-run instruction in an analyst message so the transcript
 * can show it as a one-line chip instead of the full prompt template.
 *
 * Two builders write this shape: `findingDisplay` in `pivot-engine.ts`
 * ("Run this pivot.") and `extractRecommendedPivots` in `recommended-pivots.ts`
 * ("Run this high-priority pivot."). Both put the facts on `Action:`,
 * `Target:`, `Type:` and `Reason:` lines. The text sent to the agent is never
 * changed by this module; it is display parsing only, and anything that does
 * not match the shape exactly returns `null` and renders as ordinary text.
 */

export interface PivotPromptSummary {
  priority: string | null;
  action: string;
  target: string;
  type: string | null;
  reason: string | null;
}

const HEAD_RE = /^\s*Run this (?:([a-z]+)-priority )?pivot\.\s*$/i;

function field(lines: string[], name: string): string | null {
  const prefix = `${name}:`;
  const line = lines.find((l) => l.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value || null;
}

export function parsePivotPrompt(text: string): PivotPromptSummary | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const firstLine = lines.find((l) => l.length > 0);
  if (!firstLine) return null;
  const head = HEAD_RE.exec(firstLine);
  if (!head) return null;
  const action = field(lines, "Action");
  const target = field(lines, "Target");
  if (!action || !target) return null;
  return {
    priority: head[1] ? head[1].toLowerCase() : null,
    action,
    target,
    type: field(lines, "Type"),
    reason: field(lines, "Reason"),
  };
}
