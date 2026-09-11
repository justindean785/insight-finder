import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeAssertedConfidence, findAssertedConfidence } from "@/lib/asserted-confidence";
import { buildReportMarkdown } from "@/lib/intel";

/**
 * A confidence figure written into an artifact's VALUE is a claim, not a score.
 * Verbatim shapes from the 2026-09-11 case (names sanitised): the engine scored
 * these rows 55 and 80 while their text said 92% and 90%+.
 */
describe("findAssertedConfidence", () => {
  it("finds the model's own verdict written into a value", () => {
    expect(findAssertedConfidence("Subject Person (S. Person) — primary identity cluster confirmed at 92% confidence by minimax_correlate"))
      .toEqual({ pct: 92, phrase: expect.stringContaining("92%") });
    expect(findAssertedConfidence("Subject Person (S. Person) — identity cluster now at 90%+ via breach phone match + IP geolocation")?.pct).toBe(90);
    expect(findAssertedConfidence("Match is 85% certain based on shared phone")?.pct).toBe(85);
    expect(findAssertedConfidence("verified to 97.5% by correlation")?.pct).toBe(97.5);
  });

  it("leaves ordinary values alone — counts, bare percentages, a tool's own match score", () => {
    for (const v of [
      "andi@mail.example — exposed in 17 breaches: X/Twitter, MGM Resorts, AT&T",
      "Norman Carter (short name) — OathNet returned 26+ same-name collision records",
      "APN 127-0860-016 — 9636 Broad Stripes Way",
      "51% of records share this ZIP",
      "face match 87% against the reference photo",
      "Hunter.io: address is UNDELIVERABLE (invalid SMTP)",
      "",
    ]) expect(findAssertedConfidence(v), v).toBeNull();
    expect(findAssertedConfidence(null)).toBeNull();
    expect(findAssertedConfidence("cluster confirmed at 250% confidence")).toBeNull();
  });

  it("describes the claim beside the engine's figure", () => {
    const c = findAssertedConfidence("identity cluster confirmed at 92% confidence")!;
    expect(describeAssertedConfidence(c, 55)).toBe("claims 92% in its text — not a score; engine confidence 55");
    expect(describeAssertedConfidence(c, null)).toBe("claims 92% in its text — not a score");
  });
});

describe("the Markdown export prints the claim as a claim", () => {
  const art = (over: { id: string; kind: string; value: string; confidence: number }) => ({
    thread_id: "t1", source: "minimax_correlate", created_at: "2026-09-11T12:28:50Z", updated_at: "2026-09-11T12:28:50Z",
    metadata: { source_category: ["ai_summary"] }, ...over,
  });

  it("annotates the artifact-table value next to the real confidence", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com", seedType: "email",
      artifacts: [art({ id: "c1", kind: "source_person", value: "Subject — identity cluster confirmed at 92% confidence by minimax_correlate", confidence: 55 })] as never,
    });
    const row = md.split("\n").find((l) => l.startsWith("| Subject — identity cluster"));
    expect(row).toContain("⚠ claims 92% in its text — not a score; engine confidence 55");
    expect(row).toMatch(/\| 55 \|/);
  });

  it("annotates an analyst-confirmed Key Finding too", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com", seedType: "email",
      artifacts: [art({ id: "c2", kind: "source_person", value: "Subject — identity cluster now at 90%+ via breach phone match", confidence: 80 })] as never,
      reviews: { c2: "confirmed" },
    });
    const line = md.split("\n").find((l) => l.startsWith("- **source_person**"));
    expect(line).toContain("claims 90% in its text — not a score");
  });
});

describe("every surface that prints a value prints the note", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  it("the evidence board row and the evidence drawer render AssertedConfidenceNote", () => {
    const src = read("src/components/ResourcesPanel.tsx");
    expect(src).toMatch(/<AssertedConfidenceNote value=\{a\.value\} engine=\{shown\.effective\}/);
    expect(src).toMatch(/<AssertedConfidenceNote value=\{artifact\.value\} engine=\{shownArtifact\.effective\}/);
  });
});
