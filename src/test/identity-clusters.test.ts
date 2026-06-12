import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildClusterSection, buildIdentityClusters } from "@/lib/intel";

let artifactId = 0;

function artifact(
  kind: string,
  value: string,
  metadata: Record<string, unknown> | null = null,
): Artifact {
  artifactId += 1;
  return {
    id: `artifact-${artifactId}`,
    kind,
    value,
    confidence: 80,
    source: "test",
    created_at: "2026-06-12T00:00:00.000Z",
    metadata,
  };
}

describe("buildIdentityClusters shared-infrastructure splitting", () => {
  it("does not collapse three distinct people bridged by one IP selector", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);

    expect(report.clusters).toHaveLength(3);
    expect(report.clusters.map((cluster) => cluster.names[0]).sort()).toEqual([
      "Angie",
      "Kyle",
      "Maurice",
    ]);
    expect(report.clusters.every((cluster) => cluster.ips.includes("203.0.113.10"))).toBe(true);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("Shared-infrastructure split: one ip selector"),
    );
  });

  it("preserves a hard email merge after excluding a shared IP selector", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("email", "maurice@example.com", { parent: "maurice-case" }),
      artifact("email", "maurice@example.com", { source_record: "second-source" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);
    const mauriceCluster = report.clusters.find((cluster) =>
      cluster.emails.includes("maurice@example.com"),
    );

    expect(mauriceCluster?.artifacts).toHaveLength(4);
    expect(mauriceCluster?.names).toContain("Maurice");
    expect(report.clusters.some((cluster) => cluster.names.includes("Kyle"))).toBe(true);
    expect(report.clusters.some((cluster) => cluster.names.includes("Angie"))).toBe(true);
  });

  it("keeps existing infrastructure clustering below the fanout threshold", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].names.sort()).toEqual(["Kyle", "Maurice"]);
    expect(report.warnings.some((warning) => warning.includes("Shared-infrastructure split"))).toBe(false);
  });

  it("also guards a parent selector that directly fans out to three names", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "shared-selector" }),
      artifact("name", "Kyle", { parent: "shared-selector" }),
      artifact("name", "Angie", { parent: "shared-selector" }),
    ], null);

    expect(report.clusters).toHaveLength(3);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("Shared-infrastructure split: one parent selector"),
    );
  });

  it("still splits a surviving cluster when its artifacts conflict by state", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("address", "10 Main St, Minneapolis, MN", { parent: "maurice-case" }),
      artifact("address", "20 Oak St, Austin, TX", { parent: "maurice-case" }),
    ], null);

    expect(report.clusters).toHaveLength(2);
    expect(report.clusters.map((cluster) => cluster.states[0]).sort()).toEqual(["MN", "TX"]);
    expect(report.clusters.every((cluster) =>
      cluster.warnings.some((warning) => warning.includes("Split from larger cluster")),
    )).toBe(true);
  });

  it("propagates the shared-infrastructure warning into report output", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ], null);

    expect(buildClusterSection(report)).toContain("Shared-infrastructure split");
  });
});
