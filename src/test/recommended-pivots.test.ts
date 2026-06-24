import { describe, expect, it } from "vitest";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";

describe("extractRecommendedPivots", () => {
  it("extracts the final report recommendations in display order", () => {
    const text = `
**Recommended next pivots:**
- Investigate scero@me.com — same person, 3-breach corroboration
- Investigate Exavier Hill-Larot — independent identity check
- Cross-reference Exavier Hill-Larot's Oakley PO Box with public records
`;
    const pivots = extractRecommendedPivots(text);
    expect(pivots.map((pivot) => pivot.label)).toEqual([
      "Investigate scero@me.com — same person, 3-breach corroboration",
      "Investigate Exavier Hill-Larot — independent identity check",
      "Cross-reference Exavier Hill-Larot's Oakley PO Box with public records",
    ]);
    expect(pivots[0]).toMatchObject({
      value: "scero@me.com",
      type: "email",
      actionLabel: "Verify email ownership",
      detail: "scero@me.com · same person, 3-breach corroboration",
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
