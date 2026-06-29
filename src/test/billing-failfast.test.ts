import { describe, it, expect, beforeEach } from "vitest";
import { creditsCharged } from "../../supabase/functions/osint-agent/billing.ts";
import {
  classifyResult,
  recordResult,
  shouldRun,
  clearThread,
} from "../../supabase/functions/osint-agent/circuit.ts";
import { summarizeRunCosts } from "@/lib/runCost";

// Covers the approved billing + fail-fast changes:
//   - charge credits ONLY on successful tool calls
//   - failed / timeout / dup-key calls cost 0
//   - first 502/504 trips the breaker so retries are blocked
//   - run summary separates charged cost from avoided failed-call cost

const COST = 10_000; // e.g. oathnet_lookup list price

describe("creditsCharged — charge only on successful calls", () => {
  it("1. failed API call charges 0 credits", () => {
    expect(creditsCharged({ ok: false, cached: false, free: false, baseCost: COST })).toBe(0);
  });

  it("2. timed-out call charges 0 credits", () => {
    // A timeout surfaces as a non-ok result (classifyResult → 'timeout').
    expect(classifyResult(null, new Error("request timed out"))).toBe("timeout");
    expect(creditsCharged({ ok: false, cached: false, free: false, baseCost: 1_500 })).toBe(0);
  });

  it("3. duplicate memory-save error charges 0 credits", () => {
    expect(creditsCharged({ ok: false, cached: false, free: false, baseCost: 200 })).toBe(0);
  });

  it("5. a successful call still charges the normal price", () => {
    expect(creditsCharged({ ok: true, cached: false, free: false, baseCost: COST })).toBe(COST);
  });

  it("never charges for cache hits or free/gated stubs (even if ok)", () => {
    expect(creditsCharged({ ok: true, cached: true, free: false, baseCost: COST })).toBe(0);
    expect(creditsCharged({ ok: true, cached: false, free: true, baseCost: COST })).toBe(0);
  });
});

describe("4. first 502/504 blocks retry spam for the same provider", () => {
  let thread = "";
  let n = 0;
  beforeEach(() => { thread = `t-${++n}-${Math.random()}`; clearThread(thread); });

  it("maps gateway statuses to distinct failure kinds", () => {
    expect(classifyResult({ ok: false, status: 502 }, null)).toBe("http_502");
    expect(classifyResult({ ok: false, status: 504 }, null)).toBe("http_504");
    expect(classifyResult({ ok: false, status: 503 }, null)).toBe("http_500"); // unchanged
  });

  it("disables the tool for the run after the FIRST 502", () => {
    expect(shouldRun(thread, "oathnet_lookup", "johnd@example.com").allow).toBe(true);
    recordResult(thread, "oathnet_lookup", "johnd@example.com", "default", { status: "http_502" });
    const d = shouldRun(thread, "oathnet_lookup", "another-selector");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/502/);
  });

  it("disables the tool for the run after the FIRST 504", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_504" });
    expect(shouldRun(thread, "stolentax_footprint", "sel").allow).toBe(false);
  });
});

describe("6. run summary separates charged vs avoided failed-call cost", () => {
  it("reproduces the johnd@example.com run shape", () => {
    // Rows mirror current tool_usage_log: cost_micro_usd is the attributed list
    // price while charged_micro_usd is actual billed credits.
    const rows = [
      { tool_name: "leakcheck_lookup", ok: true, cached: false, cost_micro_usd: 5_000, charged_micro_usd: 5_000 },
      { tool_name: "hunter_email_verifier", ok: true, cached: false, cost_micro_usd: 1_000, charged_micro_usd: 1_000 },
      { tool_name: "oathnet_lookup", ok: false, cached: false, cost_micro_usd: 10_000, charged_micro_usd: 0 }, // 502
      { tool_name: "stolentax_footprint", ok: false, cached: false, cost_micro_usd: 1_500, charged_micro_usd: 0 }, // 504
      { tool_name: "memory_save", ok: false, cached: false, cost_micro_usd: 200, charged_micro_usd: 0 }, // dup-key
      { tool_name: "hibp_lookup", ok: false, cached: false, cost_micro_usd: 0, charged_micro_usd: 0 }, // free
      { tool_name: "leakcheck_lookup", ok: true, cached: true, cost_micro_usd: 0, charged_micro_usd: 0 }, // cache hit
    ];
    const s = summarizeRunCosts(rows);
    expect(s.calls).toBe(7);
    expect(s.ok).toBe(3);
    expect(s.failed).toBe(4);
    expect(s.cached).toBe(1);
    expect(s.successful_cost_micro_usd).toBe(6_000); // 5000 + 1000
    expect(s.avoided_failed_cost_micro_usd).toBe(11_700); // 10000 + 1500 + 200
    expect(s.cost_micro_usd).toBe(6_000); // charged == successful
  });

  it("falls back for historical rows that only have attributed cost", () => {
    const s = summarizeRunCosts([
      { ok: true, cached: false, cost_micro_usd: 5_000 },
      { ok: false, cached: false, cost_micro_usd: 5_000 },
    ]);
    expect(s.successful_cost_micro_usd).toBe(5_000);
    expect(s.avoided_failed_cost_micro_usd).toBe(5_000);
    expect(s.cost_micro_usd).toBe(5_000);
  });

  it("handles an empty run", () => {
    expect(summarizeRunCosts([])).toMatchObject({
      calls: 0, ok: 0, failed: 0, cost_micro_usd: 0, avoided_failed_cost_micro_usd: 0,
    });
  });
});
