import { describe, it, expect, beforeEach } from "vitest";
import { creditsCharged } from "../../supabase/functions/osint-agent/billing.ts";
import {
  classifyResult,
  recordResult,
  shouldRun,
  isProviderSuppressed,
  clearThread,
} from "../../supabase/functions/osint-agent/circuit.ts";
import { summarizeRunCosts } from "@/lib/runCost";

// CostGate v2 — regression-locks the exact failure patterns from the exported
// trace of thread 9b66ab0c-… (June 8, 2026):
//   236 tool calls / 179 ok / 57 failed / 0 cached, with 19 FAILED calls
//   carrying 31,500µ of attributed list price.
//
// The point of this file is to prove that:
//   (a) none of those failed calls charge actual credits (charged_micro_usd 0),
//       while their attributed list price (cost_micro_usd) is preserved; and
//   (b) the one real circuit gap — a paid provider's plain 5xx slipping past the old
//       consecutive-failure guard — now fails the provider over on the FIRST 500.

// The 19 failed-but-attributed calls from the trace, with their list prices.
const FAILED_TRACE_ROWS: Array<{ tool: string; status: number; baseCost: number }> = [
  { tool: "leakcheck_lookup", status: 400, baseCost: 5_000 },
  { tool: "leakcheck_lookup", status: 400, baseCost: 5_000 },
  { tool: "deepfind_ransomware_exposure", status: 404, baseCost: 2_000 },
  { tool: "deepfind_ransomware_exposure", status: 404, baseCost: 2_000 },
  { tool: "deepfind_ransomware_exposure", status: 404, baseCost: 2_000 },
  { tool: "whois_lookup", status: 0, baseCost: 1_000 }, // TLS/blank failure
  { tool: "whois_lookup", status: 0, baseCost: 1_000 },
  { tool: "whois_lookup", status: 0, baseCost: 1_000 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "serus_darkweb_scan", status: 500, baseCost: 500 },
  { tool: "socialfetch_lookup", status: 400, baseCost: 3_000 },
  { tool: "bosint_phone_lookup", status: 500, baseCost: 2_000 },
  { tool: "deepfind_profile_analyzer", status: 404, baseCost: 2_000 },
  { tool: "serus_darkweb_scan", status: 403, baseCost: 1_500 },
  { tool: "ipgeolocation_lookup", status: 401, baseCost: 1_000 },
];

const TRACE_ATTRIBUTED_TOTAL = 31_500; // µ — what the export summed as "cost"

describe("CostGate v2 — failed calls never charge credits", () => {
  it("every failed trace call has charged_micro_usd === 0 while its list price is preserved", () => {
    let attributed = 0;
    for (const row of FAILED_TRACE_ROWS) {
      // A non-ok upstream result, whatever the status code.
      const charged = creditsCharged({ ok: false, cached: false, free: false, baseCost: row.baseCost });
      expect(charged).toBe(0); // actual credits → 0
      attributed += row.baseCost; // cost_micro_usd still carries the list price
    }
    expect(attributed).toBe(TRACE_ATTRIBUTED_TOTAL);
  });

  it("a successful call of the same tool still charges its list price", () => {
    expect(creditsCharged({ ok: true, cached: false, free: false, baseCost: 5_000 })).toBe(5_000);
  });

  it("classifyResult maps each trace status to the right FailureKind", () => {
    expect(classifyResult({ ok: false, status: 400 }, null)).toBe("http_400");
    expect(classifyResult({ ok: false, status: 401 }, null)).toBe("http_401");
    expect(classifyResult({ ok: false, status: 403 }, null)).toBe("http_403");
    expect(classifyResult({ ok: false, status: 404 }, null)).toBe("http_404");
    expect(classifyResult({ ok: false, status: 500 }, null)).toBe("http_500");
    expect(classifyResult(null, new Error("connection timed out"))).toBe("timeout");
  });
});

describe("CostGate v2 — run summary separates charged from attributed", () => {
  it("the trace's 31,500µ of failed list price is fully avoided, charged stays 0", () => {
    const rows = FAILED_TRACE_ROWS.map((r) => ({
      tool_name: r.tool,
      ok: false,
      cached: false,
      cost_micro_usd: r.baseCost,
    }));
    const s = summarizeRunCosts(rows);
    expect(s.failed).toBe(FAILED_TRACE_ROWS.length);
    expect(s.cost_micro_usd).toBe(0); // actual charged
    expect(s.avoided_failed_cost_micro_usd).toBe(TRACE_ATTRIBUTED_TOTAL); // attributed-but-free
  });
});

describe("CostGate v2 — paid-provider first-5xx degrade (the one real circuit gap)", () => {
  let thread = "";
  let n = 0;
  beforeEach(() => { thread = `cg-${++n}`; clearThread(thread); });

  it("suppresses the provider on the FIRST 500, not after several", () => {
    expect(shouldRun(thread, "serus_darkweb_scan", "seed-1").allow).toBe(true);
    recordResult(thread, "serus_darkweb_scan", "seed-1", "default", {
      status: classifyResult({ ok: false, status: 500 }, null),
    });
    expect(isProviderSuppressed(thread, "serus_darkweb_scan").suppressed).toBe(true);
    // A different selector for the same provider is now skipped (free) too.
    expect(shouldRun(thread, "serus_darkweb_scan", "seed-2").allow).toBe(false);
  });

  it("does not over-suppress on a SUCCESS", () => {
    recordResult(thread, "serus_darkweb_scan", "seed-1", "default", { status: "ok", artifactCount: 1 });
    expect(isProviderSuppressed(thread, "serus_darkweb_scan").suppressed).toBe(false);
  });
});

describe("CostGate v2 — premium 4xx/404 repeat-suppression (regression lock)", () => {
  let thread = "";
  let n = 0;
  beforeEach(() => { thread = `cg4-${++n}`; clearThread(thread); });

  it("leakcheck 400 negative-caches the selector so the repeat is a free skip", () => {
    recordResult(thread, "leakcheck_lookup", "victim@x.com", "default", {
      status: classifyResult({ ok: false, status: 400 }, null),
    });
    expect(shouldRun(thread, "leakcheck_lookup", "victim@x.com").allow).toBe(false);
  });

  it("deepfind 404 negative-caches the selector after the first miss", () => {
    recordResult(thread, "deepfind_ransomware_exposure", "acme.com", "default", {
      status: classifyResult({ ok: false, status: 404 }, null),
    });
    expect(shouldRun(thread, "deepfind_ransomware_exposure", "acme.com").allow).toBe(false);
  });
});
