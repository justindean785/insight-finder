import { describe, it, expect } from "vitest";
import { qualConfidence, breachSeverity, isDobPlaceholder, isAiSummaryArtifact } from "@/lib/report-badges";

describe("qualConfidence (BUG-4 mapping)", () => {
  it("maps bands consistently", () => {
    expect(qualConfidence(95)).toBe("HIGH");
    expect(qualConfidence(80)).toBe("HIGH");
    expect(qualConfidence(79)).toBe("MEDIUM");
    expect(qualConfidence(65)).toBe("MEDIUM"); // the bug: was "HIGH" while table said 65%
    expect(qualConfidence(60)).toBe("MEDIUM");
    expect(qualConfidence(59)).toBe("LOW");
    expect(qualConfidence(0)).toBe("LOW");
    expect(qualConfidence(null)).toBe("LOW");
    expect(qualConfidence(undefined)).toBe("LOW");
  });
});

describe("breachSeverity", () => {
  it("flags known full-profile breaches CRITICAL", () => {
    expect(breachSeverity({ value: "Experian (2015)" })).toBe("CRITICAL");
    expect(breachSeverity({ value: "Exactis 2018" })).toBe("CRITICAL");
    expect(breachSeverity({ value: "National Public Data" })).toBe("CRITICAL");
    expect(breachSeverity({ value: "NPD breach", source: "x" })).toBe("CRITICAL");
  });
  it("honours explicit metadata.severity", () => {
    expect(breachSeverity({ value: "SomeForum", metadata: { severity: "CRITICAL" } })).toBe("CRITICAL");
    expect(breachSeverity({ value: "SomeForum", metadata: { severity: "high" } })).toBe("HIGH");
  });
  it("returns null for ordinary breaches", () => {
    expect(breachSeverity({ value: "Fling.com (2011)" })).toBeNull();
    expect(breachSeverity({ value: "Zynga" })).toBeNull();
  });
});

describe("isDobPlaceholder", () => {
  it("detects Jan-1 placeholder DOBs", () => {
    expect(isDobPlaceholder("1981-01-01")).toBe(true);
    expect(isDobPlaceholder("01/01/1981")).toBe(true);
    expect(isDobPlaceholder("January 1, 1990")).toBe(true);
    expect(isDobPlaceholder("Jan 1 1990")).toBe(true);
  });
  it("passes real DOBs", () => {
    expect(isDobPlaceholder("1981-12-21")).toBe(false);
    expect(isDobPlaceholder("07/15/1985")).toBe(false);
    expect(isDobPlaceholder("")).toBe(false);
    expect(isDobPlaceholder(null)).toBe(false);
  });
});

describe("isAiSummaryArtifact", () => {
  it("detects ai_summary provenance", () => {
    expect(isAiSummaryArtifact({ metadata: { source_category: ["ai_summary"] } })).toBe(true);
    expect(isAiSummaryArtifact({ metadata: { source_category: "ai_summary" } })).toBe(true);
    expect(isAiSummaryArtifact({ metadata: { provenance: "llm_asserted_unverified" } })).toBe(true);
  });
  it("is false for record-sourced artifacts", () => {
    expect(isAiSummaryArtifact({ metadata: { source_category: ["breach"] } })).toBe(false);
    expect(isAiSummaryArtifact({ metadata: {} })).toBe(false);
    expect(isAiSummaryArtifact({})).toBe(false);
  });
});
