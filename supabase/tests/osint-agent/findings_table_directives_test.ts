/**
 * findings_table_directives_test.ts — the two closing-report instructions ask for the
 * ENGINE's Findings table.
 *
 * WHY: #974 shipped the `{{FINDINGS_TABLE}}` expansion and the system prompt asks for the
 * marker (system-prompt.ts), but the report is written under the forced-finalize directive
 * (`buildFinalizeDirective`) or, when the run ended without one, the salvage prompt
 * (`buildSalvageSynthesisPrompt`). Both told the model to type "confirmed findings grouped by
 * type with confidence and source" — they overrode the system prompt, the model typed its own
 * table, and adoption measured 0 of 1. Prompt text only; these tests pin the text.
 *
 * The LEGACY_* literals below are the pre-change wording copied VERBATIM from `main` at
 * `d0b482f`. They are deliberately re-typed here (not imported) so the byte-for-byte rollback
 * assertion is independent of the module that now owns the text.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFinalizeDirective,
  buildSalvageSynthesisPrompt,
  findingsTableDirectivesSelfTest,
  hasReportShape,
} from "../../functions/osint-agent/orchestrator-finalize.ts";
import {
  FINDINGS_TABLE_EXPANSION_DISABLED_ENV,
  findingsTableDirectiveEnabled,
} from "../../functions/osint-agent/lib/findings-table-directive.ts";
import { findingsTableExpansionEnabled } from "../../functions/osint-agent/env.ts";
import {
  expandFindingsTableInParts,
  FINDINGS_TABLE_MARKER,
} from "../../functions/osint-agent/lib/findings-table.ts";

const LEGACY_FINALIZE = [
  "",
  "",
  "=== FINALIZE — WRITE THE REPORT NOW ===",
  "The persistence and memory decisions are complete.",
  "Do not call record_artifacts, memory_save, or any other tool in this phase.",
  "Ignore earlier instructions that say a tool must be called before the report; that",
  "requirement was satisfied or explicitly skipped in the preceding finalize phases.",
  "Write the complete final Findings report as message text: a short summary, confirmed",
  "findings grouped by type with confidence and source, and all material gaps.",
  "Produce the report even if coverage is partial; state uncertainty honestly. Do not fabricate.",
].join("\n");

const LEGACY_SALVAGE_INSTRUCTIONS = [
  "Write a complete, honest Findings report using ONLY these artifacts:",
  "- One short paragraph summarizing who or what was identified.",
  "- Confirmed findings grouped by type, each with its confidence and source.",
  "- Explicit gaps and unverified leads.",
  "Do not invent anything not present below. Do not call any tools.",
].join("\n");

const SALVAGE_SEED = "jane@example.com";
const SALVAGE_ARTIFACTS = [
  { kind: "username", value: "jdoe", confidence: 80, source: "github" },
  { kind: "location", value: "Austin, TX", confidence: 60, source: "exif" },
];

/** Run `fn` with FINDINGS_TABLE_EXPANSION_DISABLED set to `value` (undefined = unset), then restore. */
function withSwitch<T>(value: string | undefined, fn: () => T): T {
  const key = FINDINGS_TABLE_EXPANSION_DISABLED_ENV;
  const before = Deno.env.get(key);
  try {
    if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    return fn();
  } finally {
    if (before === undefined) Deno.env.delete(key); else Deno.env.set(key, before);
  }
}

/** The lines of `text` that are exactly `needle` once trimmed. */
const linesEqual = (text: string, needle: string): number => text.split("\n").filter((l) => l.trim() === needle).length;

/** The salvage prompt's instruction block: everything before the "Artifacts:" listing. The
 *  listing legitimately prints "(confidence N)" per row, so assertions about what the model is
 *  ASKED to write must not look at it. */
const salvageInstructions = (p: string): string => p.slice(0, p.indexOf("\nArtifacts:"));

// ---- switch ON (default): both directives ask for the marker ---------------------------

