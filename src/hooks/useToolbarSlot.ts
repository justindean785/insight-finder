import { createContext, useContext } from "react";

/**
 * A tab-level toolbar slot. The Evidence tab owns ONE toolbar row; the active
 * lens (e.g. the board's filter and sort) renders its controls into that row
 * through a portal instead of stacking a second toolbar beneath it.
 */
export const ToolbarSlotContext = createContext<HTMLElement | null>(null);

export function useToolbarSlot(): HTMLElement | null {
  return useContext(ToolbarSlotContext);
}
