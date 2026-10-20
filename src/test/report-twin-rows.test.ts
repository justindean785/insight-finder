/**
 * #593 — the report counts VALUES, not records.
 *
 * The thread hook keeps one item per database record when records of the same value differ in authority (each under its
 * own — nothing is merged). The report must not read that as more findings: the summary counts distinct values and says
 * how many records back them, and Key Findings / Leads name each value once. The rows themselves are untouched.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown } from "@/lib/intel";

const row = (over: Partial<Artifact> = {}): Artifact => ({
  id: over.id ?? "r1", kind: "email", value: "qa.twin@example.invalid", confidence: 40,
  source: "hunter_email_verifier", created_at: "2026-09-02T00:00:00Z",
  metadata: { source_category: ["infra_registry"], confidence_cap_applied: 65 }, ...over,
} as Artifact);

const report = (artifacts: Artifact[], reviews: Record<string, "confirmed" | "dismissed" | "new"> = {}) =>
  buildReportMarkdown({ seedValue: "qa.twin@example.invalid", seedType: "email", artifacts, messages: [], reviews });

describe("report counts values, not records (#593)", () => {
  it("two records of one value read as ONE artifact backed by two records — in the summary and the header block", () => {
    const md = report([row({ id: "a", source: "tool_a" }), row({ id: "b", source: "tool_b" }), row({ id: "c", value: "other@example.invalid" })]);
    expect(md).toContain("Observed 2 artifacts (3 records) across");
    expect(md).toContain("**Artifacts recorded:** 2 (3 records)");
  });

  it("with no duplicate records the wording is exactly what it was", () => {
    const md = report([row({ id: "a" }), row({ id: "c", value: "other@example.invalid" })]);
    expect(md).toContain("Observed 2 artifacts across");
    expect(md).toContain("**Artifacts recorded:** 2\n");
    expect(md).not.toMatch(/\(\d+ records\)/);
  });

  it("Key Findings (analyst-confirmed) names the value once and says another record exists — no authority moves", () => {
    const md = report([row({ id: "a", source: "tool_a" }), row({ id: "b", source: "tool_b" })], { a: "confirmed" });
    const bullets = md.split("\n").filter((l) => l.startsWith("- **email**") && l.includes("qa.twin@example.invalid"));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("analyst-confirmed");
    expect(bullets[0]).toContain("1 other record of this value");
    // the sibling did not inherit the decision: still exactly one analyst-confirmed item
    expect(md).toContain("1 item analyst-confirmed");
  });

  it("Key Findings names the value once even when BOTH records carry an analyst decision", () => {
    const md = report([row({ id: "a", source: "tool_a" }), row({ id: "b", source: "tool_b" })], { a: "confirmed", b: "confirmed" });
    const bullets = md.split("\n").filter((l) => l.startsWith("- **email**") && l.includes("qa.twin@example.invalid"));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("1 other record of this value");
  });

  it("Leads (no corroborated finding) also name each value once", () => {
    const lead = (id: string, source: string) => row({ id, source, confidence: 70, metadata: { source_category: ["public_record"] } });
    const md = report([lead("a", "census"), lead("b", "nominatim"), lead("c", "x")].map((a, i) => (i === 2 ? { ...a, value: "other@example.invalid" } : a)));
    const bullets = md.split("\n").filter((l) => l.startsWith("- **email**"));
    const values = bullets.map((l) => (l.match(/`([^`]+)`/) ?? [])[1]);
    expect(new Set(values).size).toBe(values.length); // each value once
  });

  it("the input rows are not modified", () => {
    const rows = [row({ id: "a", source: "tool_a" }), row({ id: "b", source: "tool_b" })];
    const before = JSON.stringify(rows);
    report(rows, { a: "confirmed" });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
