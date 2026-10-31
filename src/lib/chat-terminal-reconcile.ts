export type TerminalThreadUpdate = {
  status?: string | null;
  recovered_at?: string | null;
  recovery_reason?: string | null;
  updated_at?: string | null;
};

export function isTerminalThreadUpdate(row: TerminalThreadUpdate): boolean {
  return row.status === "finished" || row.status === "stopped";
}

/**
 * A normal `finished` update is emitted while the healthy response stream may
 * still be flushing its final report or error chunk to the browser. Aborting that
 * stream drops the exact response the analyst is waiting for. Only stale recovery
 * (identified by recovered_at) or an explicit analyst stop should abort it.
 */
export function shouldAbortClientStream(row: TerminalThreadUpdate): boolean {
  if (row.status === "stopped") return true;
  if (row.status !== "finished") return false;
  return Boolean(row.recovered_at);
}

/**
 * Identity of ONE message part, stable across the stream -> Postgres round-trip.
 *
 * The naive `JSON.stringify(parts)` is not message identity, and production
 * proved it: every assistant message rendered twice, once bare and once with a
 * timestamp. Two encodings of the same content differ whenever jsonb reorders
 * keys, or the live AI-SDK object carries a streaming-only field (`state`,
 * provider metadata) that was never persisted. Either difference defeats an
 * exact string compare and the DB copy is appended as a second message.
 *
 * So compare only what actually identifies the part and survives the trip: its
 * `type`, plus the text for a text part or the call id for a tool part. Key
 * order and SDK-only fields are deliberately ignored.
 */
function partSignature(part: unknown): string {
  if (!part || typeof part !== "object") return `raw ${String(part)}`;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  const body =
    typeof p.text === "string" ? p.text :
    typeof p.toolCallId === "string" ? p.toolCallId :
    "";
  return `${type} ${body}`;
}

/** Role + ordered part signatures. Role is included so an echoed user message
 *  and an assistant message with identical text never collapse together. */
function contentSignature(message: { role?: unknown; parts?: unknown }): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return JSON.stringify([message.role ?? null, parts.map(partSignature)]);
}

/** The ordered tool-call ids of a message. Each is unique to one call and is not
 *  touched by the stream -> Postgres round trip, so two copies of a tool-bearing
 *  message share them exactly. Empty for a message with no tool parts. */
function toolCallIdsOf(message: { parts?: unknown }): string[] {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const ids: string[] = [];
  for (const part of parts) {
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).toolCallId === "string") {
      ids.push((part as Record<string, string>).toolCallId);
    }
  }
  return ids;
}

/**
 * The heading every Evidence Record block starts with — including its
 * "unavailable" variants. MUST equal EVIDENCE_RECORD_HEADING in
 * supabase/functions/osint-agent/lib/evidence-record.ts (a test pins the two).
 */
export const EVIDENCE_RECORD_HEADING = "## Evidence Record — authoritative";

/**
 * Does `persisted` differ from `live` only by the ONE edit the server makes after
 * the stream ends? lib/evidence-record-persist.ts appends the "Evidence Record —
 * authoritative" block to the LAST text part (or adds a text part when there was
 * none). Every other part must match by partSignature.
 */
function extendsStreamedMessage(
  live: { role?: unknown; parts?: unknown },
  persisted: { role?: unknown; parts?: unknown },
): boolean {
  if (live.role !== persisted.role) return false;
  const a = Array.isArray(live.parts) ? live.parts : [];
  const b = Array.isArray(persisted.parts) ? persisted.parts : [];
  const isText = (p: unknown) => !!p && typeof p === "object" && (p as Record<string, unknown>).type === "text";
  let lastText = -1;
  for (let i = a.length - 1; i >= 0; i--) if (isText(a[i])) { lastText = i; break; }
  if (lastText === -1) {
    // No text part to merge into: the server pushes one at the end.
    return a.length > 0 && b.length === a.length + 1 && isText(b[b.length - 1]) &&
      String((b[b.length - 1] as Record<string, unknown>).text ?? "").startsWith(EVIDENCE_RECORD_HEADING) &&
      a.every((p, i) => partSignature(p) === partSignature(b[i]));
  }
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    if (i !== lastText) return partSignature(p) === partSignature(b[i]);
    const liveText = String((p as Record<string, unknown>).text ?? "");
    const storedText = isText(b[i]) ? String((b[i] as Record<string, unknown>).text ?? "") : null;
    // The server appends exactly `\n\n<Evidence Record block>`. Any other
    // extension — a restated or expanded answer — is a different message
    // (Codex P2 on #671).
    return storedText !== null && liveText.trim() !== "" &&
      storedText.startsWith(`${liveText}\n\n${EVIDENCE_RECORD_HEADING}`);
  });
}

