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
