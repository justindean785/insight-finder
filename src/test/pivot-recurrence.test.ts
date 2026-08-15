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
 *   1. the parser left report prose in `value` ("lead: kestrelcap - YouTube channel")
 *   2. a web search that populates only `input.query` left no footprint at all
 *
 * These tests reproduce the report vocabulary and artifact shapes of a live
 * case, because that is the input that produced the bug. Identifiers are
 * SANITIZED stand-ins — the shape is what carries the regression, and real
 * subject values do not belong in the repo.
 */

const REPORT = [
  "## Recommended pivots",
  "- Review lead: kestrelcap - YouTube channel — Name discovered via public-source search",
  "- Review lead: Marcus Delaney — Name discovered via recalling prior case",
  "- Review lead: kestrelcap - GitHub — Name discovered via checking developer profiles",
].join("\n");

describe("a report recommendation resolves to a target a tool could have run", () => {
  it("strips the action noun and the descriptor suffix", () => {
    const keys = extractRecommendedPivots(REPORT).map((p) => normalizeTarget(p.value));
    expect(keys).toEqual(["kestrelcap", "marcus delaney", "kestrelcap"]);
  });

  it("does not eat hyphens inside an identifier", () => {
    // Only a SPACED hyphen separates an entity from its descriptor. Losing this
    // distinction would truncate real handles and names.
    const md = [
      "## Recommended pivots",
      "- Review lead: kestrel-cap",
      "- Investigate Jean-Luc Bernard",
    ].join("\n");
    const keys = extractRecommendedPivots(md).map((p) => normalizeTarget(p.value));
    expect(keys).toEqual(["kestrel cap", "jean luc bernard"]);
  });

  it("still prefers a direct identifier over any prose around it", () => {
    const md = ["## Recommended pivots", "- Review lead: contact mdelaney@example.com - primary email"].join("\n");
    expect(extractRecommendedPivots(md)[0]?.value).toBe("mdelaney@example.com");
  });
});

describe("a free-text search leaves a footprint", () => {
  it("records a quoted phrase from a web-search query", () => {
    const set = new Set<string>();
    collectTargets({ input: { query: '"Marcus Delaney" Fairview public records' }, runtime: { selector: "" } }, set);
    expect(set.has("marcus delaney")).toBe(true);
  });

  it("does NOT record the unquoted sentence", () => {
    // The dangerous direction: marking pivots searched on loose text would hide
    // real leads. Absence of evidence is not evidence of search.
    const set = new Set<string>();
    collectTargets({ input: { query: "fairview rapper armed robbery arrest" } }, set);
    expect(set.size).toBe(0);
  });

  it("still records an explicit selector", () => {
    const set = new Set<string>();
    collectTargets({ runtime: { selector: "kestrelcap" } }, set);
    expect(set.has("kestrelcap")).toBe(true);
  });
});

// --- end to end: the two fixes together, through the real engine ------------

const NOW = new Date("2026-08-14T00:00:00Z").toISOString();
function art(over: Partial<Artifact>): Artifact {
  return {
    id: `p-${over.value}`, kind: "username", value: "kestrelcap", confidence: 80,
    source: "socialfetch", created_at: NOW, metadata: { sources: ["socialfetch"] },
    ...over,
  } as Artifact;
}

describe("a persisted label resolves to the entity a tool actually ran", () => {
  /**
   * Taken verbatim from a live 98-artifact case. The pipeline records these as
   * `kind: "name"` artifacts whose value is a DESCRIPTIVE LABEL, while the tool
   * log holds only the bare selector "kestrelcap". Measured on that case: 9 of 9
   * pivots read "new" before this, 2 of 9 after — the five "kestrelcap - <platform>"
   * cards had all been covered by a single username sweep and were being
   * re-offered on every render.
   */
  const LABELS = [
    "kestrelcap - GitHub", "kestrelcap - SoundCloud", "kestrelcap - Snapchat",
    "kestrelcap - Threads", "kestrelcap - YouTube channel",
  ];

  it("a sweep of the handle covers every platform label built from it", () => {
    for (const label of LABELS) expect(entityKey(label)).toBe("kestrelcap");
  });

  it("leaves a hyphenated identifier alone", () => {
    expect(entityKey("kestrel-cap")).toBe("kestrel cap");
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
    // entityKey alone: a persisted `name` artifact "kestrelcap - YouTube channel"
    // against a tool log holding only "kestrelcap".
    const pivots = computePivots({
      artifacts: [art({ id: "n1", kind: "name", value: "kestrelcap - YouTube channel", confidence: 60 })],
      seedValue: "some-other-seed",
      reportPivots: [],
      skipSet: new Set(),
      queriedSet: new Set(["kestrelcap"]),
    });
    expect(pivots).toHaveLength(1);
    expect(pivots[0]?.status).toBe("searched");
  });

  it("ACCEPTED BROADENING: one entity query covers every objective on that entity", () => {
    // Documented, not accidental. "Marcus Delaney - Fairview court search"
    // reduces to the bare name, so a generic query marks the court objective
    // searched too. Tolerable ONLY because `searched` sinks a lead out of chat
    // suggestions and leaves it runnable in the Pivots tab. If this ever starts
    // deleting or hiding leads, this test is the one that should be revisited.
    expect(entityKey("Marcus Delaney - Fairview court search")).toBe("marcus delaney");
  });

  it("a distinct name variant stays actionable", () => {
    // "Marcus Delaney Jr" is not "Marcus Delaney". Querying one must not
    // silence the other — that would hide a real lead, the dangerous direction.
    expect(entityKey("Marcus Delaney Jr")).not.toBe(entityKey("Marcus Delaney"));
  });
});

describe("a searched lead stops being offered as a next step", () => {
  const artifacts = [art({ id: "a1", kind: "username", value: "kestrelcap" })];
  const reportPivots = extractRecommendedPivots(REPORT);

  function statuses(queried: string[]) {
    return computePivots({
      artifacts,
      seedValue: "kestrelcap",
      reportPivots,
      skipSet: new Set(),
      queriedSet: new Set(queried),
    }).map((p) => ({ value: p.value, status: p.status }));
  }

  it("an unrun lead is actionable", () => {
    const named = statuses([]).find((p) => p.value.toLowerCase().includes("delaney"));
    expect(named?.status).toBe("new");
  });

  it("once the tool log shows it queried, it is no longer actionable", () => {
    // This is the transition that never fired. Chat renders only `status: "new"`,
    // so this is exactly the card disappearing from Next Steps.
    const named = statuses(["marcus delaney"]).find((p) => p.value.toLowerCase().includes("delaney"));
    expect(named?.status).toBe("searched");
  });

  it("but it is NOT deleted — the Pivots tab still has it", () => {
    // Sinking, not hiding. The history has to stay somewhere an analyst can see
    // what was already tried, or the tab becomes a lie by omission.
    const all = statuses(["marcus delaney"]);
    expect(all.some((p) => p.value.toLowerCase().includes("delaney"))).toBe(true);
  });
});
