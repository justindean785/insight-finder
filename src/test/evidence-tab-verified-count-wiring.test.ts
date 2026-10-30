import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * EvidenceTab's header subtitle used to hand-roll its own "verified" tally
 * (`s === "confirmed" || s === "key"`) instead of routing through the shared
 * `tallyAuthority` selector (`src/lib/authority.ts`) that WorkspaceHeader and
 * OverviewTab already use. `authorityFor` gates verification through
 * `isClusterIneligible` and also counts corroboration-derived CONFIRMED rows
 * an analyst never explicitly reviewed — a hand-rolled review-only tally
 * misses both, so the same 55-artifact case read "2 verified" on Overview and
 * "1 verified" on the Evidence tab (measured in the harness).
 *
 * This is a source-text wiring guard, the same approach
 * `network-drop-wiring.test.ts` and `catalog-guidance.test.ts` use, because
 * the behavior itself (`authorityFor`/`tallyAuthority`'s gating logic) is
 * already driven behaviourally elsewhere (`display-confidence-contract.test.ts`
 * and `authority.ts`'s own callers). What only this test can catch is EvidenceTab
 * silently reverting to a local re-derivation.
 */
const SRC = fs.readFileSync(
  path.resolve(__dirname, "../components/workspace/EvidenceTab.tsx"),
  "utf8",
);

describe("EvidenceTab's verified count is wired to the shared authority selector", () => {
  it("imports tallyAuthority from the shared authority module", () => {
    expect(SRC).toMatch(/import\s*\{\s*summarizeReviewCounts\s*\}\s*from\s*["']@\/lib\/authority["']/);
  });

  it("derives `verified` from tallyAuthority(...), not a hand-rolled review-state count", () => {
    expect(SRC).toContain("summarizeReviewCounts(items, review.get)");
    // The regression this guards: counting confirmed/key locally instead of
    // deferring to the shared selector.
    expect(SRC).not.toMatch(/verified\+\+/);
  });

  it("prints the shared 'excluded' figure, not a local count of review verdicts", () => {
    // Behaviour is driven in review-summary.test.ts; this only catches a revert to the local tally.
    expect(SRC).not.toContain('s === "wrong" || s === "dismissed"');
    expect(SRC).not.toMatch(/rejected\+\+/);
  });
});
