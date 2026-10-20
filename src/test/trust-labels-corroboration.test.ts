import { describe, it, expect } from "vitest";
import {
  buildAnalyticRadar,
  countAnalystConfirmed,
  countIndependentlyCorroborated,
} from "@/components/panel/CaseReport";
import type { Artifact } from "@/hooks/useThreadArtifacts";

function mk(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    thread_id: "t",
    kind: "email",
    value: `synthetic-${id}`,
    source: "tool_a",
    confidence: 60,
    created_at: "2026-10-20T00:00:00Z",
    metadata: { source_category: ["social"] },
    ...over,
  } as unknown as Artifact;
}

describe("analyst-confirmed vs independently corroborated", () => {
  const single = mk("a");
  const multi = mk("b", { metadata: { source_category: ["social", "public_record"] } });

  it("confirming a single-source row raises the analyst count but not the corroborated count", () => {
    const before = [single, multi];
    const reviews = { a: "confirmed" } as never;
    expect(countAnalystConfirmed(before, undefined)).toBe(0);
    expect(countAnalystConfirmed(before, reviews)).toBe(1);
    expect(countIndependentlyCorroborated(before, undefined)).toBe(1);
    expect(countIndependentlyCorroborated(before, reviews)).toBe(1);
  });

  it("the panel count and the Cross-source radar axis use the same definition", () => {
    const arts = [single, multi, mk("c")];
    const reviews = { a: "key" } as never;
    const axis = buildAnalyticRadar(arts, "LOW", reviews).find((m) => m.label === "Cross-source")!;
    expect(axis.detail).toContain(`${countIndependentlyCorroborated(arts, reviews)}/${arts.length}`);
  });

  it("a rejected row counts toward neither", () => {
    const reviews = { b: "wrong" } as never;
    expect(countIndependentlyCorroborated([multi], reviews)).toBe(0);
    expect(countAnalystConfirmed([mk("b", { metadata: { reviewed: true } })], reviews)).toBe(0);
  });

  it("metadata.reviewed counts as analyst-confirmed but never as corroboration", () => {
    const attested = mk("d", { metadata: { source_category: ["social"], reviewed: true } });
    expect(countAnalystConfirmed([attested])).toBe(1);
    expect(countIndependentlyCorroborated([attested])).toBe(0);
  });
});

describe("canonical eligibility (review follow-ups)", () => {
  it("non-corroborating classes (ai_summary + web_search) are not independent corroboration", () => {
    const weak = mk("w", { metadata: { source_category: ["ai_summary", "web_search"] } });
    expect(countIndependentlyCorroborated([weak])).toBe(0);
    const mixed = mk("m", { metadata: { source_category: ["ai_summary", "public_record", "social"] } });
    expect(countIndependentlyCorroborated([mixed])).toBe(1);
  });

  it("a possible_minor or false-positive row is never counted analyst-confirmed", () => {
    const reviews = { p: "confirmed", f: "key" } as never;
    const minor = mk("p", { metadata: { source_category: ["social"], possible_minor: true } });
    const fp = mk("f", { metadata: { source_category: ["social"], false_positive: true } });
    expect(countAnalystConfirmed([minor, fp], reviews)).toBe(0);
  });
});
