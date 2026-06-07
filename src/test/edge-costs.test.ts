import { describe, it, expect } from "vitest";
import {
  costForTool,
  microUsdToDollars,
  DEFAULT_TOOL_COST_MICRO_USD,
  TOOL_COSTS_MICRO_USD,
} from "../../supabase/functions/osint-agent/costs.ts";

// Per-tool cost attribution backs the honest $-per-investigation figure in the
// sidebar. Tested against the real edge module.

describe("costForTool", () => {
  it("returns the listed cost for a known tool", () => {
    expect(costForTool("exa_search")).toBe(8000);
    expect(costForTool("oathnet_lookup")).toBe(10000);
  });

  it("returns 0 for free/local tools", () => {
    expect(costForTool("username_sweep")).toBe(0);
    expect(costForTool("record_artifact")).toBe(0);
  });

  it("falls back to the default floor for unknown tools", () => {
    expect(costForTool("some_brand_new_tool")).toBe(DEFAULT_TOOL_COST_MICRO_USD);
    expect(costForTool("")).toBe(DEFAULT_TOOL_COST_MICRO_USD);
  });

  it("distinguishes a listed-zero tool from an unlisted one", () => {
    expect(costForTool("list_tools")).toBe(0);
    expect(costForTool("list_toolz")).toBe(DEFAULT_TOOL_COST_MICRO_USD);
  });
});

describe("TOOL_COSTS_MICRO_USD table", () => {
  it("has only non-negative integer costs", () => {
    for (const [name, cost] of Object.entries(TOOL_COSTS_MICRO_USD)) {
      expect(Number.isInteger(cost), `${name} should be an integer`).toBe(true);
      expect(cost, `${name} should be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("microUsdToDollars", () => {
  it("uses 4 decimals for sub-cent amounts", () => {
    expect(microUsdToDollars(200)).toBe("$0.0002");
    expect(microUsdToDollars(0)).toBe("$0.0000");
  });

  it("uses 3 decimals between 1c and $1", () => {
    expect(microUsdToDollars(50_000)).toBe("$0.050");
  });

  it("uses 2 decimals for >= $1", () => {
    expect(microUsdToDollars(1_500_000)).toBe("$1.50");
  });

  it("sums a realistic investigation cleanly", () => {
    const total = ["exa_search", "breach_check", "whois_lookup", "username_sweep"]
      .reduce((s, t) => s + costForTool(t), 0);
    expect(total).toBe(8000 + 3000 + 1000 + 0);
    expect(microUsdToDollars(total)).toBe("$0.012");
  });
});
