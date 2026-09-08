/**
 * cluster-code-and-timeline-consistency.test.ts — two F8 presentation invariants
 * from the 2026-09-08 audit (thread b74049ad).
 *
 * 1. ONE cluster code per cluster, everywhere. Codes were assigned at
 *    construction, then `buildIdentityClusters` re-sorted by confidence, and the
 *    workspace recomputed the code from render position while the export read
 *    the one baked into the label. The same cluster was C001 on screen and C002
 *    in the report. Now `id` and the label's code are assigned AFTER the sort and
 *    the workspace renders `c.id`.
 *
 * 2. Timeline truncation is DISCLOSED. The report Timeline silently
 *    `.slice(-15)`'d, dropping the first user query and all 20 artifacts from the
 *    run's opening four minutes under a heading that read as complete. The cap is
 *    now 40 and anything omitted is stated.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityClusters, buildReportMarkdown } from "@/lib/intel";
import { clusterDisplayId } from "@/lib/report-hygiene";

let seq = 0;
function art(kind: string, value: string, confidence: number, metadata: Record<string, unknown> = {}): Artifact {
  seq += 1;
  return {
    id: `cc${seq}`, kind, value, confidence, source: "test",
    created_at: `2026-09-08T06:${String(50 + (seq % 10)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}Z`,
    metadata,
  };
}

describe("F8.1 — cluster codes follow presentation order and agree with the label", () => {
  // Constructed FIRST but weaker: must end up SECOND after the confidence sort.
  const weak = [
    art("username", "alpha_user", 40),
    art("social_profile", "https://instagram.example/@alpha_user", 40, { handle: "alpha_user", platform: "instagram" }),
  ];
  // Constructed SECOND but stronger: must end up FIRST.
  const strong = [
    art("username", "beta_user", 90),
    art("social_profile", "https://twitter.example/@beta_user", 90, { handle: "beta_user", platform: "twitter" }),
  ];
  const { clusters } = buildIdentityClusters([...weak, ...strong], "alpha_user");

  it("forms two clusters and sorts the stronger one first (the reorder the bug needed)", () => {
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters[0].confidence).toBeGreaterThanOrEqual(clusters[1].confidence);
    expect(clusters[0].usernames.map((u) => u.toLowerCase())).toContain("beta_user");
  });

  it("⛔ every cluster's id is its POSITION code, and its label carries the SAME code", () => {
    clusters.forEach((c, i) => {
      expect(c.id).toBe(clusterDisplayId(i));
      expect(c.label.startsWith(`Cluster ${c.id} `)).toBe(true);
    });
    // Monotonic — the export can never print C002 above C001 again.
    expect(clusters.map((c) => c.id)).toEqual(clusters.map((_, i) => clusterDisplayId(i)));
  });
});

describe("F8.2 — the report Timeline discloses truncation instead of hiding history", () => {
  function report(n: number) {
    const artifacts = Array.from({ length: n }, (_, i) =>
      art("email", `user${i}@example.test`, 50),
    ).map((a, i) => ({ ...a, created_at: `2026-09-08T06:${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z` }));
    const md = buildReportMarkdown({ seedValue: "seed@example.test", seedType: "email", artifacts });
    return md.split("## Timeline Summary")[1]?.split("\n## ")[0] ?? "";
  }

  it("a short chronology renders in full with no truncation notice", () => {
    const t = report(10);
    expect(t).not.toContain("earlier event");
    expect(t).toContain("user0@example.test");
    expect(t).toContain("user9@example.test");
  });

  it("⛔ a long chronology says exactly how many events were omitted", () => {
    const t = report(45);
    const m = t.match(/Showing the (\d+) most recent of (\d+) events; (\d+) earlier events? omitted/);
    expect(m, "truncation must be disclosed, not silent").not.toBeNull();
    const [, shown, total, omitted] = m!.map(Number);
    expect(shown).toBe(40);
    expect(total - shown).toBe(omitted);
    expect(omitted).toBeGreaterThan(0);
    // The most recent events are the ones kept.
    expect(t).toContain("user44@example.test");
    expect(t).not.toContain("user0@example.test");
  });
});
