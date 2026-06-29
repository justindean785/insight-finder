import { describe, expect, it } from "vitest";
import { tierOf, tierInfo, confidenceColor, type ConfidenceTier } from "@/lib/confidence-tier";

// confidence-tier.ts is the single source of truth for turning a 0–100
// confidence into a tier + color + label (evidence badges, graph nodes, report
// bars all derive from it). These tests lock the band boundaries and the
// number↔color↔label agreement so a future tweak can't silently shift a band.

describe("tierOf — band boundaries (display-only mapping)", () => {
  const cases: Array<[number, ConfidenceTier]> = [
    [100, "confirmed"], [90, "confirmed"],
    [89, "likely"], [75, "likely"],
    [74, "possible"], [55, "possible"],
    [54, "weak"], [35, "weak"],
    [34, "unverified"], [0, "unverified"],
  ];
  for (const [score, tier] of cases) {
    it(`${score} → ${tier}`, () => {
      expect(tierOf(score)).toBe(tier);
    });
  }

  it("null / undefined / NaN → unverified (never a confident band)", () => {
    expect(tierOf(null)).toBe("unverified");
    expect(tierOf(undefined)).toBe("unverified");
    expect(tierOf(Number.NaN)).toBe("unverified");
  });
});

describe("tierInfo / confidenceColor — number, color and label agree", () => {
  it("only Confirmed earns the verified glow", () => {
    expect(tierInfo(95).glow).toBe(true);
    for (const s of [80, 60, 40, 10]) expect(tierInfo(s).glow).toBe(false);
  });

  it("color resolves the tier's HSL var and matches confidenceColor()", () => {
    const info = tierInfo(80); // likely
    expect(info.label).toBe("Likely");
    expect(info.varName).toBe("--conf-likely");
    expect(info.color).toBe("hsl(var(--conf-likely))");
    expect(confidenceColor(80)).toBe(info.color);
  });

  it("unverified score yields the unverified descriptor (no false confidence)", () => {
    const info = tierInfo(null);
    expect(info.tier).toBe("unverified");
    expect(info.label).toBe("Unverified");
    expect(confidenceColor(null)).toBe("hsl(var(--conf-unverified))");
  });
});
