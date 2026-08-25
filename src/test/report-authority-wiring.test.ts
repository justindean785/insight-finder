/**
 * report-authority-wiring.test.ts — #499.
 *
 * The selector and the section renderer both have thorough unit tests, and every
 * one of them would keep passing if ReportTab stopped calling them. "Correct
 * module, never invoked" is a regression shape this repo has already paid for.
 *
 * It also pins the properties that live in the CALL SITE and that a unit test
 * cannot reach: that ONE result is computed and handed to BOTH producers (so the
 * rendered Report and the markdown export cannot disagree), and that the review
 * signal is read as fail-closed rather than fail-open.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const TAB = read("src/components/panel/ReportTab.tsx");
const CASE = read("src/components/panel/CaseReport.tsx");
const INTEL = read("src/lib/intel.ts");

describe("ReportTab actually computes the authority result", () => {
  it("calls the selector", () => {
    expect(TAB).toContain("selectAuthoritativeFindings");
  });

  it("feeds it the retrieval signals that already existed", () => {
    expect(TAB).toContain("ceilingHit:");
    expect(TAB).toContain("retrievalFailed:");
    expect(TAB).toMatch(/hasMore/);
  });

  it("reads review availability FAIL-CLOSED", () => {
    // `availability === "ok"` — anything else (unknown, unavailable) withholds.
    // A truthiness check would fail OPEN on the string "unavailable".
    expect(TAB).toContain('review.availability === "ok"');
  });
});

describe("the same result reaches BOTH producers", () => {
  it("is passed to the markdown export", () => {
    const call = TAB.slice(TAB.indexOf("buildReportMarkdown({"), TAB.indexOf("const matrixMd"));
    expect(call).toContain("authority");
  });

  it("is passed to the rendered report", () => {
    expect(TAB).toMatch(/<CaseReport[^>]*authority=\{authority\}/s);
  });

  it("is computed once, not per producer", () => {
    // Two independent computations could drift; one memo cannot.
    const calls = TAB.match(/selectAuthoritativeFindings\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe("the producers render it", () => {
  it("CaseReport renders the shared statement, not its own wording", () => {
    expect(CASE).toContain("authorityStatement(authority)");
    expect(CASE).toContain("AUTHORITY_HEADING");
  });

  it("buildReportMarkdown emits the section", () => {
    expect(INTEL).toContain("authoritySection(authority)");
    expect(INTEL).toContain("authorityStatement");
  });

  it("the section sits ABOVE Key Findings in both report shapes", () => {
    // Placement is load-bearing: the section exists to qualify what follows.
    const occurrences = [...INTEL.matchAll(/\.\.\.authoritySection\(authority\),\n\s*`## Key Findings`/g)];
    expect(occurrences.length).toBe(2);
  });

  it("neither producer reaches for adjustedConfidence for this block", () => {
    // The authoritative number is min(confidence, cap) with NO review deltas.
    const panel = CASE.slice(CASE.indexOf("{authority && ("), CASE.indexOf("Analyst confidence vs strict"));
    expect(panel).not.toContain("adjustedConfidence");
    expect(panel).not.toContain("labelForArtifact");
  });
});
