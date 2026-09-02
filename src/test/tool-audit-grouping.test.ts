import { describe, it, expect } from "vitest";
import { primaryToolSlug } from "@/lib/report-source-labels";

describe("primaryToolSlug", () => {
  it("keys every spelling of one tool to the same slug", () => {
    for (const s of [
      "username_sweep",
      "username_sweep analysis",
      "Username_Sweep/Instagram",
      "username_sweep (7 platforms)",
      "username_sweep + minimax_web_search",
      "USERNAME_SWEEP",
      ["username_sweep", "exa_search"],
    ]) expect(primaryToolSlug(s), String(s)).toBe("username_sweep");
  });
  it("keys free text with no slug as its own lowercase token", () => {
    expect(primaryToolSlug("LinkedIn")).toBe("linkedin");
    expect(primaryToolSlug("seed")).toBe("seed");
    expect(primaryToolSlug("user-provided")).toBe("user-provided");
  });
  it("never returns an empty key", () => {
    expect(primaryToolSlug("")).toBe("unknown");
    expect(primaryToolSlug(null)).toBe("unknown");
    expect(primaryToolSlug("   ")).toBe("unknown");
  });
});
