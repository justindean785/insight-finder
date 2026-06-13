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
    expect(pivots[0]).toMatchObject({ value: "scero@me.com", type: "email" });
    expect(pivots[1]).toMatchObject({ value: "Exavier Hill-Larot", type: "name" });
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
});
