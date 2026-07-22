import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRun,
  recordResult,
  isProviderSuppressed,
  providerForTool,
  markProviderInFlight,
  clearProviderInFlight,
  clearThread,
  TIMEOUT_SUPPRESS_CONSECUTIVE,
} from "../../supabase/functions/osint-agent/circuit.ts";

// Frontend-CI mirror of the edge circuit timeout/grouping policy (the deno suite
// covers the same behaviors in circuit_timeout_test.ts / circuit_inflight_test.ts).
// Guards the #324-derived minimax split + multi-origin timeout logic reconciled
// onto the rolled-back tree (oathnet 2-strike preserved; plan_pivots decoupled).
let tid = 0;
let thread = "";
beforeEach(() => {
  thread = `t-${++tid}-${Math.random()}`;
  clearThread(thread);
});

describe("minimax provider split", () => {
  it("keeps the search worker on its own key and the reasoning tools on minimax_reason", () => {
    expect(providerForTool("minimax_web_search")).toBe("minimax");
    expect(providerForTool("minimax_correlate")).toBe("minimax_reason");
    expect(providerForTool("minimax_extract")).toBe("minimax_reason");
  });

  it("leaves the chronically-failing planner ungrouped (its own provider)", () => {
    expect(providerForTool("minimax_plan_pivots")).toBe("minimax_plan_pivots");
  });

  it("a minimax_web_search timeout does NOT suppress minimax_correlate", () => {
    recordResult(thread, "minimax_web_search", "q", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "minimax_web_search").suppressed).toBe(true);
    expect(isProviderSuppressed(thread, "minimax_correlate").suppressed).toBe(false);
    expect(shouldRun(thread, "minimax_correlate", "batch").allow).toBe(true);
  });

  it("a minimax_plan_pivots timeout does NOT suppress minimax_correlate", () => {
    recordResult(thread, "minimax_plan_pivots", "seed", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "minimax_plan_pivots").suppressed).toBe(true);
    expect(isProviderSuppressed(thread, "minimax_correlate").suppressed).toBe(false);
  });
});

describe("multi-origin timeout policy (jina / socialfetch_web_read)", () => {
  it("one timeout dead-lists only that URL; other hosts still run", () => {
    const slow = "https://slow.example/a";
    recordResult(thread, "jina_reader_scrape", slow, "default", { status: "timeout" });
    expect(shouldRun(thread, "jina_reader_scrape", slow).allow).toBe(false);
    expect(isProviderSuppressed(thread, "jina_reader_scrape").suppressed).toBe(false);
    expect(shouldRun(thread, "jina_reader_scrape", "https://fast.example/b").allow).toBe(true);
  });

  it(`suppresses the tool after ${TIMEOUT_SUPPRESS_CONSECUTIVE} consecutive timeouts`, () => {
    for (let i = 0; i < TIMEOUT_SUPPRESS_CONSECUTIVE; i++) {
      recordResult(thread, "jina_reader_scrape", `https://x.example/${i}`, "default", { status: "timeout" });
    }
    const sup = isProviderSuppressed(thread, "jina_reader_scrape");
    expect(sup.suppressed).toBe(true);
    expect(sup.reason).toMatch(/consecutive timeouts/);
  });

  it("a success between timeouts resets the streak", () => {
    recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "timeout" });
    recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "ok", artifactCount: 1 });
    recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
    recordResult(thread, "jina_reader_scrape", "https://d.example", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "jina_reader_scrape").suppressed).toBe(false);
  });

  it("a non-timeout failure between timeouts resets the streak (mixed run not counted)", () => {
    recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "http_404" });
    recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "timeout" });
    recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "jina_reader_scrape").suppressed).toBe(false);
  });
});

describe("single-upstream timeout policy is unchanged", () => {
  it("oathnet keeps its 2-strike tolerance (first tolerated, second suppresses the family)", () => {
    recordResult(thread, "oathnet_lookup", "a@example.com", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "oathnet_lookup").suppressed).toBe(false);
    expect(shouldRun(thread, "oathnet_stealer_search", "a").allow).toBe(true);
    recordResult(thread, "oathnet_lookup", "b@example.com", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "oathnet_lookup").suppressed).toBe(true);
    expect(isProviderSuppressed(thread, "oathnet_victims_search").suppressed).toBe(true);
  });

  it("other paid providers still suppress on the first timeout", () => {
    recordResult(thread, "exa_search", "q", "default", { status: "timeout" });
    expect(isProviderSuppressed(thread, "exa_get_contents").suppressed).toBe(true);
    recordResult(thread, "serus_darkweb_scan", "x@y.com", "default", { status: "timeout" });
    expect(shouldRun(thread, "serus_darkweb_scan", "z@y.com").allow).toBe(false);
  });
});

describe("in-flight gate exemption for multi-origin tools", () => {
  it("does not drop a parallel jina read of a different URL", () => {
    expect(shouldRun(thread, "jina_reader_scrape", "https://a.example/1").allow).toBe(true);
    markProviderInFlight(thread, "jina_reader_scrape");
    expect(shouldRun(thread, "jina_reader_scrape", "https://b.example/2").allow).toBe(true);
    clearProviderInFlight(thread, "jina_reader_scrape");
  });

  it("still gates a paid single-upstream provider's same-step burst", () => {
    expect(shouldRun(thread, "minimax_web_search", "q1").allow).toBe(true);
    markProviderInFlight(thread, "minimax_web_search");
    expect(shouldRun(thread, "minimax_web_search", "q2").allow).toBe(false);
    clearProviderInFlight(thread, "minimax_web_search");
  });
});
