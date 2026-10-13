// lib/history-label.ts — earlier assistant narrative is HISTORICAL MODEL OUTPUT.
//
// MITIGATION of authority escalation, not a report-integrity fix. The client replays
// the whole conversation each turn, so a prior assistant report — including claims
// ("same operator"), tier tags and tables the model wrote — re-enters the next run's
// context verbatim and unlabeled. Measured 2026-10-12: a phrase present in an earlier
// report reappeared in a later one while the report between them did not contain it.
// This does not prove the path, but nothing told the model the text was not evidence.
//
// WHAT IS LABELED: only `text` parts of `assistant` messages that PRECEDE the last user
// message — i.e. completed prior turns. NOT labeled: the last user message and anything
// after it (the current turn), `tool` messages, tool-call / tool-result / reasoning /
// any other part type, so tool-call → tool-result pairing is byte-identical.
//
// WHERE: the label is a HEAD prefix. Every text trim in the orchestrator keeps the head
// (`truncateStr` = slice(0, max)), at 16000/4000 for the initial trim and 12000/1500 per
// step, and the label is ~230 chars, so it survives all of them.
//
// Never mutates its input. Idempotent. KILL SWITCH (call time):
// MEMORY_AUTHORITY_WORDING_DISABLED=true returns the input untouched.

import { memoryAuthorityWordingDisabled } from "./memory-provenance.ts";

import { HISTORICAL_OUTPUT_LABEL } from "./historical-label.ts";
export { HISTORICAL_OUTPUT_LABEL };

interface MsgLike {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

const labeled = (text: string): string =>
  text.startsWith(HISTORICAL_OUTPUT_LABEL) ? text : HISTORICAL_OUTPUT_LABEL + text;

function labelContent(content: unknown): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    return content.length && !content.startsWith(HISTORICAL_OUTPUT_LABEL)
      ? { content: labeled(content), changed: true }
      : { content, changed: false };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const out = content.map((part) => {
    const p = part as { type?: string; text?: unknown } | null;
    if (p && p.type === "text" && typeof p.text === "string" && p.text.length > 0 && !p.text.startsWith(HISTORICAL_OUTPUT_LABEL)) {
      changed = true;
      return { ...(p as Record<string, unknown>), text: labeled(p.text) };
    }
    return part;
  });
  return changed ? { content: out, changed } : { content, changed };
}

export function labelHistoricalAssistantText<T extends MsgLike>(messages: ReadonlyArray<T>): T[] {
  const list = Array.isArray(messages) ? [...messages] : [];
  if (memoryAuthorityWordingDisabled()) return list;
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") { lastUser = i; break; }
  }
  // No user message at all: nothing is provably a completed prior turn.
  if (lastUser <= 0) return list;
  return list.map((m, i) => {
    if (i >= lastUser || m?.role !== "assistant") return m;
    const r = labelContent(m.content);
    return r.changed ? ({ ...m, content: r.content } as T) : m;
  });
}
