import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildClusterSection, buildIdentityClusters, normalizeHandle } from "@/lib/intel";

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

/** A passive social-profile observation carrying a platform handle in metadata,
 * the shape SocialFetch/scrape tools actually emit. */
function profile(
  platform: string,
  handle: string,
  opts: { confidence?: number; displayName?: string; bio?: string } = {},
): Artifact {
  artifactId += 1;
  return {
    id: `artifact-${artifactId}`,
    kind: "social_profile",
    value: `https://${platform}.example/@${handle}`,
    confidence: opts.confidence ?? 40,
    source: platform,
    created_at: "2026-06-12T00:00:00.000Z",
    metadata: {
      handle,
      platform,
      ...(opts.displayName ? { display_name: opts.displayName } : {}),
      ...(opts.bio ? { bio: opts.bio } : {}),
    },
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

describe("normalizeHandle", () => {
  it("lowercases, trims, and strips a leading @", () => {
    expect(normalizeHandle("  @NuhDeem ")).toBe("nuhdeem");
  });

  it("removes underscores, periods, and hyphens", () => {
    expect(normalizeHandle("nuh_deem")).toBe("nuhdeem");
    expect(normalizeHandle("nuh.deem")).toBe("nuhdeem");
    expect(normalizeHandle("NUH-DEEM")).toBe("nuhdeem");
  });

  it("preserves alphanumerics so distinct handles stay distinct", () => {
    expect(normalizeHandle("nuhdeem1")).toBe("nuhdeem1");
    expect(normalizeHandle("realnuhdeem")).toBe("realnuhdeem");
    expect(normalizeHandle("nuhdeem_backup")).toBe("nuhdeembackup");
  });
});

describe("buildIdentityClusters handle-based merging (T1-2)", () => {
  const handleReasons = (report: ReturnType<typeof buildIdentityClusters>) =>
    report.clusters.flatMap((c) => c.mergeReasons);

  it("merges exact handle matches across platforms into one cluster", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem"),
      profile("x", "nuhdeem"),
      artifact("username", "nuhdeem"),
    ], null);

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].artifacts).toHaveLength(4);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuhdeem");
  });

  it("matches handles case-insensitively", () => {
    const report = buildIdentityClusters([
      profile("instagram", "NuhDeem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
  });

  it("normalizes underscores before matching and records the variant", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh_deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuhdeem");
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh_deem -> nuhdeem");
  });

  it("normalizes periods before matching", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh.deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh.deem -> nuhdeem");
  });

  it("normalizes hyphens before matching", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh-deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh-deem -> nuhdeem");
  });

  it("scores a 3-platform handle higher than a 2-platform handle (reinforcement)", () => {
    const two = buildIdentityClusters([
      profile("instagram", "nuhdeem", { confidence: 40 }),
      profile("tiktok", "nuhdeem", { confidence: 40 }),
    ], null);
    const three = buildIdentityClusters([
      profile("instagram", "nuhdeem", { confidence: 40 }),
      profile("tiktok", "nuhdeem", { confidence: 40 }),
      profile("x", "nuhdeem", { confidence: 40 }),
    ], null);
    expect(two.clusters).toHaveLength(1);
    expect(three.clusters).toHaveLength(1);
    expect(three.clusters[0].confidence).toBeGreaterThan(two.clusters[0].confidence);
  });

  it("does NOT merge a handle with a numeric suffix", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem1"),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("does NOT merge a handle with a different prefix", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "realnuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("does NOT merge profiles that share only a display name", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem", { displayName: "Deem" }),
      profile("tiktok", "deemsworld", { displayName: "Deem" }),
    ], null);
    expect(report.clusters).toHaveLength(2);
    expect(handleReasons(report)).toHaveLength(0);
  });

  it("does NOT merge profiles that share only bio text", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem", { bio: "crash out princess" }),
      profile("tiktok", "someoneelse", { bio: "crash out princess" }),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("never merges a multi-artifact cluster without an explicit merge reason (safety)", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem"),
      profile("x", "someoneelse", { displayName: "Deem", bio: "crash out princess" }),
    ], null);
    for (const cluster of report.clusters) {
      if (cluster.artifacts.length > 1) {
        expect(cluster.mergeReasons.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not treat one artifact's duplicated handle (value + metadata) as a merge", () => {
    // kind=username carries the handle in BOTH its value and metadata.handle.
    // That is one source, not two, so it must stay a singleton with no reason.
    const single: Artifact = {
      id: "artifact-dup", kind: "username", value: "soloact",
      confidence: 50, source: "test", created_at: "2026-06-12T00:00:00.000Z",
      metadata: { handle: "@soloact" },
    };
    const report = buildIdentityClusters([single], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toHaveLength(0);
    expect(report.clusters[0].confidence).toBe(50);
  });

  it("leaves shared-infrastructure behavior unchanged and labels its reason", () => {
    // Below the fan-out threshold: a parent selector still merges two names,
    // exposes a SHARED_INFRASTRUCTURE reason, and emits no infra-split warning.
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "case-x" }),
      artifact("email", "m@example.com", { parent: "case-x" }),
      artifact("email", "m@example.com", { source_record: "second" }),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("EMAIL_MATCH: m@example.com");
    expect(report.clusters[0].mergeReasons.some((r) => r.startsWith("SHARED_INFRASTRUCTURE"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("Shared-infrastructure split"))).toBe(false);
  });
});
