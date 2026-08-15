import { describe, it, expect } from "vitest";
import { extractRecommendedPivots } from "@/lib/recommended-pivots";
import { normalizeTarget, entityKey } from "@/lib/next-step-cards";
import { __collectTargets as collectTargets } from "@/hooks/useThreadQueriedTargets";
import { computePivots, canonicalKey } from "@/lib/pivot-engine";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * "Same pivots every time, no matter how far we've got."
 *
 * The intended lifecycle is:
 *
 *   report recommends X → new → tool log shows X queried → searched
 *     → gone from Chat's Next Steps → still visible in the Pivots tab
 *
 * Chat already implements the last two steps (`ChatWindow` takes only
 * `status === "new"`, and the Pivots tab keeps everything). What never happened
 * was the middle one: nothing could ever BECOME searched, because the two sides
 * of that comparison were computed from different strings.
 *
 * `computePivots` asks `queriedSet.has(normalizeTarget(pivot.value))`. Two
 * independent bugs made that key unmatchable, so a mature investigation with few
 * genuinely-new leads recycled the same three cards forever:
 *
 *   1. the parser left report prose in `value` ("lead: hawkcapo - YouTube channel")
 *   2. a web search that populates only `input.query` left no footprint at all
 *
 * These tests use the real report vocabulary from a live case, because that is
 * the input that produced the bug.
 */

const REPORT = [
  "## Recommended pivots",
  "- Review lead: hawkcapo - YouTube channel — Name discovered via public-source search",
  "- Review lead: Gregory Bradley — Name discovered via recalling prior case",
  "- Review lead: hawkcapo - GitHub — Name discovered via checking developer profiles",
].join("\n");

describe("a report recommendation resolves to a target a tool could have run", () => {
  it("strips the action noun and the descriptor suffix", () => {
    const keys = extractRecommendedPivots(REPORT).map((p) => normalizeTarget(p.value));
    expect(keys).toEqual(["hawkcapo", "gregory bradley", "hawkcapo"]);
  });

  it("does not eat hyphens inside an identifier", () => {
    // Only a SPACED hyphen separates an entity from its descriptor. Losing this
    // distinction would truncate real handles and names.
    const md = [
      "## Recommended pivots",
      "- Review lead: hawk-capo",
      "- Investigate Jean-Luc Bernard",
    ].join("\n");
    const keys = extractRecommendedPivots(md).map((p) => normalizeTarget(p.value));
    expect(keys).toEqual(["hawk capo", "jean luc bernard"]);
  });

  it("still prefers a direct identifier over any prose around it", () => {
    const md = ["## Recommended pivots", "- Review lead: contact greg@example.com - primary email"].join("\n");
    expect(extractRecommendedPivots(md)[0]?.value).toBe("greg@example.com");
  });
});

describe("a free-text search leaves a footprint", () => {
  it("records a quoted phrase from a web-search query", () => {
    const set = new Set<string>();
    collectTargets({ input: { query: '"Gregory Bradley" Sacramento public records' }, runtime: { selector: "" } }, set);
    expect(set.has("gregory bradley")).toBe(true);
  });

  it("does NOT record the unquoted sentence", () => {
    // The dangerous direction: marking pivots searched on loose text would hide
    // real leads. Absence of evidence is not evidence of search.
    const set = new Set<string>();
    collectTargets({ input: { query: "sacramento rapper armed robbery arrest" } }, set);
    expect(set.size).toBe(0);
  });

  it("still records an explicit selector", () => {
    const set = new Set<string>();
    collectTargets({ runtime: { selector: "hawkcapo" } }, set);
    expect(set.has("hawkcapo")).toBe(true);
  });
});

// --- end to end: the two fixes together, through the real engine ------------

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();
function art(over: Partial<Artifact>): Artifact {
  return {
    id: `p-${over.value}`, kind: "username", value: "hawkcapo", confidence: 80,
    source: "socialfetch", created_at: NOW, metadata: { sources: ["socialfetch"] },
    ...over,
  } as Artifact;
}

