/**
 * lib/evidence-record-persist.ts — #479. Composes the parts array that actually
 * gets stored, guaranteeing the authoritative Evidence Record survives.
 *
 * Kept SEPARATE from lib/evidence-record.ts on purpose: that module must stay
 * import-free so vitest can load it to pin the confidence ladder against
 * src/lib/confidence-tier.ts. This one imports safety.ts, so it can never be part
 * of that seam.
 *
 * WHY RESERVATION AND NOT ORDERING. capPartsSize's final stage (safety.ts:450)
 * concatenates every text/reasoning part and binary-searches a PREFIX of the
 * result. Appending the block and then capping means a long enough model narrative
 * silently deletes the authoritative record — the one part of the message that
 * must not be negotiable. So the rest of the message is capped against a REDUCED
 * budget first, and the record is merged afterwards. The arithmetic, not the
 * append order, is what makes the outcome safe:
 *
 *     size(cappedRest) <= maxBytes - reserve   ⇒   size(cappedRest + record) <= maxBytes
 *
 * The 500KB ceiling itself is unchanged; this only decides who gives way under it.
 */
import { capPartsSize, capToolPartPayloads, stripNulCharacters } from "../safety.ts";

const size = (x: unknown): number => new TextEncoder().encode(JSON.stringify(x)).length;

/** JSON punctuation, the "\n\n" join, and escape expansion in the merged string.
 *  Slack is cheap; an under-reservation is a silently truncated record. */
const RESERVE_SLACK = 2_048;

const isTextPart = (p: unknown): p is { type: "text"; text: string } => {
  const part = p as Record<string, unknown> | null;
  return !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string";
};

/**
 * Build the parts array to persist.
 *
 * Never mutates `parts`, and never mutates any element of it. That is invariant 3:
 * `resolveTerminalState` evaluates the same in-memory `finalMessages` afterwards,
 * so a run that did not earn a completed report cannot be handed one by this block.
 */
export function composePersistedParts(
  parts: unknown[],
  record: string,
  maxBytes: number,
): unknown[] {
  const input = Array.isArray(parts) ? parts : [];
  const text = typeof record === "string" ? record : "";
  if (!text) return stripNulCharacters(capPartsSize(capToolPartPayloads(input), maxBytes));

  // Reserve exactly what the record costs — no floor under the narrative's share
  // and no clamp on the reserve. Both were tried; both can push the total OVER
  // maxBytes when the record is large, and the ceiling is a hard DB constraint
  // (PostgREST silently 500s on multi-MB JSONB, which discards the whole report).
  // If the two ever genuinely compete, the authoritative record is the half that
  // must survive and the narrative is the half that gives way.
  const reserve = size(text) + RESERVE_SLACK;
  const budgetForRest = Math.max(0, maxBytes - reserve);

  const cappedRest = capPartsSize(capToolPartPayloads(input), budgetForRest);

  // Merge into the LAST text part rather than appending a new one:
  // useThreadMessages.ts:73 takes the last text part as the thread-list preview,
  // so a separate trailing part would replace the report's preview with the block's.
  const merged = [...cappedRest];
  let lastText = -1;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (isTextPart(merged[i])) { lastText = i; break; }
  }
  if (lastText === -1) {
    merged.push({ type: "text", text });
  } else {
    const part = merged[lastText] as { type: "text"; text: string };
    merged[lastText] = { ...part, text: `${part.text}\n\n${text}` };
  }

  return stripNulCharacters(merged);
}
