export type TerminalThreadUpdate = {
  status?: string | null;
  recovered_at?: string | null;
  recovery_reason?: string | null;
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
    if (bySignature) { adopted.add(bySignature.id); return bySignature; }
    return message;
  });

  return [...merged, ...persisted.filter((message) => !adopted.has(message.id))];
}