/**
 * Are these two copies of ONE chat message — the live AI-SDK copy and its
 * durable row? Production 2026-10-01 (spearheadlab case): the whole run flow
 * rendered twice under "Superseded report", because the server appends the
 * Evidence Record block AFTER streaming, so the stored row's text no longer
 * matched the streamed copy and was appended as a second message.
 *
 * In order: the same id; the same part signatures; the same non-empty ordered
 * tool-call ids (unique per call, and the server never alters them); or the
 * stored copy is the streamed one plus the server's post-stream append.
 */
export function isSameChatMessage(
  a: { id?: unknown; role?: unknown; parts?: unknown },
  b: { id?: unknown; role?: unknown; parts?: unknown },
): boolean {
  if (a.id !== undefined && a.id === b.id) return true;
  if (a.role !== b.role) return false;
  if (contentSignature(a) === contentSignature(b)) return true;
  const idsA = toolCallIdsOf(a);
  if (idsA.length > 0) {
    const idsB = toolCallIdsOf(b);
    if (idsA.length === idsB.length && idsA.every((id, i) => id === idsB[i])) return true;
  }
  return extendsStreamedMessage(a, b);
}

/** Merge durable DB messages into the live AI SDK store without discarding tool
 * activity that has streamed locally but has not been persisted as a message.
 *
 * The persisted row WINS on a match: ChatWindow keys `setCreatedAtMap` on the DB
 * row id, so keeping the client-side copy is what leaves a message rendering
 * without its timestamp. */
export function mergePersistedChatMessages<T extends { id: string; role?: unknown; parts?: unknown }>(
  current: readonly T[],
  persisted: readonly T[],
): T[] {
  const persistedById = new Map(persisted.map((message) => [message.id, message]));
  const persistedBySignature = new Map<string, T>();
  for (const message of persisted) {
    const sig = contentSignature(message);
    if (!persistedBySignature.has(sig)) persistedBySignature.set(sig, message);
  }

  // Track which persisted rows were adopted in place, so the append pass below
  // cannot add the same row a second time.
  const adopted = new Set<string>();
  const merged = current.map((message) => {
    const byId = persistedById.get(message.id);
    if (byId) { adopted.add(byId.id); return byId; }
    const bySignature = persistedBySignature.get(contentSignature(message));
    if (bySignature && !adopted.has(bySignature.id)) { adopted.add(bySignature.id); return bySignature; }
    // Same message, but the server edited it after the stream (Evidence Record).
    const extended = persisted.find((row) => !adopted.has(row.id) && isSameChatMessage(message, row));
    if (extended) { adopted.add(extended.id); return extended; }
    return message;
  });

  return [...merged, ...persisted.filter((message) => !adopted.has(message.id))];
}

/**
 * Apply one realtime `messages` INSERT to the live store.
 *
 * - A row that is not already on screen is appended.
 * - A row that IS on screen replaces its live copy in place, so the message gains
 *   its durable id (its timestamp is keyed on it) and the server's Evidence Record
 *   — unless a stream is running. Mid-stream the AI SDK still owns the live copy
 *   by its client id, and swapping that id makes the next chunk append the
 *   message again; the terminal reconcile adopts the row once the run settles.
 *   (Codex P2 on #671.)
 */
export function applyRealtimeInsert<T extends { id: string; role?: unknown; parts?: unknown }>(
  current: readonly T[],
  row: T,
  streaming: boolean,
): T[] {
  const index = current.findIndex((message) => isSameChatMessage(message, row));
  if (index === -1) return [...current, row];
  if (streaming || current[index].id === row.id) return current as T[];
  const next = current.slice();
  next[index] = row;
  return next;
}
