import { describe, it, expect } from "vitest";
import { authorityFor, summarizeReviewCounts, verifiedLabel } from "@/lib/authority";
import { STATUS_FILTER_GROUPS } from "@/components/ResourcesPanel";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";

const art = (id: string, over: Partial<Artifact> = {}): Artifact => ({
  id,
  thread_id: "t",
  kind: "social_profile",
  value: `https://example.com/${id}`,
  confidence: 30,
  source: "username_sweep",
  created_at: "2026-10-15T12:00:00Z",
  metadata: { source_category: ["username_sweep"] },
  ...over,
} as Artifact);

// Three ways a row lands in the board's Excluded chip: an analyst verdict, the legacy
// false-positive flag, and a collision the engine rules out. The toolbar summaries on
// the Evidence and Report tabs used to count only the first (review verdicts), so the
// same case read "11 rejected" beside "Excluded 11" by coincidence and would not have
// when the populations diverged.
const rows = [
  art("wrong"),
  art("dismissed"),
  art("falsepos", { metadata: { source_category: ["username_sweep"], false_positive: true } }),
  art("plain"),
  art("recheck"),
];
const verdicts: Record<string, ReviewState> = { wrong: "wrong", dismissed: "dismissed", recheck: "recheck" };
const review = (id: string): ReviewState => verdicts[id] ?? "new";

describe("summarizeReviewCounts", () => {
  it("excluded equals the Evidence board's Excluded chip, by the chip's own filter group", () => {
    const board = rows.filter((a) => STATUS_FILTER_GROUPS.excluded!.has(authorityFor(a, review(a.id)).state)).length;
    expect(board).toBeGreaterThanOrEqual(3);
    expect(summarizeReviewCounts(rows, review).excluded).toBe(board);
  });

  it("counts rows excluded by the false-positive flag, not only by analyst verdict", () => {
    const flagged = [art("falsepos", { metadata: { source_category: ["username_sweep"], false_positive: true } })];
    expect(summarizeReviewCounts(flagged, () => "new").excluded).toBe(1);
  });

  it("counts recheck verdicts", () => {
    expect(summarizeReviewCounts(rows, review).recheck).toBe(1);
  });
});

describe("the verified noun", () => {
  it("is 'verified' in every mode, never 'confirmed' (the hint carries who confirmed)", () => {
    expect(verifiedLabel(37, 37, true)).toBe("verified");
    expect(verifiedLabel(37, 10, true)).toBe("verified");
    expect(verifiedLabel(37, 37)).toBe("verified (analyst-confirmed)");
    expect(verifiedLabel(37, 10)).toBe("verified (10 analyst-confirmed)");
  });
});
