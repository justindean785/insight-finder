// evidence_record_wiring_test.ts — #479.
//
// WHY A SOURCE-LEVEL TEST, same reasoning as reviews_wiring_test.ts: the renderer
// and the composer have thorough unit tests, and every one of them would keep
// passing if index.ts stopped calling them. "Correct module, never invoked" is the
// exact shape of the 07-20 regression this project has already paid for once.
//
// It also pins the two properties that live in the CALL SITE rather than in either
// module, and that a unit test therefore cannot reach:
//   - the persistence pipeline goes through composePersistedParts, so the byte
//     reservation cannot be separated from the capping it exists to survive; and
//   - `assistant.parts` is never assigned to at the persistence step, which is what
//     keeps the Evidence Record out of `finalMessages` and therefore out of the
//     completion contract.
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/** Source-level guards that look for CODE must not match the comments explaining
 *  that code. Crude but sufficient for these regions: no string literal here
 *  contains "//" or "/*". */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

Deno.test("the Evidence Record is imported and built during finalize", () => {
  assertStringIncludes(INDEX, 'from "./lib/evidence-record.ts"');
  assertStringIncludes(INDEX, "buildEvidenceRecord({", "the record must actually be rendered");
});

Deno.test("the persisted parts go through the reserving composer", () => {
  assertStringIncludes(INDEX, 'from "./lib/evidence-record-persist.ts"');
  assertStringIncludes(INDEX, "composePersistedParts(", "the composer must be the persistence path");
});

Deno.test("index.ts no longer caps the assistant message itself", () => {
  // If either capping helper is called here again, it is almost certainly a
  // reintroduced tail-append — which capPartsSize's prefix-preserving last stage
  // (safety.ts:450) silently deletes the record from.
  for (const helper of ["capPartsSize(", "capToolPartPayloads(", "stripNulCharacters("]) {
    const calls = INDEX.split("\n").filter((l) =>
      l.includes(helper) && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")
    );
    assert(
      calls.length === 0,
      `${helper} must live in composePersistedParts, not index.ts — found: ${JSON.stringify(calls)}`,
    );
  }
});

Deno.test("only the salvage report may be written into the in-memory message", () => {
  // THE completion-contract guard. resolveTerminalState reads the same in-memory
  // `finalMessages`; writing the Evidence Record into `assistant.parts` would let
  // a stub run ("I'll start") inherit the structure hasReportShape looks for.
  //
  // The salvage backstop's own mutation is deliberately EXEMPT and must stay: a
  // salvaged report IS a report, so it has to reach the contract. The two writes
  // look identical and mean opposite things, which is why this pins the exact set
  // rather than forbidding the pattern.
  const mutations = INDEX.split("\n")
    .map((l) => l.trim())
    .filter((l) => /\bassistant\.parts\s*=[^=]/.test(l));
  assert(
    mutations.every((l) => l.includes("salvagePart")),
    `only the salvage backstop may write to assistant.parts — found: ${JSON.stringify(mutations)}`,
  );
  assert(mutations.length === 1, `expected exactly the salvage write, got ${mutations.length}`);
});

Deno.test("the Evidence Record never reaches the in-memory message", () => {
  const leaks = INDEX.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("evidenceRecord") && /assistant|finalMessages/.test(l));
  assert(leaks.length === 0, `the record must only reach the persisted array — found: ${JSON.stringify(leaks)}`);
});

Deno.test("the artifact fetch covers findings and discloses its own ceiling", () => {
  // Findings are the LOWEST-confidence rows and the fetch is ordered confidence
  // desc, so the limit is what decides whether they survive at all.
  assertStringIncludes(INDEX, "ARTIFACT_FETCH_LIMIT = 500");
  assertStringIncludes(INDEX, '"ceiling_hit"', "a filled fetch must be detectable");
  assertStringIncludes(INDEX, "retrieval: artifactRetrieval", "and the state must reach the record");
  assertStringIncludes(INDEX, ".select(\"id,kind,value,confidence,source,metadata\")",
    "the recorded confidence cap must be selected");
});

Deno.test("a failed artifact read is distinguished from an empty one", () => {
  // THE P0. `{ data: null, error }` is what a failed PostgREST select returns —
  // it does not throw — so a call site that reads only `data` cannot tell a query
  // that failed from a thread that recorded nothing, and the record would publish
  // "nothing was adjudicated" as a fact about the RUN.
  assertStringIncludes(INDEX, "error: artifactFetchError", "the query's error must be captured");
  assertStringIncludes(
    INDEX,
    'let artifactRetrieval: ArtifactRetrieval = "unavailable"',
    "the state must START unavailable, so any failure path — including a throw " +
      "before the fetch — degrades to unavailable rather than to a false zero",
  );
  assertStringIncludes(INDEX, "artifact_fetch_unavailable", "and the failure must be observable");

  // Only a demonstrated array may raise the state.
  assertStringIncludes(INDEX, "!Array.isArray(fetchedArts)");
});

