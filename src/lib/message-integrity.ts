// src/lib/message-integrity.ts — presentation-only facts about a PERSISTED assistant message.
//
// Measured on a production case (2026-10-07): an email-pivot message was saved with a text part "All"
// still marked state:"streaming" followed by an 8k-character text part with NO `state` field that began
// "# Findings Report: <the case's first domain>". The server had persisted the message before the model
// loop finished and its report-salvage step appended a case-wide report (index.ts, P0-B backstop). The
// analyst saw a sentence stop at "All," and then an unrelated report with no explanation.
//
// Nothing here changes what is stored, scored or generated. It only lets the UI SAY what the stored
// parts already show, using structural signals (the AI SDK's own part `state`), never prose inference.

export interface TextPartLike {
  type?: string;
  text?: string;
  state?: string;
}

export interface MessageIntegrity {
  /** A text part was saved while still streaming: the response was cut off. */
  interrupted: boolean;
  /** Text appended AFTER an interrupted part by something other than the model stream (it has no
   *  `state`). In the observed case this was the server's case-wide report salvage. */
  appendedAfterInterruption: boolean;
}

export function messageIntegrity(parts: ReadonlyArray<TextPartLike> | null | undefined, live: boolean): MessageIntegrity {
  const none = { interrupted: false, appendedAfterInterruption: false };
  // A message that is still streaming legitimately has a streaming part.
  if (live || !Array.isArray(parts)) return none;
  const texts = parts.filter((p) => p?.type === "text");
  const firstOpen = texts.findIndex((p) => p.state === "streaming");
  if (firstOpen === -1) return none;
  const appended = texts.slice(firstOpen + 1).some((p) => p.state === undefined && (p.text ?? "").trim().length > 0);
  return { interrupted: true, appendedAfterInterruption: appended };
}

/** The server's own Evidence Record line when no finding row was persisted for the run. */
const NO_AUTHORITATIVE_ROWS = /No authoritative finding rows were recorded/i;

/** True when the persisted record says nothing in the narrative was adjudicated by the scoring engine. */
export function narrativeIsUnadjudicated(prose: string): boolean {
  return NO_AUTHORITATIVE_ROWS.test(prose ?? "");
}
