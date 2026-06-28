import { describe, it, expect } from "vitest";
import { buildAnalyticRadar } from "@/components/panel/CaseReport";
import type { Artifact } from "@/hooks/useThreadArtifacts";

function mk(over: Partial<Artifact>): Artifact {
  return {
    id: Math.random().toString(36).slice(2),
    thread_id: "t",
    kind: "other",
    value: "x",
    source: "breach_check",
    confidence: 60,
    created_at: "2026-06-28T00:00:00Z",
    metadata: {},
    ...over,
  } as unknown as Artifact;
}
const axis = (r: ReturnType<typeof buildAnalyticRadar>, label: string) =>
  r.find((m) => m.label === label)!;

describe("buildAnalyticRadar (display metrics — counts only)", () => {
  it("Exposure > 0 when breach_exposure artifacts exist (BUG-1)", () => {
    const arts = [
      mk({ kind: "breach_exposure", value: "Fling.com", metadata: { source_category: ["breach"] } }),
      mk({ kind: "breach_exposure", value: "Adobe.com", metadata: { source_category: ["breach"] } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Exposure").value).toBeGreaterThan(0);
  });

  it("Exposure is 0 with no exposure artifacts", () => {
    const arts = [mk({ kind: "email", metadata: { source_category: ["breach"] } })];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Exposure").value).toBe(0);
  });

  it("Signal is 0 when nothing buckets to confirmed/probable (BUG-2)", () => {
    const arts = [
      mk({ kind: "document", confidence: 60, metadata: { source_category: ["breach"] } }),
      mk({ kind: "breach_exposure", confidence: 65, metadata: { source_category: ["breach"] } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Signal").value).toBe(0);
  });

  it("Corroboration < 100 when findings are single-source-class (BUG-3)", () => {
    const arts = Array.from({ length: 5 }, () =>
      mk({ kind: "email", metadata: { source_category: ["breach"] } }));
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Corroboration").value).toBeLessThan(100);
  });

  it("Corroboration counts only findings with >=2 independent classes", () => {
    const arts = [
      mk({ kind: "name", metadata: { source_category: ["breach", "news"] } }),
      mk({ kind: "email", metadata: { source_category: ["breach"] } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Corroboration").value).toBe(50);
  });
});
