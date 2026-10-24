import { describe, expect, it } from "vitest";
import { explainPivot, isAutoRunnable, pickBestPivot, requiresPreview } from "@/lib/best-pivot";
import { summarizeConnections } from "@/lib/connection-summary";
import { pivotEligibility, validatePivotSuggestion } from "@/lib/pivot-schema";
import type { NextStepItem } from "@/components/pivots/NextSteps";
import type { EntityGraph } from "@/lib/entity-graph";

const input = {
  id: "email:j@example.com:a1", priority: "high", action: "Verify email ownership", target: "j@example.com",
  targetType: "email", reason: "Email discovered via hunter verify.", sourceArtifactIds: [], basis: "Recommended in the agent's report text",
  prompt: "Run this pivot on j@example.com", status: "new",
};
function item(over: Record<string, unknown> = {}, key = "k"): NextStepItem {
  const validation = validatePivotSuggestion({ ...input, ...over });
  return {
    kind: "pivot", key, validation,
    eligibility: validation.status === "valid" ? pivotEligibility(validation.pivot, { artifactsById: new Map(), review: () => "new" }) : null,
  };
}

describe("best pivot", () => {
  it("picks the first runnable pivot in engine order and skips actions and malformed rows", () => {
    const action: NextStepItem = { kind: "action", key: "a", title: "t", detail: "d", prompt: "p" };
    const bad = item({ target: "| a | b |", targetType: "name" }, "bad");
    const good = item({}, "good");
    expect(pickBestPivot([action, bad, good])?.key).toBe("good");
    expect(pickBestPivot([action, bad])).toBeNull();
  });

  it("explains only facts that hold", () => {
    const v = validatePivotSuggestion(input);
    if (v.status !== "valid") throw new Error("fixture invalid");
    const reasons = explainPivot(v.pivot, null, new Map());
    expect(reasons).toContain("No tool has run against it yet.");
    expect(reasons.join(" ")).toMatch(/report suggested it/);
    expect(reasons.join(" ")).not.toMatch(/source row counts/);
    const searched = validatePivotSuggestion({ ...input, status: "searched" });
    if (searched.status !== "valid") throw new Error("fixture invalid");
    expect(explainPivot(searched.pivot, null, new Map())).not.toContain("No tool has run against it yet.");
  });

  it("Auto-run never starts a pivot that carries a warning; a report-only pivot is one-click but not unattended", () => {
    const reportOnly = item();
    expect(isAutoRunnable(reportOnly)).toBe(false);
    if (reportOnly.kind === "pivot" && reportOnly.eligibility) expect(requiresPreview(reportOnly.eligibility)).toBe(false);
    const rerun = item({ status: "searched" });
    if (rerun.kind === "pivot" && rerun.eligibility) expect(requiresPreview(rerun.eligibility)).toBe(true);
    expect(isAutoRunnable(rerun)).toBe(false);
  });
});

describe("connection summary", () => {
  it("reads the graph's own stats and never counts withheld rows as links", () => {
    const graph = { stats: { nodeCount: 14, edgeCount: 9, realEdgeCount: 2, clusterCount: 4, bridgeCount: 1, isolatedCount: 12 } } as EntityGraph;
    const quarantined = { id: "q", kind: "name", value: "x", metadata: { subject_unlinked: true } };
    const plain = { id: "p", kind: "name", value: "y", metadata: {} };
    const s = summarizeConnections(graph, [quarantined, plain] as never);
    expect(s).toMatchObject({ entities: 14, links: 2, clusters: 4, bridges: 1, unlinked: 12 });
    expect(s.withheld).toBe(1);
  });
});