describe("a persisted label resolves to the entity a tool actually ran", () => {
  /**
   * Taken verbatim from a live 98-artifact case. The pipeline records these as
   * `kind: "name"` artifacts whose value is a DESCRIPTIVE LABEL, while the tool
   * log holds only the bare selector "hawkcapo". Measured on that case: 9 of 9
   * pivots read "new" before this, 2 of 9 after — the five "hawkcapo - <platform>"
   * cards had all been covered by a single username sweep and were being
   * re-offered on every render.
   */
  const LABELS = [
    "hawkcapo - GitHub", "hawkcapo - SoundCloud", "hawkcapo - Snapchat",
    "hawkcapo - Threads", "hawkcapo - YouTube channel",
  ];

  it("a sweep of the handle covers every platform label built from it", () => {
    for (const label of LABELS) expect(entityKey(label)).toBe("hawkcapo");
  });

  it("leaves a hyphenated identifier alone", () => {
    expect(entityKey("hawk-capo")).toBe("hawk capo");
    expect(entityKey("Jean-Luc Bernard")).toBe("jean luc bernard");
  });

  it("does NOT collapse two labels into one row", () => {
    // entityKey answers "already searched?", never "same pivot?". Using it as a
    // dedupe key would delete four of these five leads from the board.
    const keys = new Set(LABELS.map((l) => canonicalKey({ type: "name", value: l })));
    expect(keys.size).toBe(LABELS.length);
  });

  it("END TO END: a descriptive artifact label is searched once the entity was queried", () => {
    // The live failure, reproduced through the real engine rather than through
    // entityKey alone: a persisted `name` artifact "hawkcapo - YouTube channel"
    // against a tool log holding only "hawkcapo".
    const pivots = computePivots({
      artifacts: [art({ id: "n1", kind: "name", value: "hawkcapo - YouTube channel", confidence: 60 })],
      seedValue: "some-other-seed",
      reportPivots: [],
      skipSet: new Set(),
      queriedSet: new Set(["hawkcapo"]),
    });
    expect(pivots).toHaveLength(1);
    expect(pivots[0]?.status).toBe("searched");
  });

  it("ACCEPTED BROADENING: one entity query covers every objective on that entity", () => {
    // Documented, not accidental. "Gregory Bradley - Sacramento court search"
    // reduces to the bare name, so a generic query marks the court objective
    // searched too. Tolerable ONLY because `searched` sinks a lead out of chat
    // suggestions and leaves it runnable in the Pivots tab. If this ever starts
    // deleting or hiding leads, this test is the one that should be revisited.
    expect(entityKey("Gregory Bradley - Sacramento court search")).toBe("gregory bradley");
  });

  it("a distinct name variant stays actionable", () => {
    // "Gregory Bradley III" is not "Gregory Bradley". Querying one must not
    // silence the other — that would hide a real lead, the dangerous direction.
    expect(entityKey("Gregory Bradley III")).not.toBe(entityKey("Gregory Bradley"));
  });
});

describe("a searched lead stops being offered as a next step", () => {
  const artifacts = [art({ id: "a1", kind: "username", value: "hawkcapo" })];
  const reportPivots = extractRecommendedPivots(REPORT);

  function statuses(queried: string[]) {
    return computePivots({
      artifacts,
      seedValue: "hawkcapo",
      reportPivots,
      skipSet: new Set(),
      queriedSet: new Set(queried),
    }).map((p) => ({ value: p.value, status: p.status }));
  }

  it("an unrun lead is actionable", () => {
    const gregory = statuses([]).find((p) => p.value.toLowerCase().includes("gregory"));
    expect(gregory?.status).toBe("new");
  });

  it("once the tool log shows it queried, it is no longer actionable", () => {
    // This is the transition that never fired. Chat renders only `status: "new"`,
    // so this is exactly the card disappearing from Next Steps.
    const gregory = statuses(["gregory bradley"]).find((p) => p.value.toLowerCase().includes("gregory"));
    expect(gregory?.status).toBe("searched");
  });

  it("but it is NOT deleted — the Pivots tab still has it", () => {
    // Sinking, not hiding. The history has to stay somewhere an analyst can see
    // what was already tried, or the tab becomes a lie by omission.
    const all = statuses(["gregory bradley"]);
    expect(all.some((p) => p.value.toLowerCase().includes("gregory"))).toBe(true);
  });
});
