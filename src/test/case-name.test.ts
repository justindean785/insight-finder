import { describe, expect, it } from "vitest";
import { humanCaseName } from "@/lib/case-name";

describe("humanCaseName", () => {
  const seed = "j.harker@northgate-logistics.com";

  it("returns the analyst's name for the case", () => {
    expect(humanCaseName("James Harker — logistics", seed, seed)).toBe("James Harker — logistics");
  });

  it("falls back (null) for blank and placeholder titles", () => {
    for (const t of [null, "", "  ", "New investigation", "new investigation", "Untitled"]) {
      expect(humanCaseName(t, seed, seed)).toBeNull();
    }
  });

  it("falls back when the title only repeats the selector", () => {
    expect(humanCaseName(seed, seed, seed)).toBeNull();
    expect(humanCaseName(" J.Harker@Northgate-Logistics.com ", seed, seed)).toBeNull();
    expect(humanCaseName("datatracera.com", "https://datatracera.com/", "datatracera.com")).toBeNull();
  });
});
