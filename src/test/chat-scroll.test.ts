import { describe, expect, it } from "vitest";
import { shouldFollowChatScroll } from "@/lib/chat-scroll";

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
});
