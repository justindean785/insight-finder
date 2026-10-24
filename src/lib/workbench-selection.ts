/**
 * The entity the analyst last selected in the Graph, handed to the Workbench's Connections tab.
 *
 * The Workbench lives beside Investigate and Report; the Graph is a different tab, so the two are never mounted at
 * once. A window event alone would be lost, so the selection is also kept in sessionStorage (per thread) and read
 * when the Workbench mounts. Storage can throw (private window, blocked site data): every access is guarded and the
 * Workbench works without it.
 */
const KEY = (threadId: string) => `proximity:selected-entity:${threadId}`;
export const SELECT_ENTITY_EVENT = "swarmbot:select-entity";

export function readSelectedEntity(threadId: string): string | null {
  try { return sessionStorage.getItem(KEY(threadId)); } catch { return null; }
}

export function publishSelectedEntity(threadId: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(KEY(threadId), id); else sessionStorage.removeItem(KEY(threadId));
  } catch { /* storage unavailable: the event below still reaches a mounted Workbench */ }
  window.dispatchEvent(new CustomEvent(SELECT_ENTITY_EVENT, { detail: { threadId, id } }));
}
