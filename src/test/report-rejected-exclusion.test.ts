/**
 * report-rejected-exclusion.test.ts — reports and the exported Evidence Matrix
 * exclude analyst-rejected evidence from ACTIVE sections while preserving it in
 * the forensic table.
 *
 * BEFORE: `buildEvidenceMatrixMarkdown(artifacts)` was called WITHOUT the
 * reviews, so a dismissed row rendered with its source-derived label (e.g.
 * CORRELATED) in the exported matrix, and the "Network Connections" section
 * excluded quarantined/collision rows but not analyst-rejected ones.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildEvidenceMatrixMarkdown, buildReportMarkdown } from "@/lib/intel";

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `rx${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 88,
    source: partial.source ?? "court_record_search",
    created_at: partial.created_at ?? `2026-03-02T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? { sources: ["court_record_search", "opencorporates_search"], source_category: ["public_record", "corporate_registry"], parent: "seed@example.com" },
  };
}

const REJECTED = art({ id: "bad", kind: "email", value: "wrong.person@example.com" });
const KEPT = art({ id: "good", kind: "email", value: "right.person@example.com" });

describe("buildEvidenceMatrixMarkdown", () => {
  it("FAILURE-FIRST: without reviews the rejected row still carries an active label", () => {
    const md = buildEvidenceMatrixMarkdown([REJECTED]);
    const row = md.split("\n").find((l) => l.includes("wrong.person@example.com"))!;
    expect(row).not.toContain("| FAILED |");
  });

  it("⛔ with reviews the rejected row is LISTED (forensic history) but reads FAILED", () => {
    const md = buildEvidenceMatrixMarkdown([REJECTED, KEPT], { bad: "dismissed" });
    const bad = md.split("\n").find((l) => l.includes("wrong.person@example.com"))!;
    const good = md.split("\n").find((l) => l.includes("right.person@example.com"))!;
    expect(bad).toContain("| FAILED |");
    expect(good).not.toContain("| FAILED |");
  });
});

describe("buildReportMarkdown", () => {
  const md = buildReportMarkdown({
    seedValue: "seed@example.com", seedType: "email",
    artifacts: [REJECTED, KEPT],
    reviews: { bad: "wrong" },
  });
  const section = (heading: RegExp) => {
    const lines = md.split("\n");
    const start = lines.findIndex((l) => heading.test(l));
    if (start < 0) return "";
    const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
  };

  it("⛔ the rejected selector leaves Key Findings and Network Connections", () => {
    expect(section(/key findings/i)).not.toContain("wrong.person@example.com");
    expect(section(/network connections/i)).not.toContain("wrong.person@example.com");
    expect(section(/network connections/i)).toContain("right.person@example.com");
  });

  it("…but remains in the artifact / entity table as FAILED (preserved, not deleted)", () => {
    const row = md.split("\n").find((l) => l.startsWith("|") && l.includes("wrong.person@example.com"));
    expect(row).toBeDefined();
    expect(row).toContain("| FAILED |");
  });

  it("the executive summary counts it as analyst-rejected", () => {
    expect(md).toMatch(/1 analyst-rejected/);
  });
});
