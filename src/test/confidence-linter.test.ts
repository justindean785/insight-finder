import { describe, it, expect } from "vitest";
import {
  tierOf,
  lintCluster,
  lintReport,
  type ClusterAudit,
} from "@/lib/audit/confidence-linter";

describe("tierOf", () => {
  it("maps scores to tiers at the boundaries", () => {
    expect(tierOf(0)).toBe("Low");
    expect(tierOf(40)).toBe("Low");
    expect(tierOf(41)).toBe("Medium");
    expect(tierOf(70)).toBe("Medium");
    expect(tierOf(71)).toBe("High");
    expect(tierOf(89)).toBe("High");
    expect(tierOf(90)).toBe("Verified");
    expect(tierOf(100)).toBe("Verified");
  });

  it("clamps out-of-range scores", () => {
    expect(tierOf(-5)).toBe("Low");
    expect(tierOf(150)).toBe("Verified");
  });
});

describe("lintCluster", () => {
  it("errors when a cluster declares a tier with no evidence", () => {
    const c: ClusterAudit = { name: "Empty", declaredTier: "High", cells: [] };
    const f = lintCluster(c);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
  });

  it("passes a cluster whose cells support the declared tier", () => {
    const c: ClusterAudit = {
      name: "Solid High",
      declaredTier: "High",
      cells: [
        { claim: "Name", value: "X", source: "A", confidence: 75 },
        { claim: "Addr", value: "Y", source: "B", confidence: 80 },
        { claim: "Link", value: "Z", source: "C", confidence: 85 },
      ],
    };
    expect(lintCluster(c)).toHaveLength(0);
  });

  it("errors when the declared tier exceeds the mean evidence confidence", () => {
    const c: ClusterAudit = {
      name: "Inflated",
      declaredTier: "High", // min 71
      cells: [
        { claim: "Name", value: "X", source: "A", confidence: 80 },
        { claim: "Addr", value: "Y", source: "B", confidence: 55 },
        { claim: "Link", value: "Z", source: "C", confidence: 60 }, // mean 65
      ],
    };
    const f = lintCluster(c);
    const err = f.find((x) => x.severity === "error");
    expect(err).toBeDefined();
    expect(err!.message).toContain("exceeds mean");
    expect(err!.suggestion).toContain("Medium"); // tierOf(65)
  });

  it("warns when the weakest pillar sits below the declared tier", () => {
    const c: ClusterAudit = {
      name: "Weak link",
      declaredTier: "High", // min 71
      cells: [
        { claim: "Strong", value: "X", source: "A", confidence: 95 },
        { claim: "Strong2", value: "Y", source: "B", confidence: 92 },
        { claim: "Weak", value: "Z", source: "C", confidence: 50 }, // mean 79 → no rule1
      ],
    };
    const f = lintCluster(c);
    const warn = f.find((x) => x.severity === "warn");
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("Weakest evidence cell (50)");
    expect(warn!.suggestion).toContain("Weak");
  });

  it("requires >=2 independent sources at >=85 for Verified", () => {
    const sameSource: ClusterAudit = {
      name: "Verified one-source",
      declaredTier: "Verified",
      cells: [
        { claim: "A", value: "1", source: "MyDriveSure breach", confidence: 95 },
        { claim: "B", value: "2", source: "MyDriveSure breach", confidence: 92 },
      ],
    };
    const f = lintCluster(sameSource);
    expect(f.some((x) => x.severity === "error" && x.message.includes("Verified"))).toBe(true);

    const twoSources: ClusterAudit = {
      name: "Verified two-source",
      declaredTier: "Verified",
      cells: [
        { claim: "A", value: "1", source: "Court record", confidence: 95 },
        { claim: "B", value: "2", source: "State registry", confidence: 92 },
      ],
    };
    expect(lintCluster(twoSources)).toHaveLength(0);
  });
});

describe("lintReport", () => {
  it("flattens findings across clusters", () => {
    const findings = lintReport([
      { name: "Empty", declaredTier: "High", cells: [] },
      {
        name: "Good",
        declaredTier: "Medium",
        cells: [{ claim: "A", value: "1", source: "X", confidence: 60 }],
      },
    ]);
    expect(findings.some((f) => f.cluster === "Empty")).toBe(true);
    expect(findings.every((f) => f.cluster !== "Good")).toBe(true);
  });
});