Deno.test("buildFinalizeDirective: asks for a `## Findings` heading then the marker on its own line", () => {
  const d = withSwitch(undefined, buildFinalizeDirective);
  assertEquals(linesEqual(d, "## Findings"), 1, "exactly one Findings heading line");
  assertEquals(linesEqual(d, FINDINGS_TABLE_MARKER), 1, "exactly one bare marker line");
  const lines = d.split("\n");
  const h = lines.findIndex((l) => l.trim() === "## Findings");
  assertEquals(lines[h + 1].trim(), FINDINGS_TABLE_MARKER, "the marker line directly follows the heading");
});

Deno.test("buildSalvageSynthesisPrompt: asks for a `## Findings` heading then the marker on its own line", () => {
  const p = withSwitch(undefined, () => buildSalvageSynthesisPrompt(SALVAGE_SEED, SALVAGE_ARTIFACTS));
  assertEquals(linesEqual(p, "## Findings"), 1);
  assertEquals(linesEqual(p, FINDINGS_TABLE_MARKER), 1);
  const lines = p.split("\n");
  const h = lines.findIndex((l) => l.trim() === "## Findings");
  assertEquals(lines[h + 1].trim(), FINDINGS_TABLE_MARKER);
});

Deno.test("neither directive asks the model to type a table, tier labels or confidence", () => {
  const fin = withSwitch(undefined, buildFinalizeDirective);
  const sal = salvageInstructions(withSwitch(undefined, () => buildSalvageSynthesisPrompt(SALVAGE_SEED, SALVAGE_ARTIFACTS)));
  for (const [name, text] of [["finalize", fin], ["salvage", sal]] as const) {
    // The old asks, by their own words.
    assertFalse(/grouped by type/i.test(text), `${name}: still asks for findings grouped by type`);
    assertFalse(/with (its )?confidence and (its )?source/i.test(text), `${name}: still asks for confidence and source`);
    assertFalse(/each with its confidence/i.test(text), `${name}: still asks for per-row confidence`);
    // And the prohibition is stated.
    assert(/do not type a findings table, tier labels or confidence numbers/i.test(text), `${name}: must forbid hand-typed table/labels/confidence`);
  }
});

Deno.test("the heading both directives ask for is report shape (the expansion's precondition)", () => {
  // expandFindingsTableInParts only expands a message that ALREADY has report shape without
  // the marker line; the heading in the directive is what guarantees that when the model
  // follows it exactly. Pin the property end to end on a message written to the letter.
  assert(hasReportShape("## Findings"), "the heading alone satisfies hasReportShape");
  const written = ["Short summary of the run.", "", "## Findings", FINDINGS_TABLE_MARKER, "", "Gaps: none recorded."].join("\n");
  const out = expandFindingsTableInParts(
    [{ type: "text", text: written }],
    { rows: [], totalArtifactCount: 0, retrieval: "complete", reviews: "applied", rejectedFindingCount: 0 },
    { shapeOk: hasReportShape },
  );
  assertEquals(out.event.name, "findings_table_expanded");
  assertEquals(out.event.marker_found, true);
  assertEquals(out.event.replaced, 1);
  assertFalse(JSON.stringify(out.parts).includes(FINDINGS_TABLE_MARKER), "the marker line was replaced");
});

Deno.test("the salvage instructions keep the lines the older tests and the no-fabrication contract rely on", () => {
  const p = withSwitch(undefined, () => buildSalvageSynthesisPrompt(SALVAGE_SEED, SALVAGE_ARTIFACTS));
  assertStringIncludes(p, "Do not invent anything not present below. Do not call any tools.");
  assertStringIncludes(p, "Write a complete, honest Findings report using ONLY these artifacts:");
  assertStringIncludes(p, "- Explicit gaps and unverified leads.");
  // The artifact listing is untouched and still prints per-row confidence as INPUT.
  assertStringIncludes(p, "- username: jdoe (confidence 80) [source: github]");
  assertStringIncludes(p, "Artifacts:");
});

// ---- switch OFF: byte-for-byte the previous wording ------------------------------------

