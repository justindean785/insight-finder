/**
 * The right-hand Workbench's tabs (Case desk R3, 2026-11-02): one inspector
 * with Finding · Next pivots · Connections.
 *
 * Kept outside the component file so Fast Refresh keeps working there, and so
 * every caller that targets a tab — the `swarmbot:workbench-tab` event, the
 * folded-rail request in ChatPage — names it through one function.
 */
export type WorkbenchTab = "finding" | "pivots" | "connections";

/** Accepts the pre-R3 tab names (`live`, `sheet`, `next`) from older callers and events. */
export function normalizeWorkbenchTab(raw: unknown): WorkbenchTab | null {
  switch (raw) {
    case "finding": case "sheet": case "live": return "finding";
    case "pivots": case "next": return "pivots";
    case "connections": return "connections";
    default: return null;
  }
}
