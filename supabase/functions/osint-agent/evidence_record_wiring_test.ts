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
  assertStringIncludes(INDEX, "artifactFetchHitCeiling", "a filled fetch must be detectable");
  assertStringIncludes(INDEX, "retrievalCeilingHit: artifactFetchHitCeiling", "and must reach the record");
  assertStringIncludes(INDEX, "metadata", "the recorded confidence cap must be selected");
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
