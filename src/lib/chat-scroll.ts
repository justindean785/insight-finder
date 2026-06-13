export const CHAT_FOLLOW_THRESHOLD_PX = 96;

export function shouldFollowChatScroll(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
