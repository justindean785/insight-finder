import { describe, it, expect } from "vitest";
import { humanizeArtifactMetadata, formatMetaValue } from "@/lib/artifact-metadata";

describe("humanizeArtifactMetadata", () => {
  it("hides internal/plumbing keys (cluster_id, cache, runtime, ids, _-prefixed)", () => {
    const rows = humanizeArtifactMetadata({
      cluster_id: "c_123",
      cache_layer: "thread",
      runtime: { stage: "REVIEW" },
      thread_id: "t_1",
      _cached: true,
      handle: "octocat",
    });
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual(["handle"]);
    expect(rows[0]).toEqual({ key: "handle", label: "Handle", value: "octocat" });
  });

  it("labels known keys and Title-cases unknown ones", () => {
    const rows = humanizeArtifactMetadata({ source_category: "breach", some_field: "x" });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.label]));
    expect(byKey.source_category).toBe("Source category");
    expect(byKey.some_field).toBe("Some field");
  });

  it("drops empty values (empty string, empty array, empty object)", () => {
    const rows = humanizeArtifactMetadata({ a: "", b: [], c: {}, d: "kept" });
    expect(rows.map((r) => r.key)).toEqual(["d"]);
  });

  it("never surfaces the false_positive / conflict flags as rows", () => {
    const rows = humanizeArtifactMetadata({ false_positive: true, conflict: true, platform: "GitHub" });
    expect(rows.map((r) => r.key)).toEqual(["platform"]);
  });

  it("returns [] for null / non-object input", () => {
    expect(humanizeArtifactMetadata(null)).toEqual([]);
    expect(humanizeArtifactMetadata(undefined)).toEqual([]);
  });
});

describe("formatMetaValue", () => {
  it("formats primitives", () => {
    expect(formatMetaValue(true)).toBe("Yes");
    expect(formatMetaValue(false)).toBe("No");
    expect(formatMetaValue(42)).toBe("42");
    expect(formatMetaValue("  hi  ")).toBe("hi");
  });

  it("joins primitive arrays and counts object arrays", () => {
    expect(formatMetaValue(["a", "b", 3])).toBe("a, b, 3");
    expect(formatMetaValue([{ x: 1 }, { y: 2 }])).toBe("2 items");
  });

  it("flattens a shallow object of primitives", () => {
    expect(formatMetaValue({ country: "US", verified: true })).toBe("Country: US; Verified: true");
  });

  it("returns null for empty / signal-free values", () => {
    expect(formatMetaValue(null)).toBeNull();
    expect(formatMetaValue("")).toBeNull();
    expect(formatMetaValue([])).toBeNull();
    expect(formatMetaValue({})).toBeNull();
    expect(formatMetaValue(NaN)).toBeNull();
  });
});
