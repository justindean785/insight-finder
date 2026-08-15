import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { clusterDefaultOpen } from "@/lib/quarantine";
import { chargedMicroUsd, summarizeRunCosts } from "@/lib/runCost";

/**
 * Two disclosure rules that a UI surface had quietly stopped honouring, both
 * found in review of PR #462. They share a shape worth naming: in each case the
 * code SAID it did the right thing — one in a comment, one in a variable name —
 * and the behaviour had never existed or had drifted away.
 */

describe("quarantine cannot hide behind a collapsed cluster", () => {
  /**
   * The Evidence board folds same-kind clusters over 4 rows so a case with 30
   * subdomains is readable. A collapsed cluster shows a count and nothing else,
   * so folding a quarantined row away turns an active warning into something the
   * analyst must go looking for. The call site carried this promise in a comment
   * while `open` was still `?? !collapsible`.
   */
  it("small clusters are open regardless", () => {
    expect(clusterDefaultOpen(false, 0)).toBe(true);
    expect(clusterDefaultOpen(false, 2)).toBe(true);
  });

  it("large clean clusters fold — that is the feature, not a bug", () => {
    expect(clusterDefaultOpen(true, 0)).toBe(false);
  });

  it("a single quarantined row keeps a large cluster open", () => {
    expect(clusterDefaultOpen(true, 1)).toBe(true);
    expect(clusterDefaultOpen(true, 9)).toBe(true);
  });

  it("the component initialises from the rule, not from `!collapsible`", () => {
    // A named policy function that nothing calls is documentation, not a fix.
    // This is the assertion that would have failed on the shipped code: the
    // helper is only worth anything if the rendered default flows through it.
    const src = readFileSync("src/components/ResourcesPanel.tsx", "utf8");
    expect(src).toMatch(/openClusters\[key\]\s*\?\?\s*clusterDefaultOpen\(/);
    // And the old expression must be gone, not merely shadowed.
    expect(src).not.toMatch(/openClusters\[key\]\s*\?\?\s*!collapsible/);
  });
});

describe("a legacy tool call is not a free tool call", () => {
  /**
   * `charged_micro_usd` was added after charge accounting; older
   * `tool_usage_log` rows have it null. Reading null as 0 does two things at
   * once — it under-reports what a case cost, and it files a paid provider call
   * under "free / cached", which is the number an analyst uses to judge whether
   * caching is working.
   */
  it("reconstructs an unknown charge from the list price", () => {
    expect(chargedMicroUsd({ ok: true, cached: false, cost_micro_usd: 4000, charged_micro_usd: null })).toBe(4000);
  });

  it("prefers a recorded charge over the list price", () => {
    expect(chargedMicroUsd({ ok: true, cached: false, cost_micro_usd: 4000, charged_micro_usd: 900 })).toBe(900);
  });

  it("distinguishes a recorded zero from an unknown charge", () => {
    // The distinction the raw field exists to preserve: this row genuinely cost
    // nothing, and must not be reconstructed up to its list price.
    expect(chargedMicroUsd({ ok: true, cached: false, cost_micro_usd: 4000, charged_micro_usd: 0 })).toBe(0);
  });

  it("charges nothing for a cache hit or a failed call", () => {
    expect(chargedMicroUsd({ ok: true, cached: true, cost_micro_usd: 4000, charged_micro_usd: null })).toBe(0);
    expect(chargedMicroUsd({ ok: false, cached: false, cost_micro_usd: 4000, charged_micro_usd: null })).toBe(0);
  });

  it("returns 0 only when the row carries neither figure", () => {
    expect(chargedMicroUsd({ ok: true, cached: false, cost_micro_usd: null, charged_micro_usd: null })).toBe(0);
  });

  it("summarizeRunCosts still agrees with the extracted rule", () => {
    // The extraction must not have moved any number. Same rows through both
    // paths, same total.
    const rows = [
      { ok: true, cached: false, cost_micro_usd: 4000, charged_micro_usd: null },
      { ok: true, cached: false, cost_micro_usd: 1000, charged_micro_usd: 250 },
      { ok: true, cached: true, cost_micro_usd: 4000, charged_micro_usd: null },
      { ok: false, cached: false, cost_micro_usd: 7000, charged_micro_usd: null },
    ];
    const viaHelper = rows.reduce((n, r) => n + chargedMicroUsd(r), 0);
    expect(summarizeRunCosts(rows).cost_micro_usd).toBe(viaHelper);
    expect(viaHelper).toBe(4250);
  });
});
