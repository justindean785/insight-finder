// Regression tests for compound-source confidence caps (confidence.ts).
//
// Root cause fixed here: applyEvidenceCaps mapped the single-token classifySource
// over WHOLE compound source strings ("breach_check+leakcheck+oathnet_lookup+…"),
// so multi-tool breach labels fell through to `unknown` (cap 50) unless the bare
// word " breach" happened to appear standalone. The fix classifies the whole
// label first and only splits into component tokens when the whole is unknown,
// then drops `unknown` when a real class is present.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCaps } from "./confidence.ts";

Deno.test("compound breach label classifies as breach-derived, not unknown", () => {
  // The exact seed-email source from the gmansexybeast@att.net trace.
  const r = applyEvidenceCaps({
    rawConfidence: 50,
    sources: ["breach_check+leakcheck+oathnet_lookup+deepfind_email_breach+serus_darkweb_scan"],
  });
  assert(r.source_classes.includes("breach"), `expected breach, got ${r.source_classes.join(",")}`);
  assert(!r.source_classes.includes("unknown"), "unknown must be dropped once breach is present");
  assert(r.cap >= 60, `breach cap expected >= 60, got ${r.cap}`);
  assert(!r.reason_for_confidence.includes("unknown"), r.reason_for_confidence);
});

Deno.test("source strings with / and + separators split correctly", () => {
  // whole-string is unknown (no standalone "breach"); split → breach_check + oathnet.
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["breach_check/snusbase+oathnet_lookup"] });
  assertEquals(r.source_classes, ["breach"]);
  assert(r.cap >= 60);
});

Deno.test("a truly unknown source still classifies as unknown (cap 50)", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["some_unknown_provider+another_mystery"] });
  assertEquals(r.source_classes, ["unknown"]);
  assertEquals(r.cap, 50);
  assertEquals(r.confidence, 50);
});

Deno.test("multiple breach sources preserve the breach cap/nudge behavior", () => {
  // Two distinct breach tools → the existing two-breach nudge (65).
  const two = applyEvidenceCaps({ rawConfidence: 90, sources: ["breach_check+oathnet_lookup"] });
  assertEquals(two.source_classes, ["breach"]);
  assertEquals(two.cap, 65);
  // A single breach tool stays at the base breach cap (60) — nudge boundary held.
  const one = applyEvidenceCaps({ rawConfidence: 90, sources: ["breach_check"] });
  assertEquals(one.cap, 60);
});

Deno.test("whole-string-first preserves shared-host downgrade (no split dilution)", () => {
  // "hackertarget/reverseiplookup" must stay infra_shared_host / 35 — splitting it
  // would leak hackertarget→infra_scan and dilute the shared-host downgrade.
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["hackertarget/reverseiplookup"] });
  assertEquals(r.source_classes, ["infra_shared_host"]);
  assertEquals(r.confidence, 35);
});

Deno.test("standalone-breach compound (address style) unchanged at breach cap 60", () => {
  // whole-string already matches the standalone word " breach" → no split needed.
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["snusbase/ATT breach+oathnet_lookup+property_records"] });
  assertEquals(r.source_classes, ["breach"]);
  assertEquals(r.cap, 60);
});

// ── #119: breach-metadata laundering guard ─────────────────────────────────
// Breach-derived PII whose SURFACE source is a generic/aggregator or public-record
// label — while the breach provenance lives only in metadata — must not launder up
// to a public_record cap. The guard reads breach signals from metadata, pushes a
// `breach` class, and drops `public_record` whenever `breach` is present.

Deno.test("#119: breach metadata demotes a public_record surface label (laundering blocked)", () => {
  // Surface source classifies as public_record (opencorporates_search, cap 75),
  // but the metadata reveals the evidence is actually breach-derived.
  const r = applyEvidenceCaps({
    rawConfidence: 95,
    sources: ["opencorporates_search"],
    metadata: { breach_count: 3, breach_names: ["fling.com"] },
  });
  assert(r.source_classes.includes("breach"), `expected breach, got ${r.source_classes.join(",")}`);
  assert(!r.source_classes.includes("public_record"), "public_record must be dropped when breach metadata is present");
  assert(r.cap <= 65, `breach-derived cap must be <=65, got ${r.cap}`);
  assert(r.confidence <= 65, `laundered confidence must be capped, got ${r.confidence}`);
});

Deno.test("#119: breach signal in metadata adds a breach class even with a generic source", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 95,
    sources: ["Multiple sources"], // generic wrapper label, no breach on the surface
    metadata: { breach_source: "leakcheck", data_classes: ["passwords"] },
  });
  // Provenance: a `breach` class is derived from metadata even though the surface
  // source names no breach tool. (The exact cap when an unrelated `unknown` class
  // also corroborates is pre-existing cross-class behaviour, out of this guard's scope.)
  assert(r.source_classes.includes("breach"), `expected breach from metadata, got ${r.source_classes.join(",")}`);
});

Deno.test("#119: slash/slug breach labels classify as breach, not public_record", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["username_sweep/breach_data"] });
  assert(r.source_classes.includes("breach"), `expected breach, got ${r.source_classes.join(",")}`);
  assert(!r.source_classes.includes("public_record"), "a mixed breach slug must not upgrade to public_record");
  assert(r.cap <= 65, `got ${r.cap}`);
});

Deno.test("#119: NO false demotion — public_record without breach metadata is unchanged", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 90,
    sources: ["census_geocode"], // → public_record, cap 75
    metadata: { note: "address exists in county records" },
  });
  assert(r.source_classes.includes("public_record"), `expected public_record, got ${r.source_classes.join(",")}`);
  assert(!r.source_classes.includes("breach"), "no breach signal → no breach class");
  assertEquals(r.cap, 75);
});
