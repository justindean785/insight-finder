import { describe, expect, it } from "vitest";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";

describe("extractRecommendedPivots", () => {
  it("extracts the final report recommendations in display order", () => {
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person, 3-breach corroboration
- Investigate Exavier Hill-Larot — independent identity check
- Cross-reference Exavier Hill-Larot's Oakley PO Box with public records
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots.map((pivot) => pivot.label)).toEqual([
      "Investigate sam.cole@example.com — same person, 3-breach corroboration",
      "Investigate Exavier Hill-Larot — independent identity check",
      "Cross-reference Exavier Hill-Larot's Oakley PO Box with public records",
    ]);
    expect(pivots[0]).toMatchObject({
      value: "sam.cole@example.com",
      type: "email",
      actionLabel: "Verify email ownership",
      detail: "sam.cole@example.com · same person, 3-breach corroboration",
    });
    expect(pivots[1]).toMatchObject({
      value: "Exavier Hill-Larot",
      type: "name",
      actionLabel: "Review lead",
    });
  });

  it("does not treat later report sections as pivots", () => {
    const text = `
## Recommended Next Pivots
1. Pivot on 66.87.118.76 — validate network history
## Sources
- source.example
`;
    expect(extractRecommendedPivots(text)).toHaveLength(1);
  });

  it("keeps extracting when a corroborate/confirm pivot line ends with a colon", () => {
    // Regression: extractTarget recognizes corroborate/confirm/compare, but the
    // section-break guard's verb list used to omit them, so a "Corroborate …:"
    // line was misread as a heading and stopped extraction after the first pivot.
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person
- Corroborate the Oakley PO Box with county records:
- Confirm Exavier Hill-Larot via independent identity check
`;
    const labels = extractRecommendedPivots(text).map((pivot) => pivot.label);
    expect(labels).toContain("Corroborate the Oakley PO Box with county records:");
    expect(labels).toContain("Confirm Exavier Hill-Larot via independent identity check");
    expect(labels).toHaveLength(3);
  });

  it("blocks sensitive secret-like pivots and minor-related pivots", () => {
    const text = `
## Recommended Next Pivots
- Verify leaked password hunter2 — direct breach secret
- Investigate teen profile tie-in — possible minor
- Check 925-642-7442 — corroborate line ownership
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toMatchObject({
      value: "925-642-7442",
      type: "phone",
      actionLabel: "Check phone association",
    });
  });

  it("drops source-infrastructure domains but keeps genuine subject domains", () => {
    // Regression: report-recommended domains like the CA SOS bizfile portal,
    // linkedin.com, and opencorporates.com are OSINT *sources*, not subject
    // identifiers — they must never become "Review domain footprint" pivots.
    const text = `
## Recommended Next Pivots
- Review domain footprint linkedin.com — fingerprinted on archived site
- Review domain footprint bizfileonline.sos.ca.gov — business registry source
- Review domain footprint opencorporates.com — registry source
- Review domain footprint ceroconstruction.com — subject's own domain
`;
    const pivots = extractRecommendedPivots(text);
    const values = pivots.map((p) => p.value);
    expect(values).toContain("ceroconstruction.com");
    expect(values).not.toContain("linkedin.com");
    expect(values).not.toContain("bizfileonline.sos.ca.gov");
    expect(values).not.toContain("opencorporates.com");
    expect(pivots).toHaveLength(1);
  });

  it("does not leak <think> reasoning blocks into pivot cards", () => {
    // Regression for the screenshot bug: the agent emitted a chain-of-thought
    // block inside the report text. The chat renderer strips it, but the Next
    // Steps parser used the raw text and turned reasoning lines into cards.
    const text = `
**Recommended next pivots:**
- Investigate sam.cole@example.com — same person
<think>
The detect_contradictions tool flagged 2 distinct names: Debra A. Cero vs Debra Cero.
Let me also call detect_contradictions to check for any issues.
</think>
- Corroborate the Oakley PO Box with county records
`;
    const pivots = extractRecommendedPivots(text);
    const serialized = JSON.stringify(pivots);
    expect(serialized).not.toContain("<think>");
    expect(serialized).not.toContain("</think>");
    expect(serialized).not.toContain("detect_contradictions");
    expect(serialized).not.toMatch(/Let me also call/i);
    // The two genuine pivots still come through.
    expect(pivots.map((p) => p.value)).toContain("sam.cole@example.com");
    expect(pivots.length).toBeGreaterThanOrEqual(2);
  });

  it("strips a surviving inline think fragment from an emitted field", () => {
    const text = `
## Recommended Next Pivots
- Investigate sam.cole@example.com — same person</think>
`;
    const pivots = extractRecommendedPivots(text);
    expect(JSON.stringify(pivots)).not.toContain("</think>");
  });

  it("ignores markdown table separator rows (no |---| pivots)", () => {
    // Regression: when the report renders pivots as a markdown table, the
    // separator row leaked through as a pivot with Target/Reason = "|---|---|---|".
    const text = `
## Recommended Next Pivots
| Action | Target | Type | Reason |
|---|---|---|---|
| Corroborate address | 526 Coconut Pl Brentwood CA | address | confirm ownership of record |
`;
    const pivots = extractRecommendedPivots(text);
    for (const p of pivots) {
      expect(p.value).not.toMatch(/^[\s|:_-]+$/);
      expect(p.prompt).not.toContain("|---|");
    }
    expect(pivots.some((p) => /^[\s|:_-]+$/.test(p.value))).toBe(false);
  });

  it("pivot prompt mandates recording findings (not just narrating the graph delta)", () => {
    // Regression: the old composer said "Return ... what changed in the case
    // graph", which made the agent NARRATE findings in chat and never call
    // record_artifacts → Evidence board stayed at 0 artifacts. The prompt must
    // instead require persistence before summarizing.
    const text = `
## Recommended Next Pivots
- Corroborate username pulsiveontop across platforms
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots.length).toBeGreaterThan(0);
    for (const p of pivots) {
      expect(p.prompt).toContain("record_artifacts");
      expect(p.prompt).not.toContain("what changed in the case graph");
    }
  });

  it("turns collision recommendations into safe review actions", () => {
    const text = `
## Recommended Next Pivots
- Review excluded collision Michael M Cero — likely namesake, not the same person
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toMatchObject({
      actionLabel: "Review excluded collision",
      detail: "Michael M Cero · likely namesake, not the same person",
    });
  });
});
