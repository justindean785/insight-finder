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

/** Merge durable DB messages into the live AI SDK store without discarding tool
 * activity that has streamed locally but has not been persisted as a message. */
export function mergePersistedChatMessages<T extends { id: string; role?: unknown; parts?: unknown }>(
  current: readonly T[],
  persisted: readonly T[],
): T[] {
  const persistedById = new Map(persisted.map((message) => [message.id, message]));
  const currentIds = new Set(current.map((message) => message.id));
  const currentSignatures = new Set(current.map((message) => JSON.stringify([message.role, message.parts])));
  return [
    ...current.map((message) => persistedById.get(message.id) ?? message),
    ...persisted.filter((message) =>
      !currentIds.has(message.id) &&
      !currentSignatures.has(JSON.stringify([message.role, message.parts]))
    ),
  ];
}
