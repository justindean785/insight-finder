/**
 * The producer/validator shape contract.
 *
 * These drive the SHIPPED control flow — `extractRecommendedPivots` and
 * `validatePivotSuggestion` as the app calls them — rather than re-asserting
 * the regex table. The point of the fix is that those two agree; a test that
 * only re-describes `TARGET_SHAPE` could not tell whether they do.
 */
import { describe, it, expect } from "vitest";
import { extractRecommendedPivots, toDisplayPivots } from "@/lib/recommended-pivots";
import { validatePivotSuggestion, pivotSuggestionInput } from "@/lib/pivot-schema";
import { isWellFormedTarget, targetShapeProblems } from "@/lib/pivot-target-shape";
import type { DisplayPivot } from "@/lib/pivot-engine";

/** Run a report through the real path a Next-steps card takes. */
function cardsFor(report: string) {
  const recs = extractRecommendedPivots(report);
  return toDisplayPivots(recs).map((p, i) => ({
    rec: recs[i],
    validation: validatePivotSuggestion(pivotSuggestionInput({
      ...(p as DisplayPivot),
      priority: recs[i].priority,
      actionLabel: recs[i].actionLabel,
      reason: recs[i].reason,
      prompt: recs[i].prompt,
    } as DisplayPivot)),
  }));
}

describe("report pivots never reach the rail as prose", () => {
  // Verbatim from the 2026-09-12 `baig_azhar` production case: three of the
  // four Next-steps cards rendered as "Suggestion needs repair".
  const PRODUCTION_REPORT = [
    "## Recommended Next Pivots",
    "",
    '- Review the "freelance writer" claim',
    "- Search Memphis-area ICE protest coverage — did Azhar Baig appear in any byline, credit line, photo caption or on-camera credit between January and February 2026 in Minneapolis or Saint Paul",
    "- Examine the attached image for EXIF data — if the capture timestamp and GPS coordinates survive upload they would place the photographer at a specific place and time rather than merely near one",
    "- Verify baigazhar042@gmail.com",
  ].join("\n");

  it("drops the three prose lines and keeps the one real selector", () => {
    const recs = extractRecommendedPivots(PRODUCTION_REPORT);
    expect(recs.map((r) => r.value)).toEqual(["baigazhar042@gmail.com"]);
    expect(recs[0].type).toBe("email");
  });

  it("emits no card the validator would refuse", () => {
    for (const { rec, validation } of cardsFor(PRODUCTION_REPORT)) {
      expect(
        validation.status,
        `"${rec.value}" was emitted but is ${validation.status}`,
      ).toBe("valid");
    }
  });

  it("still emits ordinary selector recommendations of every pivotable type", () => {
    const recs = extractRecommendedPivots([
      "## Recommended Next Pivots",
      "- Verify analyst@example.com",
      "- Check @jharker88 across platforms",
      "- Review 203.0.113.44",
      "- Investigate Jordan Vale — the registrant name",
    ].join("\n"));
    expect(recs.map((r) => [r.type, r.value])).toEqual([
      ["email", "analyst@example.com"],
      ["username", "@jharker88"],
      ["ip", "203.0.113.44"],
      ["name", "Jordan Vale"],
    ]);
  });

  it("a six-word name is kept and a seven-word one is not — the producer uses the validator's own bound", () => {
    const six = extractRecommendedPivots("## Recommended Next Pivots\n- Investigate Ana Maria Sofia Luisa Vale Castro");
    expect(six).toHaveLength(1);
    const seven = extractRecommendedPivots("## Recommended Next Pivots\n- Investigate Ana Maria Sofia Luisa Vale Castro Ruiz");
    expect(seven).toHaveLength(0);
  });
});

describe("a line that names its own selector class yields that selector", () => {
  const pivots = (line: string) => extractRecommendedPivots(`## Recommended Next Pivots\n${line}`);

  it("reads the token after the kind word instead of the whole action clause", () => {
    // Before, the value was "username jdoe88 across platforms" — not runnable,
    // and unmatchable against the tool log's already-searched selectors, so the
    // card was re-offered on every render however deep the run had gone.
    expect(pivots("- Corroborate username jdoe88 across platforms").map((p) => [p.type, p.value]))
      .toEqual([["username", "jdoe88"]]);
    expect(pivots("- Check ip address 203.0.113.44 for attribution").map((p) => [p.type, p.value]))
      .toEqual([["ip", "203.0.113.44"]]);
    expect(pivots("- Review domain: example.com").map((p) => [p.type, p.value]))
      .toEqual([["domain", "example.com"]]);
  });

  it("does not treat the next word as a selector when it is not shaped like one", () => {
    // "Verify email ownership" must not yield the selector "ownership".
    expect(pivots("- Verify email ownership").map((p) => p.value)).not.toContain("ownership");
    expect(pivots("- Review domain footprint thoroughly").map((p) => p.value)).not.toContain("footprint");
  });

  it("does not truncate a multi-word name — `name` is not a kind-led selector", () => {
    expect(pivots("- Investigate the name Jordan Vale").map((p) => p.value)).toEqual(["the name Jordan Vale"]);
  });
});

describe("targetShapeProblems is the single shape authority", () => {
  it("reports every reason a sentence fails as a name, in the analyst's wording", () => {
    const problems = targetShapeProblems("name", "Search Memphis-area ICE protest coverage during the Renee Good timeframe");
    expect(problems).toContain("target is not a name");
    expect(problems.some((p) => /a sentence, not a name$/.test(p))).toBe(true);
  });

  it("accepts well-formed selectors of each type", () => {
    expect(isWellFormedTarget("email", "a@b.co")).toBe(true);
    expect(isWellFormedTarget("username", "@baig_azhar")).toBe(true);
    expect(isWellFormedTarget("domain", "example.com")).toBe(true);
    expect(isWellFormedTarget("url", "https://example.com/x")).toBe(true);
    expect(isWellFormedTarget("ip", "68.32.250.40")).toBe(true);
    expect(isWellFormedTarget("name", "Azhar Baig")).toBe(true);
    expect(isWellFormedTarget("phone", "+1 (415) 555-0143")).toBe(true);
  });

  it("agrees with the schema on the same target, in both directions", () => {
    const base = {
      id: "x", priority: "medium" as const, action: "Review lead",
      reason: "a stated rationale", sourceArtifactIds: [], basis: "b",
      prompt: "p", status: "new" as const,
    };
    for (const target of ["Azhar Baig", "a sentence that is far too long to be anybody's actual legal name at all"]) {
      const schemaSaysValid =
        validatePivotSuggestion({ ...base, target, targetType: "name" }).status === "valid";
      expect(schemaSaysValid).toBe(isWellFormedTarget("name", target));
    }
  });
});
