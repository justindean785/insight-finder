/**
 * tool-audit-attested — "high-confidence" in Tool Coverage means evidence strength, not an analyst click.
 *
 * Tool Coverage counted ATTESTED rows (an analyst's Confirm / Key decision) as high-confidence, so a vision summary at
 * confidence 45 read "1 high-confidence". ATTESTED is its own rung: a decision, not a second source. It is now counted
 * apart (`attested`), reported as "analyst-confirmed", and never added to `highConf`.
 *
 * VALUES ARE SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown, buildToolAudit } from "@/lib/intel";

let n = 0;
const art = (over: Partial<Artifact> = {}): Artifact => {
  n++;
  return {
    id: over.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "avatar", value: "avatar description", confidence: 45, source: "gemini_vision",
    created_at: "2026-09-25T18:00:00.000Z",
    metadata: { source_category: ["ai_summary"] },
    ...over,
  } as Artifact;
};

const section = (md: string, heading: string): string => {
  const start = md.indexOf(heading);
  if (start === -1) return "";
  const after = start + heading.length;
  const next = md.indexOf("\n## ", after);
  return md.slice(after, next === -1 ? undefined : next);
};

describe("tool coverage — analyst confirmation is not high confidence", () => {
  it("an ATTESTED row at confidence 45 is counted as attested, not high-confidence", () => {
    const a = art();
    const entry = buildToolAudit([a], { [a.id]: "confirmed" }).tools.find((t) => t.tool.includes("gemini"))!;
    expect(entry.highConf).toBe(0);
    expect(entry.attested).toBe(1);
  });

  it("a genuinely corroborated row is still high-confidence, and not attested", () => {
    const strong = art({
      kind: "email", value: "qa.audit@example.invalid", source: "hunter_email_verifier", confidence: 90,
      metadata: { source_category: ["official", "independent_public"], sources: ["court_records", "news_archive"] },
    });
    const entry = buildToolAudit([strong]).tools[0];
    expect(entry.highConf).toBe(1);
    expect(entry.attested).toBe(0);
  });

  it("with no analyst decision nothing is attested", () => {
    expect(buildToolAudit([art()]).tools[0].attested).toBe(0);
  });

  it("the report line says analyst-confirmed, not high-confidence", () => {
    const a = art();
    const md = buildReportMarkdown({
      seedValue: "qa.audit@example.invalid", seedType: "email", artifacts: [a], messages: [], reviews: { [a.id]: "confirmed" },
    });
    const cov = section(md, "## Tool Coverage Summary");
    expect(cov).toContain("0 high-confidence");
    expect(cov).toContain("1 analyst-confirmed");
  });

  it("the report line is unchanged when nothing is attested (no empty 'analyst-confirmed' clause)", () => {
    const md = buildReportMarkdown({ seedValue: "qa.audit@example.invalid", seedType: "email", artifacts: [art()], messages: [] });
    expect(section(md, "## Tool Coverage Summary")).not.toContain("analyst-confirmed");
  });
});
