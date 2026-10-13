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

  it("Cross-source < 100 when findings are single-source-class (BUG-3)", () => {
    const arts = Array.from({ length: 5 }, () =>
      mk({ kind: "email", metadata: { source_category: ["breach"] } }));
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Cross-source").value).toBeLessThan(100);
  });

  it("Cross-source counts only findings with >=2 independent classes", () => {
    const arts = [
      mk({ kind: "name", metadata: { source_category: ["breach", "news"] } }),
      mk({ kind: "email", metadata: { source_category: ["breach"] } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Cross-source").value).toBe(50);
  });

  // #593 review, finding B2: the radar counted ROWS, so one email recorded by a breach tool and by a public source read as
  // two single-class findings. Corroboration is a property of the selector.
  it("Cross-source unions the classes of every row of one selector (breach row + public row = corroborated)", () => {
    const arts = [
      mk({ kind: "email", value: "jordan.vale@example.com", metadata: { source_category: ["breach"] } }),
      mk({ kind: "email", value: "Jordan.Vale@example.com", metadata: { source_category: ["public_record"] } }),
    ];
    const m = axis(buildAnalyticRadar(arts, "LOW"), "Cross-source");
    expect(m.value).toBe(100);
    expect(m.detail).toContain("1/1 finding");
  });

  it("…two rows of the SAME class are one class: not corroborated", () => {
    const arts = [
      mk({ kind: "email", value: "a@example.com", metadata: { source_category: ["breach"] } }),
      mk({ kind: "email", value: "a@example.com", metadata: { source_category: ["breach"], note: "second tool" } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Cross-source").value).toBe(0);
  });

  it("…the denominator is selectors, so a corroborated selector with a twin is not diluted", () => {
    const arts = [
      mk({ kind: "email", value: "a@example.com", metadata: { source_category: ["breach"] } }),
      mk({ kind: "email", value: "a@example.com", metadata: { source_category: ["public_record"] } }),
      mk({ kind: "email", value: "b@example.com", metadata: { source_category: ["breach"] } }),
    ];
    expect(axis(buildAnalyticRadar(arts, "LOW"), "Cross-source").value).toBe(50);
  });

  it("…a rejected sibling lends no class (analyst-rejected rows never strengthen a positive metric)", () => {
    const keep = mk({ id: "keep", kind: "email", value: "a@example.com", metadata: { source_category: ["breach"] } });
    const rejected = mk({ id: "rej", kind: "email", value: "a@example.com", metadata: { source_category: ["public_record"] } });
    const m = axis(buildAnalyticRadar([keep, rejected], "LOW", { rej: "dismissed" }), "Cross-source");
    expect(m.value).toBe(0);
  });
});
