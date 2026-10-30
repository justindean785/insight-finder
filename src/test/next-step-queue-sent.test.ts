import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots } from "@/lib/pivot-engine";
import { pivotRunKey } from "@/lib/pivot-runs";
import { countWorkbenchRunnablePivots } from "@/lib/next-step-queue";

function art(n: number, kind: string, value: string): Artifact {
  return {
    id: `a${n}`,
    kind,
    value,
    confidence: 80,
    source: "tool",
    created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
    metadata: {},
  };
}

const artifacts = [
  art(1, "email", "one@example.com"),
  art(2, "email", "two@example.org"),
  art(3, "email", "three@example.net"),
];

const input = {
  artifacts,
  seedValue: null,
  reportPivots: [],
  skipSet: new Set<string>(),
  queriedSet: new Set<string>(),
  reviews: {},
};

// The Chat handoff line ("N next pivots ranked") and the Workbench Next list are two
// renderings of one queue. The Workbench drops a pivot that is running or has a tool call
// recorded against it (it shows above the list as Running/Completed); the count must drop
// the same pivot or Chat promises one more than the Workbench shows.
describe("countWorkbenchRunnablePivots — started pivots", () => {
  const ranked = computePivots({ ...input }).filter((c) => c.status === "new");

  it("fixture ranks at least two new pivots, so the subtraction below is not vacuous", () => {
    expect(ranked.length).toBeGreaterThanOrEqual(2);
  });

  it("counts every new pivot when none has started", () => {
    expect(countWorkbenchRunnablePivots({ ...input, sentKeys: new Set() })).toBe(ranked.length);
  });

  it("does not count a pivot that is already running or recorded", () => {
    const sentKeys = new Set([pivotRunKey(ranked[0].type, ranked[0].value)]);
    expect(countWorkbenchRunnablePivots({ ...input, sentKeys })).toBe(ranked.length - 1);
  });
});
