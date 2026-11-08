/**
 * A malformed `phone` ARTIFACT must never become a pivot.
 *
 * The report-text path already gated phones through `isPlausiblePhone`
 * (recommended-pivots.ts). The artifact path — `buildPivots` → `computePivots`
 * — did not, so a phone row persisted from an uploaded document as one
 * 10-digit number written twice ("two concatenated copies") was offered as a
 * paid "Check phone association" lookup. Synthetic 555 numbers only.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildPivots } from "@/lib/intel";
import { computePivots } from "@/lib/pivot-engine";

let seq = 0;
function phone(value: string, over: Partial<Artifact> = {}): Artifact {
  seq += 1;
  return {
    id: `p${seq}`,
    kind: "phone",
    value,
    confidence: 80,
    source: "attachment",
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: {},
    ...over,
  } as Artifact;
}

const DOUBLED = "41555501424155550142"; // 415-555-0142 twice, no separator
const DOUBLED_FORMATTED = "415-555-0142 415-555-0142";

const buildValues = (rows: Artifact[]) => buildPivots(rows, null).map((p) => p.value);
const computeValues = (rows: Artifact[]) =>
  computePivots({ artifacts: rows, seedValue: null, reportPivots: [], skipSet: new Set() })
    .filter((p) => p.type === "phone")
    .map((p) => p.value);

describe("phone artifacts are gated by isPlausiblePhone", () => {
  it.each([DOUBLED, DOUBLED_FORMATTED])("buildPivots drops the doubled value %s", (value) => {
    expect(buildValues([phone(value)])).toEqual([]);
  });

  it("computePivots (the Next pivots card source) drops the doubled value", () => {
    expect(computeValues([phone(DOUBLED)])).toEqual([]);
    expect(computeValues([phone(DOUBLED_FORMATTED)])).toEqual([]);
  });

  it("drops a non-NANP-shaped 10-digit value (area code starts with 1)", () => {
    expect(buildValues([phone("1235550142")])).toEqual([]);
  });

  it("drops a date that was filed as a phone", () => {
    expect(buildValues([phone("2023-02-02")])).toEqual([]);
  });

  it("keeps formatted and bare well-formed phone artifacts", () => {
    expect(buildValues([phone("+1 (415) 555-0142")])).toEqual(["+1 (415) 555-0142"]);
    // kind=phone IS the context a bare digit run needs.
    expect(buildValues([phone("4155550142")])).toEqual(["4155550142"]);
    expect(computeValues([phone("(415) 555-0142")])).toEqual(["(415) 555-0142"]);
  });

  it("a bad phone does not suppress a good one beside it", () => {
    expect(buildValues([phone(DOUBLED), phone("415-555-0199")])).toEqual(["415-555-0199"]);
  });
});
