import { describe, it, expect } from "vitest";
import { cycleSummaryBadges, cycleSummaryLabel } from "@/components/ChatWindow";

/**
 * T10 (2026-10-21, JD's implementation checklist): failed calls stay
 * inspectable in the chat. This REVERSES the June beta rule (#120 / 7462ba4)
 * that hid them from the cycle cards only; the case bar, Overview and Tools
 * tab all show failures, so chat was the one surface hiding them.
 */
describe("cycleSummaryBadges — chat cycle cards", () => {
  it("shows failures as a chip, after completed work", () => {
    const badges = cycleSummaryBadges({ cached: 0, stale: 0, skipped: 2, useful: 9, failed: 4 });
    expect(badges).toEqual(["2 skipped", "9 completed", "4 failed"]);
  });

  it("still shows the other chips (cached / stale / skipped / completed) with no failures", () => {
    const badges = cycleSummaryBadges({ cached: 3, stale: 1, skipped: 0, useful: 5, failed: 0 });
    expect(badges).toEqual(["3 cached", "1 stale", "5 completed"]);
  });

  it("an all-failed cycle says so instead of rendering no chips", () => {
    const badges = cycleSummaryBadges({ cached: 0, stale: 0, skipped: 0, useful: 0, failed: 5 });
    expect(badges).toEqual(["5 failed"]);
  });
});

/**
 * Phase C2: a cycle whose number couldn't be resolved must never render a literal
 * "?" (the old "REVIEW CYCLE ?"). It shows just the stage instead.
 */
describe("cycleSummaryLabel — cycle header", () => {
  it("renders 'stage cycle N' when the cycle number is known", () => {
    expect(cycleSummaryLabel("Review", 3)).toBe("Review cycle 3");
  });

  it("never renders a literal '?' when the cycle number is unresolved", () => {
    for (const id of [-1, 0]) {
      const label = cycleSummaryLabel("Review", id);
      expect(label).toBe("Review");
      expect(label).not.toContain("?");
      expect(label.toLowerCase()).not.toContain("cycle");
    }
  });

  it("trims a stray-whitespace stage without leaving a dangling label", () => {
    expect(cycleSummaryLabel("  Triage  ", -1)).toBe("Triage");
  });
});
