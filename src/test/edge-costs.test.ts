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

  it("bills serus_darkweb_scan at its explicit darkweb rate, never the default floor", () => {
    // Tranche 1 hygiene: serus_darkweb_scan was missing a cost entry and silently
    // billed the $0.0002 default despite charging 0.25 Serus credits/scan.
    expect(costForTool("serus_darkweb_scan")).toBe(2500);
    expect(costForTool("serus_darkweb_scan")).not.toBe(DEFAULT_TOOL_COST_MICRO_USD);
  });

  it("bills the deprecated username_search alias identically to username_sweep (no duplicate-cost drift)", () => {
    expect(costForTool("username_search")).toBe(costForTool("username_sweep"));
    expect(costForTool("username_search")).toBe(0);
    expect(costForTool("username_search")).not.toBe(DEFAULT_TOOL_COST_MICRO_USD);
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

import {
  ANTHROPIC_RATES_MICRO_USD_PER_TOKEN,
  anthropicCostMicroUsd,
  anthropicRatesFor,
} from "../../supabase/functions/osint-agent/costs.ts";

// Anthropic orchestrator metering. Rates are the live platform.claude.com pricing (2026-10-13);
// micro-USD per token is numerically USD per MTok.
describe("anthropicCostMicroUsd", () => {
  it("prices all four buckets for Sonnet 5 ($2 in / $10 out / $0.20 read / $2.50 write per MTok)", () => {
    // 1M of each bucket => exactly the per-MTok prices summed.
    expect(anthropicCostMicroUsd("claude-sonnet-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }))
      .toBe(2e6 + 10e6 + 0.2e6 + 2.5e6);
  });

  it("bills cache reads at the cheap rate, not the input rate", () => {
    const cold = anthropicCostMicroUsd("claude-sonnet-5", { input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const warm = anthropicCostMicroUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 });
    expect(cold).toBe(200_000);
    expect(warm).toBe(20_000);
  });

  it("charges the 1.25x write premium once, then reads win", () => {
    const write = anthropicCostMicroUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 30_000 });
    const read = anthropicCostMicroUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 30_000, cacheWrite: 0 });
    expect(write).toBe(75_000);   // 30k * 2.5
    expect(read).toBe(6_000);     // 30k * 0.2
    expect(write + read).toBeLessThan(2 * 30_000 * 2); // two uncached sends would be 120_000
  });

  it("uses the model's own cache-read multiplier (Sonnet 5.5 is $0.10, Sonnet 5 is $0.20)", () => {
    expect(ANTHROPIC_RATES_MICRO_USD_PER_TOKEN["claude-sonnet-5-5"].cacheRead).toBe(0.1);
    expect(ANTHROPIC_RATES_MICRO_USD_PER_TOKEN["claude-sonnet-5"].cacheRead).toBe(0.2);
  });

  it("strips a dated snapshot suffix when looking up rates", () => {
    expect(anthropicRatesFor("claude-sonnet-5-20261001").known).toBe(true);
    expect(anthropicRatesFor("CLAUDE-SONNET-5").input).toBe(2);
  });

  it("meters an UNKNOWN model at the highest known rate (over-meter, never under-meter) and flags it", () => {
    const r = anthropicRatesFor("claude-brand-new-9");
    expect(r.known).toBe(false);
    const known = Object.values(ANTHROPIC_RATES_MICRO_USD_PER_TOKEN);
    expect(r.input).toBeGreaterThanOrEqual(Math.max(...known.map((k) => k.input)));
    expect(r.output).toBeGreaterThanOrEqual(Math.max(...known.map((k) => k.output)));
    expect(r.cacheRead).toBeGreaterThanOrEqual(Math.max(...known.map((k) => k.cacheRead)));
  });

  it("rounds to whole micro-USD and is zero for zero usage", () => {
    expect(anthropicCostMicroUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(Number.isInteger(anthropicCostMicroUsd("claude-sonnet-5", { input: 3, output: 1, cacheRead: 7, cacheWrite: 1 }))).toBe(true);
  });
});
