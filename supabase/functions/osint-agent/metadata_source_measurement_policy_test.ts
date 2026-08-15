import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateDuplicateBreachTransport,
  EXECUTION_MATCH_TOLERANCE_MS,
  executionTimesByTool,
  isAutoRecordedStatusRow,
  isExecutionAvailableAt,
  nearestQualifyingExecution,
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

const ARTIFACT_AT = Date.parse("2026-08-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(ARTIFACT_AT + offsetMs).toISOString();
const HOUR_MS = 60 * 60_000;

// --- boundary 1: execution clearly before the artifact -----------------------
Deno.test("execution clearly before the artifact matches", () => {
  const times = executionTimesByTool([
    { tool_name: "leakcheck", created_at: at(-HOUR_MS) },
  ]);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), true);
});

// --- boundary 2: usage-log lands just after the artifact, same call ----------
Deno.test("usage-log timestamp just after the artifact but within same-call tolerance matches", () => {
  // dork_harvest / gemini_deep_dork insert the artifact INSIDE execute, while
  // that call's tool_usage_log row is written afterwards in an unawaited
  // finally. The log therefore lands slightly AFTER the artifact it evidences.
  const times = executionTimesByTool([
    { tool_name: "gemini_deep_dork", created_at: at(5_000) },
  ]);
  assertEquals(
    isExecutionAvailableAt(times, "gemini_deep_dork", ARTIFACT_AT),
    true,
  );
  assert(EXECUTION_MATCH_TOLERANCE_MS > 5_000);
});

// --- boundary 3: past the tolerance ------------------------------------------
Deno.test("execution past the same-call tolerance does not match", () => {
  const times = executionTimesByTool([
    {
      tool_name: "leakcheck",
      created_at: at(EXECUTION_MATCH_TOLERANCE_MS + 1),
    },
  ]);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), false);
});

Deno.test("reused thread: a LATER execution does not back-date provenance", () => {
  // Artifact A is written, then the same thread runs leakcheck an hour later.
  // A must not become execution-matched by that subsequent call.
  const times = executionTimesByTool([
    { tool_name: "leakcheck", created_at: at(HOUR_MS) },
  ]);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), false);
  assertEquals(
    nearestQualifyingExecution(times, "leakcheck", ARTIFACT_AT),
    null,
  );
});

Deno.test("nearest qualifying execution is the LATEST under the bound, not the earliest", () => {
  // A tool is not reduced to one timestamp: the run nearest the artifact is the
  // plausible one. A later, non-qualifying run must not be selected either.
  const times = executionTimesByTool([
    { tool_name: "leakcheck", created_at: at(-72 * HOUR_MS) },
    { tool_name: "leakcheck", created_at: at(-10 * 60_000) },
    { tool_name: "leakcheck", created_at: at(HOUR_MS) },
  ]);
  assertEquals(times.get("leakcheck")?.length, 3);
  assertEquals(
    nearestQualifyingExecution(times, "leakcheck", ARTIFACT_AT),
    ARTIFACT_AT - 10 * 60_000,
  );
});

// --- the opposite direction, and the limit of what timing alone can prove ----
Deno.test("reused thread: an ancient lone execution still qualifies — upper bound only", () => {
  // Documents a KNOWN LIMITATION rather than asserting a guarantee. With no
  // durable run_id / call identity on artifacts or tool_usage_log, there is no
  // defensible lower time bound, so a tool that ran once days earlier on a
  // reused thread still qualifies for a much later artifact naming it.
  const times = executionTimesByTool([
    { tool_name: "leakcheck", created_at: at(-72 * HOUR_MS) },
  ]);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), true);
  assertEquals(
    nearestQualifyingExecution(times, "leakcheck", ARTIFACT_AT),
    ARTIFACT_AT - 72 * HOUR_MS,
  );
});

Deno.test("measurement discloses that thread-wide timing is not exact provenance", async () => {
  const measurement = await Deno.readTextFile(
    new URL("../../../scripts/measure-metadata-source.ts", import.meta.url),
  );
  assert(
    /no durable run_id/i.test(measurement),
    "measurement must disclose the absent durable run identity",
  );
  assert(
    /upper bound/i.test(measurement),
    "measurement must disclose that execution matching is upper-bounded only",
  );
});

Deno.test("execution matching lowercases tool names and fails closed", () => {
  const times = executionTimesByTool([
    { tool_name: "LeakCheck", created_at: at(-1_000) },
  ]);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), true);
  assertEquals(
    isExecutionAvailableAt(times, "absent_tool", ARTIFACT_AT),
    false,
  );
  assertEquals(
    isExecutionAvailableAt(undefined, "leakcheck", ARTIFACT_AT),
    false,
  );
});

Deno.test("unparseable execution timestamps are ignored, not treated as time zero", () => {
  const times = executionTimesByTool([
    { tool_name: "leakcheck", created_at: "not-a-timestamp" },
  ]);
  assertEquals(times.has("leakcheck"), false);
  assertEquals(isExecutionAvailableAt(times, "leakcheck", ARTIFACT_AT), false);
});

Deno.test("auto-recorded status-row classifier is exact and fail-closed", () => {
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: true }), true);
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: false }), false);
  assertEquals(isAutoRecordedStatusRow({ auto_recorded: "true" }), false);
  assertEquals(isAutoRecordedStatusRow(null), false);
});
