import { describe, it, expect } from "vitest";
import { fmtWallClock } from "@/lib/duration";

/**
 * The Overview "Time in tools" stat split minutes from seconds by rounding the
 * remainder on its own, which lets the remainder reach 60 and print a figure
 * that cannot exist. Round the whole duration first, then split.
 */
describe("fmtWallClock", () => {
  it("carries instead of printing a 60-second remainder", () => {
    // 119.6s → the old `1m ${Math.round(59.6)}s` produced "1m 60s".
    expect(fmtWallClock(119_600)).toBe("2m 0s");
  });

  it("carries just under the minute mark instead of printing 60s", () => {
    expect(fmtWallClock(59_600)).toBe("1m 0s");
  });

  it("keeps the remainder that plain minute-rounding threw away", () => {
    // The defect this stat was added to fix: 87s must not collapse to "1m".
    expect(fmtWallClock(87_000)).toBe("1m 27s");
  });

  it("stays in seconds below a minute", () => {
    expect(fmtWallClock(310)).toBe("0s");
    expect(fmtWallClock(8_400)).toBe("8s");
    expect(fmtWallClock(59_000)).toBe("59s");
  });

  it("renders exact minutes without a bogus remainder", () => {
    expect(fmtWallClock(120_000)).toBe("2m 0s");
  });

  it("returns a dash for nothing measured", () => {
    expect(fmtWallClock(0)).toBe("—");
    expect(fmtWallClock(-1)).toBe("—");
    expect(fmtWallClock(Number.NaN)).toBe("—");
  });

  it("never emits a seconds field of 60 across a wide sweep", () => {
    for (let ms = 0; ms <= 600_000; ms += 137) {
      const out = fmtWallClock(ms);
      expect(out, `${ms}ms rendered ${out}`).not.toMatch(/\b60s$/);
    }
  });
});
