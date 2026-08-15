import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateDuplicateBreachTransport,
  isAutoRecordedStatusRow,
  surfaceTokensForExecutionMatch,
  unmatchedOrigin,
} from "../../../scripts/metadata-source-measurement-policy.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "./confidence.ts";
import { applyRecordingSourcePolicy } from "./recording-source-policy.ts";

Deno.test("measurement keeps slash-bearing system writers atomic", () => {
  assertEquals(surfaceTokensForExecutionMatch("lib/cluster.ts"), [
    "lib/cluster.ts",
  ]);
  assertEquals(unmatchedOrigin("lib/cluster.ts"), "known system writer");
});

Deno.test("measurement uses production splitting for actual compound tools", () => {
  assertEquals(
    surfaceTokensForExecutionMatch(
      "minimax_web_search + jina_reader_scrape, socialfetch_web_read",
    ),
    ["minimax_web_search", "jina_reader_scrape", "socialfetch_web_read"],
  );
});

Deno.test("measurement does not hide mixed labels behind a lib prefix", () => {
  const tokens = surfaceTokensForExecutionMatch(
    "lib/cluster.ts + fake_tool",
  );
  assertEquals(tokens, ["lib", "cluster.ts", "fake_tool"]);
  assert(tokens.includes("fake_tool"));
  assertEquals(unmatchedOrigin("lib"), "unknown");
});

Deno.test("measurement fails closed on duplicate breach invariant violations", async () => {
  const measurement = await Deno.readTextFile(
    new URL("../../../scripts/measure-metadata-source.ts", import.meta.url),
  );
  assert(
    measurement.includes("duplicate breach transport invariant"),
    "measurement must print an explicit duplicate-breach PASS/FAIL gate",
  );
  assert(
    /duplicateBreachInvariantViolations\s*>\s*0[\s\S]*Deno\.exitCode\s*=\s*1/
      .test(
        measurement,
      ),
    "duplicate-breach invariant failures must set a nonzero exit code",
  );
});

Deno.test("measurement uses a cutoff-bound stable keyset scan", async () => {
  const measurement = await Deno.readTextFile(
    new URL("../../../scripts/measure-metadata-source.ts", import.meta.url),
  );
  assert(measurement.includes("const scanStart = new Date().toISOString()"));
  assert(measurement.includes('order: "created_at.asc,id.asc"'));
  assert(measurement.includes("created_at: `lte.${scanStart}`"));
  assert(measurement.includes("created_at.gt.${cursor.createdAt}"));
  assert(measurement.includes("id.gt.${cursor.id}"));
  assert(!measurement.includes("Range: `${from}-"));
  assert(!measurement.includes('"Range-Unit"'));
});

Deno.test("measurement reproduces the historical duplicate nudge and fixed proposal", () => {
  const metadata = { sources: ["breach_check"] };
  const legacy = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["breach_check"],
    kind: "breach_exposure",
    metadata,
  });
  const proposed = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: null,
    kind: "breach_exposure",
    metadata,
  }).withMetadata;
  const result = evaluateDuplicateBreachTransport({
    source: null,
    metadata,
    legacy,
    proposed,
  });

  assertEquals(legacy.cap, 65);
  assertEquals(proposed.cap, 60);
  assertEquals(result.singleLogicalBreachShape, true);
  assertEquals(result.historicalNudgeAffected, true);
  assertEquals(result.proposedFixedAtSingleSourceCap, true);
  assertEquals(result.invariantViolation, false);
});

Deno.test("measurement canonicalizes evidenced aliases in duplicate shapes", () => {
  const metadata = { sources: ["leakcheck_lookup"] };
  const legacy = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["leakcheck", "leakcheck_lookup"],
    metadata,
  });
  const proposed = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "leakcheck",
    metadata,
  }).withMetadata;
  const result = evaluateDuplicateBreachTransport({
    source: "leakcheck",
    metadata,
    legacy,
    proposed,
  });
  assertEquals(result.singleLogicalBreachShape, true);
  assertEquals(result.historicalNudgeAffected, true);
});

Deno.test("auto-recorded status-row classifier is exact and fail-closed", () => {
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: true }), true);
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: false }), false);
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: "true" }), false);
  assertEquals(isAutoRecordedStatusRow(null), false);
});
