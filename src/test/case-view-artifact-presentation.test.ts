import { describe, expect, it } from "vitest";
import { isMetaArtifact, type Artifact } from "@/hooks/useThreadArtifacts";
import { extractSourceInfo } from "@/lib/intel";

function artifact(partial: Partial<Artifact> = {}): Artifact {
  return {
    id: "a-1",
    kind: "email",
    value: "analyst@example.com",
    confidence: 60,
    source: null,
    created_at: "2026-07-14T00:00:00.000Z",
    metadata: {},
    ...partial,
  };
}

describe("case-view artifact presentation", () => {
  it("keeps internal cluster decisions out of evidentiary views", () => {
    expect(isMetaArtifact(artifact({ kind: "cluster_decision", confidence: 100 }))).toBe(true);
    expect(isMetaArtifact(artifact({ metadata: { label: "cluster_decision" } }))).toBe(true);
    expect(isMetaArtifact(artifact({ kind: "email", confidence: 100 }))).toBe(false);
  });

  it("splits compound source fields into distinct, deduplicated sources", () => {
    const info = extractSourceInfo(artifact({
      source: "breach_check, leakcheck_lookup",
      metadata: { sources: ["leakcheck_lookup", "oathnet_lookup+breach_check"] },
    }));
    expect(info.primary).toBe("breach_check");
    expect(info.all).toEqual(["breach_check", "leakcheck_lookup", "oathnet_lookup"]);
  });
});
