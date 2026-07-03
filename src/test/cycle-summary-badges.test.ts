import { describe, it, expect } from "vitest";
import { cycleSummaryBadges, cycleSummaryLabel } from "@/components/ChatWindow";

/**
 * Beta-facing rule: the inline chat cycle cards must never surface a "failed"
 * chip — failed tool calls are kept in the group data but hidden from users.
 * This pins that down so the badge can't quietly come back.
 */
describe("cycleSummaryBadges — chat cycle cards", () => {
  it("never emits a 'failed' chip, even when failures are present", () => {
    // group still carries failed: 4 in its data; it must not appear as a chip.
    const badges = cycleSummaryBadges({
      cached: 0,
      stale: 0,
      skipped: 2,
      useful: 9,
      failed: 4,
    } as Parameters<typeof cycleSummaryBadges>[0] & { failed: number });
    expect(badges.some((b) => /failed/i.test(b))).toBe(false);
    expect(badges).toEqual(["2 skipped", "9 completed"]);
  });

  it("still shows the non-failure chips (cached / stale / skipped / completed)", () => {
    const badges = cycleSummaryBadges({ cached: 3, stale: 1, skipped: 0, useful: 5 });
    expect(badges).toEqual(["3 cached", "1 stale", "5 completed"]);
  });

  it("emits nothing when a cycle has only failures", () => {
    // an all-failed cycle (failed: 5, nothing else) shows no chips at all
    const badges = cycleSummaryBadges({
      cached: 0,
      stale: 0,
      skipped: 0,
      useful: 0,
      failed: 5,
    } as Parameters<typeof cycleSummaryBadges>[0] & { failed: number });
    expect(badges).toEqual([]);
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
