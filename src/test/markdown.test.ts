import { describe, it, expect } from "vitest";
import { reflowCollapsedTables } from "@/lib/markdown";

describe("reflowCollapsedTables", () => {
  it("reflows a one-line collapsed findings table into proper rows", () => {
    // The exact shape the agent emits: header + separator + rows all on one line.
    const collapsed =
      "| Artifact | Label | Confidence | Source ||---|---|---|---|| jamie.park@example.com | CONFIRMED | 85 | 4-source breach |" +
      "| Onerich4life4 | CONFIRMED | 85 | username sweep |" +
      "| ohifearius | CONFIRMED | 90 | live SC scrape |";
    const out = reflowCollapsedTables(collapsed);
    const lines = out.split("\n").filter(Boolean);
    expect(lines[0]).toBe("| Artifact | Label | Confidence | Source |");
    expect(lines[1]).toBe("| --- | --- | --- | --- |");
    expect(lines[2]).toBe("| jamie.park@example.com | CONFIRMED | 85 | 4-source breach |");
    expect(lines[3]).toBe("| Onerich4life4 | CONFIRMED | 85 | username sweep |");
    expect(lines[4]).toBe("| ohifearius | CONFIRMED | 90 | live SC scrape |");
    // Every data row must be on its own line.
    expect(lines).toHaveLength(5);
  });

  it("keeps leading prose glued before the header on its own line", () => {
    const collapsed = "Findings| A | B ||---|---|| x | y |";
    const out = reflowCollapsedTables(collapsed);
    const lines = out.split("\n").filter(Boolean);
    expect(lines[0]).toBe("Findings");
    expect(lines[1]).toBe("| A | B |");
    expect(lines[2]).toBe("| --- | --- |");
    expect(lines[3]).toBe("| x | y |");
  });

  it("pads a short final row to the column count", () => {
    const out = reflowCollapsedTables("| A | B | C ||---|---|---|| 1 | 2 |");
    const lines = out.split("\n").filter(Boolean);
    expect(lines[lines.length - 1]).toBe("| 1 | 2 |  |");
  });

  it("leaves a correctly-formatted multi-line table untouched", () => {
    const good = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    expect(reflowCollapsedTables(good)).toBe(good);
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "This is a normal paragraph with a | pipe but no table.";
    expect(reflowCollapsedTables(prose)).toBe(prose);
    expect(reflowCollapsedTables("no pipes at all here")).toBe("no pipes at all here");
  });

  it("is a no-op on empty input", () => {
    expect(reflowCollapsedTables("")).toBe("");
  });
});
