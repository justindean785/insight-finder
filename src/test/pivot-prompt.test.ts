import { describe, expect, it } from "vitest";
import { parsePivotPrompt } from "@/lib/pivot-prompt";

describe("parsePivotPrompt", () => {
  it("reads the pivot-engine template", () => {
    const text = "Run this pivot.\n\nAction: Review lead\nTarget: Darren Watkins Jr\nType: name\nReason: Name discovered via breach/profile lookup.\n\nUse authorized public-source methods only. Return corroborating sources and how this changes the case.";
    expect(parsePivotPrompt(text)).toEqual({
      priority: null,
      action: "Review lead",
      target: "Darren Watkins Jr",
      type: "name",
      reason: "Name discovered via breach/profile lookup.",
    });
  });

  it("reads the recommended-pivots template with a priority", () => {
    const text = "Run this high-priority pivot.\n\nAction: Verify username linkage\nTarget: jrnike123speedy\nType: username\nReason: One row.\n\nUse authorized public-source methods only.";
    const out = parsePivotPrompt(text);
    expect(out?.priority).toBe("high");
    expect(out?.target).toBe("jrnike123speedy");
    expect(out?.type).toBe("username");
  });

  it("returns null for ordinary analyst text", () => {
    expect(parsePivotPrompt("Run this pivot on the email please")).toBeNull();
    expect(parsePivotPrompt("investigate jordan@example.com")).toBeNull();
    expect(parsePivotPrompt("")).toBeNull();
  });

  it("returns null when the template is missing its target", () => {
    expect(parsePivotPrompt("Run this pivot.\n\nAction: Review lead\nType: name")).toBeNull();
  });
});
