import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * ReportTab's header subtitle hand-rolled its own "verified" tally
 * (`s === "confirmed" || s === "key"` over `reviews`) and its own in-source
 * comment claimed this was "the same tally the report body shows" — it was
 * not. `CaseReport`'s own KPI counts via `bucket()`, which gates through
 * `isClusterIneligible` (see case-report-collision-authority.test.tsx) and
 * counts corroboration-derived CONFIRMED rows nobody explicitly reviewed.
 * Measured in the harness: the Report tab's OWN header said "1 verified"
 * while its own body's KPI, two scroll-lengths below, said something else
 * entirely — a tab disagreeing with itself, not just with other tabs.
 *
 * Source-text wiring guard, matching evidence-tab-verified-count-wiring.test.ts.
 */
const SRC = fs.readFileSync(
  path.resolve(__dirname, "../components/panel/ReportTab.tsx"),
  "utf8",
);

describe("ReportTab's verified count is wired to the shared authority selector", () => {
  it("imports tallyAuthority from the shared authority module", () => {
    expect(SRC).toMatch(/import\s*\{\s*tallyAuthority\s*\}\s*from\s*["']@\/lib\/authority["']/);
  });

  it("derives `verified` from tallyAuthority(...), not a hand-rolled review-state count", () => {
    expect(SRC).toContain("tallyAuthority(artifacts, review.get)");
    expect(SRC).toContain("authority.verified");
    expect(SRC).not.toMatch(/verified\+\+/);
  });

  it("prints the authority ladder's excluded figure, not a local count of review verdicts", () => {
    expect(SRC).toContain("excluded: authority.failed");
    expect(SRC).not.toContain('s === "wrong" || s === "dismissed"');
  });
});
