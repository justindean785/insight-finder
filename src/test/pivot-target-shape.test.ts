/**
 * The producer/validator shape contract.
 *
 * `TARGET_SHAPE` is ONE table, read by `pivot-schema` (may this suggestion get
 * a Run button?) and by `recommended-pivots` (is the token after a named
 * selector class actually that kind of selector?). These tests drive the
 * SHIPPED functions rather than re-asserting the regexes, because the property
 * that matters is that the two ends agree — a test that only re-described the
 * table could not tell whether they do.
 *
 * ⚠️ WHAT IS DELIBERATELY *NOT* TESTED HERE: that a malformed report line is
 * dropped. It is not, and must not be. A suggestion the validator refuses stays
 * on the rail as a non-runnable "Suggestion needs repair" card — see
 * `pivot-schema`'s docstring and the e2e `next steps › 9 · a malformed
 * generated pivot is quarantined and cannot run`. That is the same
 * disclosure-not-deletion rule quarantined artifacts get, and the case against
 * changing it is in `docs/next-steps-repair-cards.md`.
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

describe("malformed report lines stay visible and stay inert", () => {
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

  it("the real selector is runnable and the three prose lines are not", () => {
    const cards = cardsFor(PRODUCTION_REPORT);
    const runnable = cards.filter((c) => c.validation.status === "valid").map((c) => c.rec.value);
    expect(runnable).toEqual(["baigazhar042@gmail.com"]);
    // The other three are NOT dropped — they reach the rail as repair cards.
    expect(cards).toHaveLength(4);
  });

  it("every refused card carries a stated reason the analyst can read", () => {
    for (const { validation } of cardsFor(PRODUCTION_REPORT)) {
      if (validation.status === "invalid") {
        expect(validation.problems.length).toBeGreaterThan(0);
        expect(validation.problems.every((p) => p.trim().length > 0)).toBe(true);
      }
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

  it("a recovered selector is actually RUNNABLE, not just better-looking", () => {
    const [card] = cardsFor("## Recommended Next Pivots\n- Corroborate username jdoe88 across platforms");
    expect(card.validation.status).toBe("valid");
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

describe("email shape rejects Markdown around the address", () => {
  it("backticks, quotes and brackets are not part of an email", async () => {
    const { isWellFormedTarget } = await import("@/lib/pivot-target-shape");
    for (const v of ["`jane@uni.example`", "'jane@uni.example'", "\"jane@uni.example\"", "(jane@uni.example)", "<jane@uni.example>"]) {
      expect(isWellFormedTarget("email", v), v).toBe(false);
    }
    expect(isWellFormedTarget("email", "jane.doe+tag@uni.example")).toBe(true);
  });
});