Deno.test("FINDINGS_TABLE_EXPANSION_DISABLED=true restores the finalize directive byte-for-byte", () => {
  assertEquals(withSwitch("true", buildFinalizeDirective), LEGACY_FINALIZE);
});

Deno.test("FINDINGS_TABLE_EXPANSION_DISABLED=true restores the salvage instructions byte-for-byte", () => {
  const p = withSwitch("true", () => buildSalvageSynthesisPrompt(SALVAGE_SEED, SALVAGE_ARTIFACTS));
  const expected = [
    `Investigation seed: ${SALVAGE_SEED}`,
    "",
    "This run ended before it wrote its report. Below are the 2 artifacts gathered.",
    LEGACY_SALVAGE_INSTRUCTIONS,
    "",
    "",
    "Artifacts:",
    "- username: jdoe (confidence 80) [source: github]",
    "- location: Austin, TX (confidence 60) [source: exif]",
  ].join("\n");
  assertEquals(p, expected);
});

Deno.test("with the switch off neither directive carries the marker", () => {
  assertEquals(linesEqual(withSwitch("true", buildFinalizeDirective), FINDINGS_TABLE_MARKER), 0);
  assertEquals(
    linesEqual(withSwitch("true", () => buildSalvageSynthesisPrompt(SALVAGE_SEED, SALVAGE_ARTIFACTS)), FINDINGS_TABLE_MARKER),
    0,
  );
});

Deno.test("switch parsing matches the expansion's own: only the literal 'true' disables", () => {
  for (const [v, enabled] of [
    [undefined, true], ["", true], ["false", true], ["0", true], ["1", true], ["yes", true],
    ["true", false], [" TRUE ", false], ["True", false],
  ] as const) {
    withSwitch(v, () => {
      assertEquals(findingsTableDirectiveEnabled(), enabled, `directive reader, value ${JSON.stringify(v)}`);
      // One kill switch, two readers: they must never disagree, or the table could be asked for
      // while the expansion is off (a raw marker in the report) or the reverse (a typed table).
      assertEquals(findingsTableDirectiveEnabled(), findingsTableExpansionEnabled(), `readers agree on ${JSON.stringify(v)}`);
    });
  }
});

// ---- proof key -------------------------------------------------------------------------

Deno.test("findingsTableDirectivesSelfTest: reports finalize+salvage when on, legacy when off", () => {
  const on = withSwitch(undefined, findingsTableDirectivesSelfTest);
  assertEquals(on.ok, true);
  assertEquals(on.directives, "finalize+salvage");
  const off = withSwitch("true", findingsTableDirectivesSelfTest);
  assertEquals(off.ok, true);
  assertEquals(off.directives, "legacy");
});

// ---- wiring (source-level, like findings_table_wiring_test.ts) -------------------------

const read = (rel: string): string => Deno.readTextFileSync(new URL(`../../functions/osint-agent/${rel}`, import.meta.url));

Deno.test("/health publishes the directives field and fails the parent check when they drift", () => {
  const health = read("health-handler.ts");
  assertStringIncludes(health, "findingsTableDirectivesSelfTest()");
  assertStringIncludes(health, "ok: st.ok && dir.ok,");
  assertStringIncludes(health, "directives: dir.directives,");
});

Deno.test("index.ts appends the salvage part BEFORE the expansion runs (so a salvage marker is expanded)", () => {
  const src = read("index.ts");
  const salvageAppend = src.indexOf("assistant.parts = [...(assistant.parts ?? []), salvagePart]");
  const expansion = src.indexOf("expandFindingsTableInParts(");
  assert(salvageAppend > 0 && expansion > 0, "both call sites exist");
  assert(salvageAppend < expansion, "salvage part is appended before the marker expansion");
});

Deno.test("both builders gate the new wording on the one reader, so the switch rolls both back", () => {
  const src = read("orchestrator-finalize.ts");
  assertEquals((src.match(/findingsTableDirectiveEnabled\(\) \?/g) ?? []).length, 2, "finalize + salvage each branch on the switch");
});
