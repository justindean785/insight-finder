/**
 * evidence-board-reactivity.test.ts — Board counts and ordering react to a
 * verdict the moment it changes.
 *
 * THE DEFECT: `EvidenceBoard`'s quick-filter counts were memoised on `[items]`
 * alone, and `ArtifactsList`'s grouping/sorting memo omitted the review too —
 * with the "All" filter `filtered === items` is the same reference, so a
 * Confirm / False never re-ran either memo. The chips and the strength order
 * stayed stale until an unrelated artifact happened to arrive.
 *
 * Both memos are pinned at source level (the shipped dependency arrays), and
 * the `revision` they depend on is pinned behaviourally in
 * review-write-contract.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../components/ResourcesPanel.tsx"), "utf8");
const INSPECTOR_SRC = readFileSync(resolve(__dirname, "../components/workspace/ArtifactInspector.tsx"), "utf8");

describe("EvidenceBoard memo dependencies", () => {
  it("the quick-filter counts recompute on review.revision", () => {
    const m = SRC.match(/const counts = useMemo\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\);/);
    expect(m, "counts memo not found").toBeTruthy();
    expect(m![1]).toMatch(/review\.revision/);
  });

  it("the grouped/sorted list recomputes on review.revision", () => {
    const m = SRC.match(/const grouped = useMemo\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\);/);
    expect(m, "grouped memo not found").toBeTruthy();
    expect(m![1]).toMatch(/review\.revision/);
  });

  it("the drawer's False action is the review verdict, not a metadata toggle", () => {
    // The separate `metadata.false_positive` writer is gone: one visible False
    // contract, reaching every consumer through artifact_reviews.
    expect(SRC).not.toMatch(/updateMeta\(\{\s*false_positive/);
    expect(INSPECTOR_SRC).not.toMatch(/updateMeta\(\{\s*false_positive/);
    expect(SRC + INSPECTOR_SRC).toMatch(/target="dismissed"/);
  });
});
