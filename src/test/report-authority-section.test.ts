/**
 * report-authority-section.test.ts — #499, the producer half.
 *
 * The selector is useless if no analyst-facing surface renders it. These drive
 * `buildReportMarkdown` (copy/markdown export) directly; the rendered Report tab
 * is covered by the CaseReport test, and `report-authority-wiring.test.ts` pins
 * that ReportTab actually computes and passes the result to both.
 */
import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "@/lib/intel";
import { AUTHORITY_HEADING, selectAuthoritativeFindings } from "@/lib/authoritative-findings";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> & { id: string }): Artifact => ({
  kind: "finding", value: "the adjudicated conclusion", confidence: 50,
  source: "oathnet_lookup", created_at: "2026-08-24T00:00:00Z", metadata: {},
  ...over,
} as Artifact);

/** Just the authority section. Scoped on purpose: the Artifact Table legitimately
 *  lists every artifact, including ones this section withholds, so a whole-document
 *  `not.toContain` would assert something false about the Report's other sections. */
const section = (out: string): string => {
  const start = out.indexOf(`## ${AUTHORITY_HEADING}`);
  if (start === -1) return "";
  const next = out.indexOf("\n## ", start + 1);
  return next === -1 ? out.slice(start) : out.slice(start, next);
};

const md = (artifacts: Artifact[], opts = {}, reviews = {}) =>
  buildReportMarkdown({
    seedValue: "someone@example.com", seedType: "email", artifacts, reviews,
    authority: selectAuthoritativeFindings(artifacts, reviews, {
      ceilingHit: false, retrievalFailed: false, reviewsAvailable: true, ...opts,
    }),
  });

describe("the Report carries the engine's adjudication, not only its own labels", () => {
  it("PRODUCTION SHAPE: high-confidence ordinary rows, zero findings", () => {
    // 49 ordinary artifacts, several above the Likely boundary, none adjudicated.
    // The Report's own Key Findings section may still list CONFIRMED-labelled
    // rows — that is its job — but it must now also say the engine adjudicated
    // nothing, so the analyst can tell the two apart.
    const rows = Array.from({ length: 49 }, (_, i) =>
      art({ id: `a${i}`, kind: ["name", "email", "breach_exposure"][i % 3],
            value: `ordinary ${i}`, confidence: 60 + (i % 29) }));
    const out = md(rows);
    expect(out).toContain(AUTHORITY_HEADING);
    expect(out).toContain("adjudicated no findings");
    expect(out).toContain("49 artifacts were collected");
  });

  it("lists adjudicated findings with the capped number and its tier", () => {
    const out = md([art({ id: "f1", value: "the adjudicated conclusion", confidence: 95,
                          metadata: { confidence_cap_applied: 70 } })]);
    expect(out).toContain("the adjudicated conclusion");
    expect(section(out)).toContain("70%");
    expect(section(out)).not.toContain("95%");
  });

  it("never claims none when the artifact read failed", () => {
    const out = md([], { retrievalFailed: true });
    expect(out).toContain(AUTHORITY_HEADING);
    expect(out).toContain("unavailable");
    expect(out).not.toContain("adjudicated no findings");
  });

  it("never claims none when verdicts were unreadable", () => {
    const sec = section(md([art({ id: "f1" })], { reviewsAvailable: false }));
    expect(sec).toContain("unavailable");
    expect(sec).not.toContain("adjudicated no findings");
    // Withheld from THIS section. The Artifact Table still lists the row, which is
    // correct — that table is an inventory, not an authority claim.
    expect(sec).not.toContain("the adjudicated conclusion");
  });

  it("discloses a retrieval ceiling", () => {
    expect(md([art({ id: "f1" })], { ceilingHit: true })).toContain("may be incomplete");
  });

  it("excludes an analyst-rejected finding and says so", () => {
    const sec = section(md([art({ id: "f1", value: "rejected one" }), art({ id: "f2", value: "standing one" })],
                           {}, { f1: "dismissed" }));
    expect(sec).toContain("standing one");
    expect(sec).not.toContain("rejected one");
    expect(sec).toContain("excluded by analyst review");
  });

  it("appears in the condensed brief too, not only the full dossier", () => {
    const out = buildReportMarkdown({
      seedValue: "someone@example.com", seedType: "email", artifacts: [], reviews: {}, reportType: "brief",
      authority: selectAuthoritativeFindings([], {}, { ceilingHit: false, retrievalFailed: false, reviewsAvailable: true }),
    });
    expect(out).toContain(AUTHORITY_HEADING);
  });

  it("omits the section entirely when no authority result is supplied", () => {
    // Backwards compatible: every other caller of buildReportMarkdown keeps working.
    const out = buildReportMarkdown({ seedValue: "x@y.z", seedType: "email", artifacts: [], reviews: {} });
    expect(out).not.toContain(AUTHORITY_HEADING);
  });
});
