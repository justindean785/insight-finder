// findings_table_wiring_test.ts — engine-authored closing Findings table.
//
// WHY A SOURCE-LEVEL TEST, same reasoning as evidence_record_wiring_test.ts: the renderer
// has thorough unit tests (findings_table_test.ts) and every one of them would keep
// passing if index.ts stopped calling it, or called it from the wrong place. This pins the
// properties that live in the CALL SITE, plus the two that ship with the change: the kill
// switch (ON by default) and the one-line prompt contract.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findingsTableExpansionEnabled } from "../../functions/osint-agent/env.ts";
import { staticSystemPrompt } from "../../functions/osint-agent/lib/base-prompt.ts";
import { CLOSING_TABLE_RULE } from "../../functions/osint-agent/lib/finding-prompt.ts";
import { hasReportShape } from "../../functions/osint-agent/orchestrator-finalize.ts";

const read = (rel: string) => Deno.readTextFile(new URL(`../../functions/osint-agent/${rel}`, import.meta.url));
const INDEX = await read("index.ts");
const ENV = await read("env.ts");
const HEALTH = await read("health-handler.ts");
const RECOVERY = await read("recovery.ts");

/** Source guards that look for CODE must not match the comments explaining it. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const CODE = stripComments(INDEX);

Deno.test("index.ts imports the expander and calls it exactly once", () => {
  assertStringIncludes(INDEX, 'from "./lib/findings-table.ts"');
  assertEquals(CODE.split("expandFindingsTableInParts(").length - 1, 1, "one call site");
});

Deno.test("the call sits inside persistFinalMessages, after the artifact/verdict inputs exist and BEFORE the messages insert", () => {
  const start = CODE.indexOf("const persistFinalMessages = async");
  const call = CODE.indexOf("expandFindingsTableInParts(");
  const compose = CODE.indexOf("composePersistedParts(");
  const insert = CODE.indexOf('.from("messages").insert({', compose);
  const reviewed = CODE.indexOf("const reviewedArts = ");
  assert(start > 0 && call > start, "inside persistFinalMessages");
  assert(call > reviewed, "after reviewedArts exists (rejected rows already dropped)");
  assert(compose > call, "before the reserving composer");
  assert(insert > compose, "before the DB insert");
});

Deno.test("it feeds the table the SAME verdict-filtered rows and fail-closed flags as the Evidence Record", () => {
  const region = CODE.slice(CODE.indexOf("expandFindingsTableInParts("), CODE.indexOf("composePersistedParts("));
  assertStringIncludes(region, "rows: reviewedArts");
  assertStringIncludes(region, "retrieval: artifactRetrieval");
  assertStringIncludes(region, 'reviews: reviewsUsable ? "applied" : "unavailable"');
  assertStringIncludes(region, "rejectedFindingCount");
  assert(!region.includes("rows: salvageArts"), "raw rows would re-promote analyst-rejected findings");
});

Deno.test("invariant 3: from the expansion to the insert assistant.parts is never assigned, and the composer receives the COPY", () => {
  // The salvage step legitimately appends its own part to assistant.parts EARLIER (before the
  // persistence step); what matters is that nothing from the expansion onward touches it.
  const persistRegion = CODE.slice(CODE.indexOf("let partsToPersist"), CODE.indexOf('.from("messages").insert({', CODE.indexOf("composePersistedParts(")));
  assert(persistRegion.length > 200, "region located");
  assert(!/\bassistant\.parts\s*=[^=]/.test(persistRegion), "assistant.parts must stay the model's own message");
  const compose = CODE.slice(CODE.indexOf("composePersistedParts("), CODE.indexOf("composePersistedParts(") + 120);
  assertStringIncludes(compose, "partsToPersist");
  assert(!/composePersistedParts\(\s*assistant\.parts/.test(CODE), "the composer must not take the original parts");
});

Deno.test("the report-shape gate uses the codebase's own predicate", () => {
  assertStringIncludes(CODE, "hasReportShape(stripReasoning(t))");
});

Deno.test("expansion is gated by the call-time kill switch and wrapped so it can never fail finalize", () => {
  const region = CODE.slice(CODE.indexOf("let partsToPersist"), CODE.indexOf("composePersistedParts("));
  assertStringIncludes(region, "findingsTableExpansionEnabled()");
  assertStringIncludes(region, "try {");
  assertStringIncludes(region, "catch (e)");
  assertStringIncludes(region, "findings_table_expansion_failed");
});

Deno.test("a durable log event is emitted with the thread id", () => {
  assertStringIncludes(CODE, "JSON.stringify({ event: name, thread_id: threadId, ...fields })");
});

Deno.test("only the finalize persistence path expands: recovery / stale-run code never touches the module", () => {
  // index.ts is the only runtime importer of the expander; health-handler imports the self-test only.
  assert(!RECOVERY.includes("findings-table"));
});

Deno.test("kill switch ships ON and is read at CALL TIME", () => {
  const key = "FINDINGS_TABLE_EXPANSION_DISABLED";
  const before = Deno.env.get(key);
  try {
    Deno.env.delete(key);
    assertEquals(findingsTableExpansionEnabled(), true, "default is ON");
    Deno.env.set(key, "true");
    assertEquals(findingsTableExpansionEnabled(), false, "flipping the secret takes effect without a reload");
    Deno.env.set(key, " TRUE ");
    assertEquals(findingsTableExpansionEnabled(), false);
    Deno.env.set(key, "false");
    assertEquals(findingsTableExpansionEnabled(), true);
  } finally {
    if (before === undefined) Deno.env.delete(key); else Deno.env.set(key, before);
  }
  const fn = ENV.slice(ENV.indexOf("export function findingsTableExpansionEnabled"));
  assertStringIncludes(fn.slice(0, 220), 'Deno.env.get("FINDINGS_TABLE_EXPANSION_DISABLED")');
});

Deno.test("/health publishes checks.findings_table from the self-test and the switch", () => {
  assertStringIncludes(HEALTH, "r.checks.findings_table = {");
  assertStringIncludes(HEALTH, "runFindingsTableSelfTest()");
  assertStringIncludes(HEALTH, "findingsTableExpansionEnabled()");
  assertStringIncludes(HEALTH, "FINDINGS_TABLE_EXPANSION_DISABLED");
});

Deno.test("prompt: the closing report asks for the marker under a Findings heading, and nothing else about the closing report changed", () => {
  const p = staticSystemPrompt();
  assertStringIncludes(p, "`## Findings` heading followed by the single line `{{FINDINGS_TABLE}}`");
  assertStringIncludes(p, "do not write the table yourself");
  assert(!p.includes("(1) a Findings table"), "the old requirement is gone");
  // The other two closing-report requirements and the per-cycle rule are byte-for-byte what they were.
  assertStringIncludes(p, "(2) a Network section showing how the dots connect, (3) a Summary with strongest leads and any pivots left unpursued (with the reason — dead-end, no provider key, or genuine evidence saturation, NOT \"budget\"). Cite the source tool for every hard finding.");
  assertStringIncludes(p, "do NOT write a Findings table, Network section, or Summary on an intermediate turn");
  // Adjacent rule, deliberately untouched (finding-prompt.ts wire contract).
  assertStringIncludes(p, CLOSING_TABLE_RULE);
});

Deno.test("prompt contract keeps the stored-message shape safe: heading + marker is report-shaped WITHOUT any table", () => {
  assertEquals(hasReportShape("## Findings\n\n{{FINDINGS_TABLE}}"), true);
  assertEquals(hasReportShape("{{FINDINGS_TABLE}}"), false, "a bare marker is not a report");
});
