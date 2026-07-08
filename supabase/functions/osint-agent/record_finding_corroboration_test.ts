import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource, countIndependentClasses } from "./source-classification.ts";
import { computeAxes } from "./confidence.ts";

// record_finding (tool-registry.ts) derives corroborationCount from
// countIndependentClasses(supporting_sources.map(classifySource)) instead of
// trusting the model-supplied corroboration_count field (audit finding F06).
// These tests exercise that exact derivation expression against the audit's
// proof-of-concept and a few adjacent scenarios, mirroring the frontend
// coverage of the same concept in src/test/intel-logic.test.ts.
function deriveCorroborationCount(supportingSources: string[]): number {
  return countIndependentClasses(supportingSources.map(classifySource));
}

Deno.test("F06: a single ai_summary-class source derives 0 independent corroboration (audit PoC)", () => {
  // Prior bug: record_finding trusted a model-supplied corroboration_count as
  // high as 5 here, inflating the artifact axis to 100 for a single discovery
  // tool call. Server-derived count must be 0 — ai_summary never corroborates alone.
  assertEquals(deriveCorroborationCount(["exa_search"]), 0);
});

Deno.test("F06: two ai_summary-class sources still derive 0 — same non-corroborating class, not 2", () => {
  assertEquals(deriveCorroborationCount(["exa_search", "gemini_deep_dork"]), 0);
});

Deno.test("F06: two same-class public-record sources derive 1, not 2", () => {
  assertEquals(deriveCorroborationCount(["census_geocode", "nominatim_geocode"]), 1);
});

Deno.test("F06: two same-class breach sources derive 1, not 2", () => {
  assertEquals(deriveCorroborationCount(["breach_check", "leakcheck_lookup"]), 1);
});

Deno.test("F06: two genuinely independent classes (breach + court_record) derive 2", () => {
  assertEquals(deriveCorroborationCount(["breach_check", "pacer_docket"]), 2);
});

Deno.test("F06: computeAxes' corroBoost tracks the derived (not claimed) count end-to-end", () => {
  // Reproduces the exact exploit shape: what tool-registry.ts's record_finding
  // execute() now computes when a model calls it with a single ai_summary
  // source and (irrelevantly) claims corroboration_count: 5 in the input —
  // that raw claim is never read; only supporting_sources feeds the boost.
  const supportingSources = ["exa_search"];
  const axes = computeAxes({
    sources: supportingSources,
    corroborationCount: deriveCorroborationCount(supportingSources),
    contradictions: [],
    identityEvidenceStrength: 60,
    relationshipEvidenceStrength: 60,
  });
  // ai_summary's own source-reliability tier keeps `artifact` well under the
  // inflated 100 the prior bug could reach off a claimed count of 5.
  assertEquals(axes.artifact < 100, true);
});
