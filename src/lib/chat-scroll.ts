export const CHAT_FOLLOW_THRESHOLD_PX = 96;

/**
 * Tight band used to RE-ENGAGE auto-follow once the analyst returns to the
 * bottom. Much smaller than CHAT_FOLLOW_THRESHOLD_PX so that scrolling up even a
 * little keeps follow disengaged — re-engaging requires being essentially at the
 * very bottom, which (with the onScroll cooldown) stops a streaming pin from
 * snapping a scrolled-up reader back down.
 */
export const CHAT_REENGAGE_THRESHOLD_PX = 24;

export function shouldFollowChatScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Decide whether a freshly-loaded DB snapshot (`initialLen` messages) should
 * replace the current live useChat store (`currentLen` messages). The store can
 * legitimately hold MORE than the DB load — a reply that streamed but hasn't
 * been read back yet — so a shorter snapshot must never clobber it. Adopting the
 * snapshot only when it is at least as long is what keeps a minimize → restore
 * (or any re-render that re-fires the re-seed effect) from wiping chat history.
 */
export function shouldAdoptInitialMessages(initialLen: number, currentLen: number): boolean {
  return initialLen >= currentLen;
}
