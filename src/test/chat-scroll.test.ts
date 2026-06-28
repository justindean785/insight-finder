import { describe, expect, it } from "vitest";
import {
  shouldFollowChatScroll,
  shouldAdoptInitialMessages,
  CHAT_REENGAGE_THRESHOLD_PX,
} from "@/lib/chat-scroll";

describe("shouldFollowChatScroll", () => {
  it("follows while the analyst remains near the bottom", () => {
    expect(shouldFollowChatScroll(2000, 1310, 600)).toBe(true);
  });

  it("stops following after the analyst scrolls upward", () => {
    expect(shouldFollowChatScroll(2000, 900, 600)).toBe(false);
  });

  it("resumes once the analyst returns to the bottom", () => {
    expect(shouldFollowChatScroll(2000, 1400, 600)).toBe(true);
  });

  // Re-engage band is intentionally tight: a small upward nudge must keep follow
  // DISENGAGED so a streaming pin can't yank the reader back down (BUG 1).
  it("does NOT re-engage at the wide near-bottom band", () => {
    // 90px from bottom — within the wide 96px follow band, but well outside the
    // tight re-engage band, so re-engagement must not fire here.
    expect(shouldFollowChatScroll(2000, 1310, 600, CHAT_REENGAGE_THRESHOLD_PX)).toBe(false);
  });

  it("re-engages only when essentially at the very bottom", () => {
    expect(shouldFollowChatScroll(2000, 1390, 600, CHAT_REENGAGE_THRESHOLD_PX)).toBe(true); // 10px out
    expect(shouldFollowChatScroll(2000, 1360, 600, CHAT_REENGAGE_THRESHOLD_PX)).toBe(false); // 40px out
  });
});

describe("shouldAdoptInitialMessages", () => {
  // BUG 2: a minimize→restore (or any re-render re-firing the re-seed effect)
  // must never replace a fuller live store with a stale/shorter DB snapshot.
  it("adopts the DB snapshot on first seed into an empty store", () => {
    expect(shouldAdoptInitialMessages(4, 0)).toBe(true);
  });

  it("adopts the DB snapshot when it has caught up (recovery on return)", () => {
    expect(shouldAdoptInitialMessages(2, 1)).toBe(true);
    expect(shouldAdoptInitialMessages(2, 2)).toBe(true);
  });

  it("refuses to clobber a fuller live store with a shorter snapshot", () => {
    expect(shouldAdoptInitialMessages(0, 4)).toBe(false);
    expect(shouldAdoptInitialMessages(2, 5)).toBe(false);
  });
});