Deno.test("classifying the read adds no round trip and cannot fail finalize", () => {
  // The ceiling/unavailable distinction is drawn from the response ALREADY IN
  // HAND — no retry, no second select, no extra await. This path owns the
  // project's worst incidents (INCIDENT_2026-07-26), so added latency here is a
  // regression by itself.
  //
  // Scoped to the two regions #479 owns, deliberately. Finalize makes other
  // artifact reads that long predate this work (the investigation-cache persist
  // and the zero-artifact telemetry count); asserting a whole-function total
  // would fail on unrelated changes and say nothing about this one.
  const fetchRegion = INDEX.slice(
    INDEX.indexOf("let salvageArts:"),
    INDEX.indexOf("needsReportSalvage("),
  );
  assert(fetchRegion.length > 0, "anchors must still exist");
  const reads = fetchRegion.split('.from("artifacts")').length - 1;
  assert(reads === 1, `the record and salvage must share ONE artifact read, found ${reads}`);
  // Comments stripped first: this must read CODE. Left in, the region's own
  // "no retry, no second round trip, no throw" comment satisfies the regex
  // looking for a throw — a source-scanning test matching its own prose.
  assert(!/\bthrow\b/.test(stripComments(fetchRegion)), "an unreadable artifact population must never fail finalize");

  // And building/composing the record itself touches nothing at all.
  const recordRegion = INDEX.slice(
    INDEX.indexOf('let evidenceRecord = ""'),
    INDEX.indexOf("safePartsForCache = safeParts"),
  );
  assert(recordRegion.length > 0, "anchors must still exist");
  assert(!recordRegion.includes(".from("), "the Evidence Record must issue no query of its own");
  assert(!/\bawait\b/.test(recordRegion), "and must add no await inside the finalize window");
});

Deno.test("analyst rejections reach the record, and review deltas do not", () => {
  // Two properties, and the second is the fragile one. `dropRejectedArtifacts`
  // and `applyReviewsToArtifacts` differ by one word at the call site and by a
  // confidence delta in behaviour: the latter would let a `confirmed` verdict
  // raise the number this block publishes, breaking the min(confidence, cap)
  // contract that is the entire point of it.
  const region = INDEX.slice(INDEX.indexOf("const reviewsUsable"), INDEX.indexOf("safePartsForCache = safeParts"));
  assert(region.length > 0, "anchors must still exist");
  assertStringIncludes(region, "dropRejectedArtifacts(salvageArts, turnReviews)");
  assert(
    !stripComments(region).includes("applyReviewsToArtifacts"),
    "the record must not inherit review confidence deltas",
  );
  assertStringIncludes(region, "rejectedFindingCount");
  assertStringIncludes(INDEX, 'reviews: reviewsUsable ? "applied" : "unavailable"');
});

Deno.test("rejection authority reuses the turn's review load — no extra read", () => {
  // `turnReviews` is loaded once per turn near the top of the handler and is in
  // scope here by closure. Loading again inside finalize would add a round trip
  // to the window that owns this project's worst incidents.
  const region = stripComments(
    INDEX.slice(INDEX.indexOf("const reviewsUsable"), INDEX.indexOf("safePartsForCache = safeParts")),
  );
  assert(!region.includes("loadReviewsForThread"), "the record must reuse turnReviews, not re-read");
  assert(!/\bawait\b/.test(region), "and add no await inside the finalize window");
});

Deno.test("unreadable verdicts fail closed at the call site, not open", () => {
  // `turnReviews.ok === false` must select "unavailable". A call site that passed
  // the raw rows through on a review outage would republish whatever the analyst
  // had rejected.
  assertStringIncludes(INDEX, "const reviewsUsable = turnReviews.ok;");
  assertStringIncludes(INDEX, "reviewsUsable ? dropRejectedArtifacts(salvageArts, turnReviews) : []");
});

Deno.test("salvage synthesis stays bounded to its original 200 rows", () => {
  // The fetch widened to 500 for the record; salvage runs a live generation inside
  // the finalize window, so its input must not grow with it.
  assertStringIncludes(INDEX, "salvageArts.slice(0, 200)");
});

Deno.test("rendering the record can never fail finalize", () => {
  const idx = INDEX.indexOf("buildEvidenceRecord({");
  assert(idx > 0);
  const preceding = INDEX.slice(Math.max(0, idx - 400), idx);
  assertStringIncludes(preceding, "try {", "the render must be guarded");
});
